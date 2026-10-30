// plainport compare (M2 Task 26; DESIGN.md "CLI design" → compare): every other head of a project, written into the
// project's own repository as the theirs refs (compare-refs.ts), so a conflict can be read with git before `resolve`:
// `git diff HEAD refs/plainport/theirs/<snapshot>/worktree`. The other heads are the catalog's live tips other than
// the snapshot this device's copy came from (its registry `base`).
//
// For each other head: restore it into a staging folder beside the project (`<parent>/.plainport-staging/<op>/tree`),
// unjournaled as `plainport restore` is (D60: a staging record first, so gc removes what a crash leaves), build its
// objects and publish its refs, then remove the staging folder through the guarded deleter (D87). Nothing else
// changes: no lease, no event, no registry entry; the project's index, branches, working tree and config stay as they
// are. A project that is not a git repository (or an other copy that holds none) gets no refs: compare refuses with
// the paths that differ instead (compare.not-git). `--clean` removes every ref under refs/plainport/theirs/ and
// nothing else.

import { dirname, join } from "node:path";
import {
  type Failure,
  type Finding,
  fail,
  finding,
  ok,
  type Phase,
  type Result,
  type StreamEvent,
  shellWord,
} from "@plainport/contract";
import { catalogReader } from "../catalog/head.ts";
import { resolveRootId } from "../catalog/roots.ts";
import { locationBug, storedHere } from "../catalog/stored.ts";
import type { ConfigLoader } from "../config/load.ts";
import { deleteGuard } from "../delete-guard.ts";
import type { Device } from "../device.ts";
import { removeEmptyHolder } from "../holder.ts";
import { assertSystemError, type LocalIo, systemErrorCode } from "../io.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { HostPorts } from "../ports/host.ts";
import type { StoreOpener } from "../ports/store.ts";
import { removeStagingRecord, writeStagingRecord } from "../recover/staging.ts";
import { readRegistry } from "../registry.ts";
import type { ProjectRef } from "../roots/address.ts";
import { dotGit } from "../scan/git.ts";
import { type ConfiguredStore, openStore } from "../store.ts";
import { readStub } from "../stub.ts";
import { ulid } from "../ulid.ts";
import {
  buildTheirs,
  type CompareGitContext,
  cleanTheirs,
  readTheirs,
  type TheirsListed,
  type TheirsSet,
} from "./compare-refs.ts";
import { writeFailed } from "./journaled.ts";
import { STAGING_DIR } from "./onload.ts";
import { nestedProjects, registeredFolders, withProjectLock } from "./project-gate.ts";
import { checkSnapshot, kindAt, restoreVerified, unreadable } from "./restore-tree.ts";

export interface CompareDeps {
  host: HostPorts;
  paths: PlainportPaths;
  device: Device;
  env: Env;
  loader: ConfigLoader;
  opener: StoreOpener;
  /** This device's event mirror for the store with this id (blob-fs's openEventMirror). */
  openMirror(storeId: string): Promise<Result<BlobStore>>;
  emit(event: StreamEvent): void;
  log(level: "debug" | "info" | "warn", message: string): void;
  /** Aborted by Ctrl-C: compare stops at its next safe point and removes its staging folder. */
  signal?: AbortSignal;
  now?: () => Date;
}

export interface CompareRequest {
  /** The resolved project; its folder must be on this device. */
  project: ProjectRef;
  /** --clean: remove every ref under refs/plainport/theirs/ instead. */
  clean?: boolean;
  /** --store: overrides the stub's, the root's and the default store. */
  store?: string;
}

export type CompareSet = TheirsSet & {
  /** The device that made the snapshot, and when. */
  device: string;
  at: string;
};

export type CompareOutcome = {
  op: string;
  /** root:path. */
  project: string;
  /** The project's folder, whose repository holds the refs. */
  dir: string;
  store?: string;
  /** The snapshot this copy came from. */
  base?: string;
  /** The sets written by this run, one per other head. */
  sets: CompareSet[];
  /** Why there was nothing to compare, when there was not. */
  nothing?: string;
  /** Sets still incomplete after this run (an earlier run's, of a snapshot not compared now): a rerun of it replaces
   * them, and --clean removes them. */
  incomplete: TheirsListed[];
  /** --clean: the refs removed. */
  removed?: string[];
};

const MAX_PATHS = 100;

/** Runs compare; see the file comment. A failure leaves no staging behind and no partial set published. */
export const runCompare = async (deps: CompareDeps, req: CompareRequest): Promise<Result<CompareOutcome>> => {
  const { host, paths, signal } = deps;
  const io: LocalIo = host;
  const clock = (): Date => deps.now?.() ?? host.clock.now();
  const ref = req.project;
  const op = ulid(clock().getTime());
  const phase = (name: Phase, status: "start" | "end") =>
    deps.emit({ type: "phase", op, phase: name, status });
  const report = (f: Finding) => deps.emit({ type: "finding", op, finding: f });
  const git: CompareGitContext = { host, env: deps.env, ...(signal === undefined ? {} : { signal }) };
  const cancelled = (): Failure =>
    fail(
      finding("operation.cancelled", {
        message: `compare of ${ref.address} was stopped; no set was left half published, and its staging was removed`,
        fix: `re-run plainport compare ${shellWord(ref.address)} when you are ready`,
      }),
    );

  phase("resolve", "start");
  const dir = ref.dir;
  let kind: string | undefined;
  if (dir !== undefined)
    try {
      kind = await kindAt(io, dir);
    } catch (error) {
      return unreadable(dir, error, "whether the project is here is unknown; nothing was compared");
    }
  if (dir === undefined || kind !== "dir") {
    return fail(
      finding("compare.not-local", {
        message: `${ref.address} has no working copy on this device${dir === undefined ? "" : ` (${dir} is not a folder)`}, so there is no repository to write the other copies into`,
        fix: `plainport restore ${shellWord(ref.address)} --snapshot <id> --to <path> reads any copy side by side; plainport status ${shellWord(ref.address)} lists its heads`,
        ...(dir === undefined ? {} : { paths: [dir] }),
      }),
    );
  }
  const repo = await dotGit(host, dir);
  if (!repo.ok) return repo;
  const registered = await readRegistry(io, paths);
  if (!registered.ok) return registered;
  const id =
    ref.id ??
    Object.entries(registered.value.projects).find(
      ([, e]) => e.root === ref.root && e.path === ref.path,
    )?.[0];
  const base = id === undefined ? undefined : registered.value.projects[id]?.base;

  // Projects nested with this one are locked too (D53); one that holds it would hold the staging folder beside it,
  // which the guarded deleter then refuses to remove, so compare refuses first.
  const folders = await registeredFolders(io, paths, deps.env);
  if (!folders.ok) return folders;
  const nested = await nestedProjects(io, paths, folders.value, {
    ...(id === undefined ? {} : { id }),
    folder: dir,
  });
  if (!nested.ok) return nested;
  const lockId = id ?? ulid(clock().getTime());
  const related = nested.value.filter((n) => n.id !== id);
  const gate = { io, paths, clock, log: deps.log };

  if (req.clean === true) {
    phase("resolve", "end");
    return withProjectLock(
      gate,
      { id: lockId, address: ref.address },
      async () => {
        if (repo.value === "none")
          return ok({ op, project: ref.address, dir, sets: [], incomplete: [], removed: [] });
        phase("commit", "start");
        const removed = await cleanTheirs(git, dir);
        if (!removed.ok) return removed;
        phase("commit", "end");
        return ok({ op, project: ref.address, dir, sets: [], incomplete: [], removed: removed.value });
      },
      { related },
    );
  }
  const holding = nested.value.find((n) => !n.inside && !n.same);
  if (holding !== undefined) {
    return fail(
      finding("project.nested", {
        message: `${ref.address}'s folder lies inside ${holding.address}'s folder (${holding.folder}), so a staging folder beside it would lie inside that project too; nothing was compared`,
        fix: `read the other copy side by side outside every registered project's folder: plainport restore ${shellWord(ref.address)} --snapshot <id> --to <path>`,
        paths: [dir],
      }),
    );
  }

  // The catalog: the project's live tips, and the snapshot this copy came from.
  const loaded = await deps.loader.load({ env: deps.env, root: ref.root });
  if (!loaded.ok) return loaded;
  const config = loaded.value.config;
  const stub = ref.stub === undefined ? undefined : await readStub(io, ref.stub);
  const storeName =
    req.store ??
    (stub?.ok ? stub.value.store : undefined) ??
    config.roots[ref.root]?.store ??
    config.defaultStore;
  if (storeName === undefined) {
    return fail(
      finding("store.not-set-up", {
        message: `root ${ref.root} names no store and no default store is set`,
        fix: "plainport init --store-path <path> --yes sets one up",
      }),
    );
  }
  const opened = await openStore(io, {
    paths,
    env: deps.env,
    name: storeName,
    config,
    opener: deps.opener,
    now: clock,
  });
  if (!opened.ok) return opened;
  const store: ConfiguredStore = opened.value;
  const mirror = await deps.openMirror(store.id);
  if (!mirror.ok) return mirror;
  const read = await catalogReader({
    store: store.blob,
    mirror: mirror.value,
    storeId: store.id,
    storeName: store.name,
    now: clock,
    ...(store.catalog === undefined ? {} : { policy: store.catalog }),
    report,
  })();
  if (!read.ok) return read;
  const rootId = resolveRootId(registered.value, read.value, ref.root)?.id;
  const projectId =
    id ?? Object.entries(read.value.projects).find(([, p]) => p.root === rootId && p.path === ref.path)?.[0];
  const project = projectId === undefined ? undefined : read.value.projects[projectId];
  const others = project === undefined ? [] : project.heads.filter((h) => h !== base).sort();
  phase("resolve", "end");

  const incompleteNow = async (): Promise<Result<TheirsListed[]>> => {
    if (repo.value === "none") return ok([]);
    const listed = await readTheirs(git, dir);
    return listed.ok ? ok(listed.value.filter((s) => !s.complete)) : listed;
  };
  if (project === undefined || others.length === 0) {
    const incomplete = await incompleteNow();
    if (!incomplete.ok) return incomplete;
    return ok({
      op,
      project: ref.address,
      dir,
      store: store.name,
      ...(base === undefined ? {} : { base }),
      sets: [],
      nothing:
        project === undefined
          ? `store ${store.name} holds no snapshot of ${ref.address}`
          : `${ref.address} has no other head: its only live tip is the snapshot this copy came from`,
      incomplete: incomplete.value,
    });
  }
  const proj = project;

  return withProjectLock(
    gate,
    { id: projectId ?? lockId, address: ref.address },
    async () => {
      const sets: CompareSet[] = [];
      const differing: { snapshot: string; paths: string[]; total: number; why: string }[] = [];
      for (const snapshot of others) {
        if (signal?.aborted) return cancelled();
        const made = proj.snapshots[snapshot];
        if (made === undefined) continue;
        const stored = storedHere(made.stored);
        if (stored === undefined) return locationBug(store.name, snapshot, ref.address);
        const each = await compareOne(snapshot, stored, made.event, made.at);
        if (!each.ok) return each;
        if (each.value.kind === "set") sets.push({ ...each.value.set, device: made.device, at: made.at });
        else differing.push({ snapshot, ...each.value });
      }
      if (differing.length > 0) {
        const paths = differing.flatMap((d) => d.paths).slice(0, MAX_PATHS);
        return fail(
          finding("compare.not-git", {
            message: `${differing.map((d) => `${d.why}, so no refs were written for snapshot ${d.snapshot}; ${d.total} path${d.total === 1 ? "" : "s"} differ from it`).join("; ")}${paths.length > 0 ? `: ${paths.slice(0, 10).join(", ")}${paths.length > 10 ? ", …" : ""}` : ""}`,
            fix: `read the other copy side by side: plainport restore ${shellWord(ref.address)} --snapshot ${differing[0]?.snapshot} --to <path>`,
            paths,
          }),
        );
      }
      const incomplete = await incompleteNow();
      if (!incomplete.ok) return incomplete;
      return ok({
        op,
        project: ref.address,
        dir,
        store: store.name,
        ...(base === undefined ? {} : { base }),
        sets,
        incomplete: incomplete.value,
      });
    },
    { related },
  );

  /** One head: restored into its own staging folder, compared, and the folder removed whatever happened. */
  async function compareOne(
    snapshot: string,
    stored: string,
    event: string,
    at: string,
  ): Promise<
    Result<{ kind: "set"; set: TheirsSet } | { kind: "paths"; paths: string[]; total: number; why: string }>
  > {
    const each = ulid(clock().getTime());
    const parent = dirname(dir as string);
    const holder = join(parent, STAGING_DIR);
    const staging = join(holder, each);
    // The record, before the folder: gc removes a crashed compare's staging once nobody holds this lock (D60).
    try {
      await writeStagingRecord(io, paths, {
        v: 1,
        op: each,
        project: { id: (projectId ?? lockId) as string, address: ref.address },
        staging,
      });
      await io.fs.mkdirp(holder);
    } catch (error) {
      return writeFailed(error, `making ${holder}`, false, holder);
    }
    try {
      return await restoreAndBuild(snapshot, stored, event, at, parent, holder, staging);
    } finally {
      const guarded = await deleteGuard({ io, paths, env: deps.env }, staging);
      if (!guarded.ok) deps.log("warn", `${staging} was kept: ${guarded.finding.message}`);
      else
        try {
          await io.fs.removeTree(staging);
          await removeEmptyHolder(io, holder, STAGING_DIR);
          await removeStagingRecord(io, paths, each);
        } catch (error) {
          assertSystemError(error);
          deps.log(
            "warn",
            `${staging} could not be removed; it holds only a copy of a snapshot, and plainport gc removes it`,
          );
        }
    }
  }

  async function restoreAndBuild(
    snapshot: string,
    stored: string,
    event: string,
    at: string,
    parent: string,
    holder: string,
    staging: string,
  ): Promise<
    Result<{ kind: "set"; set: TheirsSet } | { kind: "paths"; paths: string[]; total: number; why: string }>
  > {
    const tree = join(staging, "tree");
    const ctx = {
      op,
      ...(signal === undefined ? {} : { signal }),
      emit: (
        e: StreamEvent | { type: "log"; op: string; level: "debug" | "info" | "warn"; message: string },
      ) => (e.type === "log" ? deps.log(e.level, e.message) : deps.emit(e)),
    };
    phase("preflight", "start");
    const listed = await checkSnapshot({
      io,
      engine: store.engine,
      store: store.blob,
      ...(store.catalog === undefined ? {} : { catalog: store.catalog }),
      stored,
      event,
      ctx,
      op,
      nearest: parent,
      holder,
      resuming: false,
      address: ref.address,
      elsewhere: `plainport restore ${shellWord(ref.address)} --snapshot ${snapshot} --to <path>`,
      dependencies: false,
    });
    if (!listed.ok) return signal?.aborted ? cancelled() : listed;
    phase("preflight", "end");
    if (signal?.aborted) return cancelled();
    const restored = await restoreVerified({
      io,
      engine: store.engine,
      stored,
      staging: tree,
      ctx,
      phase,
      step: async () => ok(undefined),
      stopped: () => signal?.aborted === true,
      cancelled,
      fix: `nothing was written into ${dir}; re-run plainport compare, and if it fails again run restic check on the store`,
    });
    if (!restored.ok) return restored;
    if (signal?.aborted) return cancelled();
    const theirs = await dotGit(host, tree);
    if (!theirs.ok) return theirs;
    if (repo.ok && repo.value !== "none" && theirs.value === "dir") {
      phase("commit", "start");
      const built = await buildTheirs(git, {
        repo: dir as string,
        theirs: tree,
        snapshot,
        at,
        index: join(staging, "index"),
      });
      if (!built.ok) return built;
      phase("commit", "end");
      return ok({ kind: "set", set: built.value });
    }
    const why =
      repo.ok && repo.value === "none"
        ? `${dir} is not a git repository`
        : `the copy in snapshot ${snapshot} holds no git repository of its own (its .git is ${theirs.value === "file" ? "a pointer to another machine's repository" : "missing"})`;
    const found = await differingPaths(io, dir as string, tree);
    if (!found.ok) return found;
    return ok({
      kind: "paths",
      paths: found.value.slice(0, MAX_PATHS).map((p) => join(dir as string, p)),
      total: found.value.length,
      why,
    });
  }
};

/**
 * The paths that differ between two trees, relative and sorted: in only one of them (a folder in only one as `dir/`,
 * not walked), of another kind, or with other bytes or another link target. Nothing is followed through a link.
 */
export const differingPaths = async (
  io: LocalIo,
  ours: string,
  theirs: string,
): Promise<Result<string[]>> => {
  const out: string[] = [];
  const names = async (dir: string): Promise<Map<string, string>> => {
    try {
      return new Map((await io.fs.entries(dir)).map((e) => [e.name, e.kind]));
    } catch (error) {
      if (systemErrorCode(error) === "ENOENT") return new Map();
      throw error;
    }
  };
  const visit = async (relative: string): Promise<void> => {
    const mine = await names(relative === "" ? ours : join(ours, relative));
    const yours = await names(relative === "" ? theirs : join(theirs, relative));
    for (const name of [...new Set([...mine.keys(), ...yours.keys()])].sort()) {
      const path = relative === "" ? name : `${relative}/${name}`;
      const a = mine.get(name);
      const b = yours.get(name);
      if (a === undefined || b === undefined || a !== b) {
        out.push((a ?? b) === "dir" ? `${path}/` : path);
        continue;
      }
      if (a === "dir") await visit(path);
      else if (a === "symlink") {
        if ((await io.fs.readlink(join(ours, path))) !== (await io.fs.readlink(join(theirs, path))))
          out.push(path);
      } else if (a === "file") {
        const [x, y] = [await io.fs.lstat(join(ours, path)), await io.fs.lstat(join(theirs, path))];
        if (x.size !== y.size) out.push(path);
        else {
          const [p, q] = [await io.fs.readBytes(join(ours, path)), await io.fs.readBytes(join(theirs, path))];
          if (!Buffer.from(p).equals(Buffer.from(q))) out.push(path);
        }
      }
    }
  };
  try {
    await visit("");
  } catch (error) {
    return unreadable(ours, error, "the paths that differ are unknown");
  }
  return ok(out.sort());
};
