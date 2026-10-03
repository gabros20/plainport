// The offload saga (ADR-0008; DESIGN.md "Offload process", "Project lifecycle"): resolve and lock, preflight, scan,
// plan, snapshot, verify, commit, release. The project folder is touched only in release, after the snapshot has been
// verified against the scan and the offloaded event is on the store; release renames the folder into
// `<root>/.plainport-trash/<op>/`, writes the stub where it stood, and leaves the deletion to a detached process.
//
// The journal (journal/<op>.json) is written at every step in OFFLOAD_STEPS, and each step then calls the host's
// crash seam, faultAt(step), so the crash matrix can stop the saga at any of them. What each step leaves for
// `plainport recover` (Task 14) when the process dies there:
//
//   offload.begin, offload.planned         nothing is uploaded yet: roll back (remove the journal)
//   offload.snapshot.start                 restic may have written a snapshot nothing names: roll back
//   offload.snapshot.discarded             restic's incomplete snapshot (exit 3) is journaled: write its
//                                          snapshot-discarded event if the store lacks it, then roll back (D28)
//   offload.snapshot.done, offload.verified  a snapshot nothing names yet: roll back
//   offload.commit.start                   the offloaded event's id is journaled: if the store holds it, finish
//                                          release; if not, roll back (a lost write never deletes a folder, D24)
//   offload.committed .. release.stub      committed: finish release (rename, stub, registry, delete)
//   offload.release.delete                 released: delete the trash once keepUntil (if any) has passed
//
// A saga that ends on its own, success or expected failure, leaves nothing open: on a failure before the commit
// nothing local has changed, so it removes its journal; on success the detached deleter removes the trash and then
// the journal. Ctrl-C (the signal) is honoured at the safe points before the commit (between phases, and inside
// restic, which it stops); after the commit the saga finishes release, which only renames and writes small files.
//
// An injected fault (InjectedFault) is a simulated crash: nothing here catches it.

import { basename, dirname, join } from "node:path";
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
import { writeAtomic } from "../atomic.ts";
import type { CatalogEvent } from "../catalog/events.ts";
import type { CatalogState } from "../catalog/fold.ts";
import { appendEvent, loadCatalog, storeEventLog } from "../catalog/log.ts";
import { resolveRootId } from "../catalog/roots.ts";
import type { ConfigLoader } from "../config/load.ts";
import type { Device } from "../device.ts";
import { type LocalIo, systemErrorCode } from "../io.ts";
import {
  journalFile,
  type OffloadJournal,
  readJournals,
  removeJournal,
  writeJournal,
} from "../journal/index.ts";
import { acquireLock, type LockHolder } from "../lock.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import { prepareOffload } from "../plan/planner.ts";
import type { Plan } from "../plan/schema.ts";
import { readPlan, savePlan } from "../plan/store.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { HostChecks } from "../ports/checks.ts";
import type { EcosystemPlugin } from "../ports/ecosystem.ts";
import type { RunContext } from "../ports/engine.ts";
import type { HostPorts } from "../ports/host.ts";
import type { StoreOpener } from "../ports/store.ts";
import { updateRegistry } from "../registry.ts";
import type { ProjectRef } from "../roots/address.ts";
import { scanTree, type TreeScan } from "../scan/walk.ts";
import { type ConfiguredStore, openStore } from "../store.ts";
import { STUB_SUFFIX, type Stub, StubSchema } from "../stub.ts";
import { ulid } from "../ulid.ts";
import { isExcluded, verifyListing } from "./verify.ts";

/**
 * Every journal step, in the order a run reaches them; the crash matrix enumerates its rows from this list.
 * snapshot.start and snapshot.done are reached twice when an edit during the upload makes the snapshot retry;
 * snapshot.discarded only when restic could not read a file (exit 3).
 */
export const OFFLOAD_STEPS = [
  "offload.begin",
  "offload.planned",
  "offload.snapshot.start",
  "offload.snapshot.discarded",
  "offload.snapshot.done",
  "offload.verified",
  "offload.commit.start",
  "offload.committed",
  "offload.release.trash",
  "offload.release.moved",
  "offload.release.stub",
  "offload.release.delete",
] as const;
export type OffloadStep = (typeof OFFLOAD_STEPS)[number];

/** Steps after which the operation is finished but for deleting its trash: they hold no project back. */
const RELEASED: ReadonlySet<string> = new Set<OffloadStep>(["offload.release.delete"]);

/** Snapshots per offload: the first, and one retry when files changed during the upload. */
const ATTEMPTS = 2;

export const TRASH_DIR = ".plainport-trash";

export interface OffloadDeps {
  host: HostPorts;
  checks: HostChecks;
  plugins: readonly EcosystemPlugin[];
  paths: PlainportPaths;
  /** This device. */
  device: Device;
  /** The environment: config variables, the store's password reference, what git and the checks are given. */
  env: Env;
  loader: ConfigLoader;
  opener: StoreOpener;
  /** This device's event mirror for the store with this id (blob-fs's openEventMirror). */
  openMirror(storeId: string): Promise<Result<BlobStore>>;
  /** Phase, progress and finding events. */
  emit(event: StreamEvent): void;
  log(level: "debug" | "info" | "warn", message: string): void;
  /** Aborted by Ctrl-C: the saga stops at its next safe point before the commit. */
  signal?: AbortSignal;
}

export interface OffloadRequest {
  /** The resolved project; it must have a folder on this device. */
  project: ProjectRef;
  /** An approved plan's id (--plan): its fingerprint must still match the folder. */
  plan?: string;
  /** --allow: allowable blockers to override, by code. */
  allow?: readonly string[];
  /** --keep-deps. */
  keepDeps?: boolean;
  /** --store: overrides the root's store and the default one. */
  store?: string;
}

export interface OffloadOutcome {
  op: string;
  /** root:path. */
  project: string;
  /** The plainport snapshot id: the operation's ULID. */
  snapshot: string;
  store: string;
  /** Every byte the folder held, stripped paths included. */
  freedBytes: number;
  /** Absent when config says stub = false. */
  stub?: string;
  /** Where the folder waits to be deleted. */
  trash: string;
  /** keepLocalFor: the trash is kept until then. */
  keepUntil?: string;
}

/** "0", or a whole number with a unit (DurationSchema), in milliseconds. */
export const durationMs = (duration: string): number => {
  const match = /^(\d+)([smhdw])?$/.exec(duration);
  if (match === null) throw new RangeError(`not a duration: ${duration}`);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] ?? "s"] ?? 1_000;
  return Number(match[1]) * unit;
};

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

const cancelled = (): Failure =>
  fail(
    finding("operation.cancelled", {
      message: "the offload was stopped before it changed anything local; the folder is as it was",
      fix: "re-run the offload when you are ready",
    }),
  );

const lockHeld = (address: string) => (holder: LockHolder | undefined, path: string, ours: boolean) =>
  finding("project.locked", {
    message: ours
      ? `this process is already working on ${address}`
      : `${address} is locked by ${
          holder === undefined
            ? "an unreadable lock file"
            : `plainport process ${holder.pid} on ${holder.host}, started ${holder.startedAt}`
        }`,
    fix:
      ours || holder !== undefined
        ? "wait for the other plainport run to finish, then re-run"
        : `delete ${path} if no plainport is running, then re-run`,
    paths: [path],
  });

/** Where the project's root holds its trash: the root's folder, or the folder's parent for a one-off location. */
const rootFolderOf = (ref: ProjectRef, dir: string): string =>
  dir.endsWith(`/${ref.path}`) ? dir.slice(0, -(ref.path.length + 1)) : dirname(dir);

/** The catalog's view of the head this working copy should offload on top of; a refusal when it is not that. */
const headCheck = (
  state: CatalogState,
  id: string,
  base: string | undefined,
  address: string,
): { kind: "ok" } | { kind: "moved" | "incomplete"; finding: Finding } => {
  const project = state.projects[id];
  const kept = project !== undefined && (project.heads.length > 0 || project.conflicts.length > 0);
  if (project !== undefined && project.missing.length > 0) {
    return {
      kind: "incomplete",
      finding: finding("catalog.incomplete", {
        message: `the catalog names ${plural(project.missing.length, "snapshot")} of ${address} it does not hold (${project.missing.join(", ")}), so its head is unknown; nothing was offloaded`,
        fix: "connect the store that holds them, or run plainport doctor",
      }),
    };
  }
  if (!kept) {
    if (base === undefined) return { kind: "ok" };
    return {
      kind: "incomplete",
      finding: finding("catalog.incomplete", {
        message: `this copy of ${address} came from snapshot ${base}, which the store's catalog does not hold`,
        fix: "check that the root's store is the one the project was onloaded from, or run plainport doctor",
      }),
    };
  }
  const moved = (detail: string) => ({
    kind: "moved" as const,
    finding: finding("catalog.head-moved", {
      message: `${address} ${detail}; nothing local was deleted`,
      fix: `plainport resolve ${shellWord(address)} settles which copy wins (M2); until then keep this folder`,
    }),
  });
  if (project.conflicts.length > 0 || project.head === null) return moved("is conflicted in the catalog");
  if (project.head !== base)
    return moved(
      `was offloaded from another copy since this one was made: the head is ${project.head}, this copy came from ${base ?? "no snapshot"}`,
    );
  return { kind: "ok" };
};

/** Runs the offload; see the file comment. A failure before the commit changed nothing local. */
export const runOffload = async (deps: OffloadDeps, req: OffloadRequest): Promise<Result<OffloadOutcome>> => {
  const { host, paths, device, signal } = deps;
  const io: LocalIo = host;
  const ref = req.project;
  const op = ulid(host.clock.now().getTime());
  const phase = (name: Phase, status: "start" | "end") =>
    deps.emit({ type: "phase", op, phase: name, status });
  const report = (f: Finding) => deps.emit({ type: "finding", op, finding: f });

  phase("resolve", "start");
  const dir = ref.dir;
  const notHere = (detail: string, shelved = ref.stub !== undefined) =>
    fail(
      finding("project.not-found", {
        message: `${ref.address} ${detail}, so there is nothing here to offload`,
        fix: shelved
          ? `it is shelved: plainport onload ${shellWord(ref.address)} brings it back`
          : `plainport root bind ${ref.root} <path> if the root lives elsewhere on this device`,
      }),
    );
  if (dir === undefined) return notHere("has no folder on this device");
  try {
    const kind = (await io.fs.lstat(dir)).kind;
    if (kind === "symlink") return notHere(`is a symlink at ${dir}; offload the folder it points to`);
    if (kind !== "dir") return notHere(`is not a folder at ${dir}`);
  } catch (error) {
    if (systemErrorCode(error) !== "ENOENT") throw error;
    // ProjectRef's match "address" (or a stub) means the folder was never checked: it is simply not here.
    const stub = await io.fs.lstat(`${dir}${STUB_SUFFIX}`).then(
      () => true,
      (e: unknown) => (systemErrorCode(e) === "ENOENT" ? false : Promise.reject(e)),
    );
    return notHere(
      stub ? `is shelved (its stub is at ${dir}${STUB_SUFFIX})` : `has no folder at ${dir}`,
      stub,
    );
  }

  const loaded = await deps.loader.load({ env: deps.env, root: ref.root });
  if (!loaded.ok) return loaded;
  const storeName =
    req.store ?? loaded.value.config.roots[ref.root]?.store ?? loaded.value.config.defaultStore;
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
    config: loaded.value.config,
    opener: deps.opener,
  });
  if (!opened.ok) return opened;
  const store: ConfiguredStore = opened.value;

  // The project's ULID: the registry's, or a new one recorded there, under its lock, so two runs agree on it.
  let id = ref.id;
  const registered = await updateRegistry(io, paths, (registry) => {
    const entry =
      id === undefined
        ? Object.entries(registry.projects).find(([, e]) => e.root === ref.root && e.path === ref.path)
        : undefined;
    if (entry !== undefined) id = entry[0];
    if (id !== undefined && registry.projects[id] !== undefined) return ok(registry);
    id ??= ulid(host.clock.now().getTime());
    const registeredAt = host.clock.now().toISOString();
    return ok({
      ...registry,
      projects: { ...registry.projects, [id]: { root: ref.root, path: ref.path, registeredAt } },
    });
  });
  if (!registered.ok) return registered;
  const projectId = id as string;
  const registry = registered.value;
  const base = registry.projects[projectId]?.base;

  const lock = await acquireLock(io, join(paths.locksDir, `${projectId}.lock`), {
    timeoutMs: 0,
    held: lockHeld(ref.address),
    now: () => host.clock.now(),
  });
  if (!lock.ok) return lock;
  try {
    return await locked();
  } finally {
    await lock.value.release();
  }

  async function locked(): Promise<Result<OffloadOutcome>> {
    const open = (await readJournals(io, paths)).journals.find(
      (j) => j.project.id === projectId && !RELEASED.has(j.step),
    );
    if (open !== undefined) {
      return fail(
        finding("journal.pending", {
          message: `an offload of ${ref.address} (${open.op}) was interrupted at ${open.step}; nothing new was started`,
          fix: "plainport recover finishes or rolls it back, then re-run",
          paths: [journalFile(paths, open.op)],
        }),
      );
    }

    const mirror = await deps.openMirror(store.id);
    if (!mirror.ok) return mirror;
    const catalog = async (): Promise<Result<CatalogState>> => {
      const read = await loadCatalog({
        store: store.blob,
        mirror: mirror.value,
        storeId: store.id,
        now: host.clock.now(),
      });
      if (!read.ok) return read;
      if (read.value.stale)
        return fail(
          read.value.unreachable ??
            finding("store.unreachable", { message: `store ${store.name} could not be reached` }),
        );
      for (const f of read.value.findings) report(f);
      return ok(read.value.state);
    };
    const before = await catalog();
    if (!before.ok) return before;
    const early = headCheck(before.value, projectId, base, ref.address);
    if (early.kind !== "ok") return fail(early.finding);

    const rootFolder = rootFolderOf(ref, dir as string);
    const [here, beside] = await Promise.all([io.fs.stat(dir as string), io.fs.stat(rootFolder)]);
    if (here.dev !== beside.dev) {
      return fail(
        finding("fs.cross-volume", {
          message: `${dir} is a separate volume from ${rootFolder}, so it cannot be moved aside into ${join(rootFolder, TRASH_DIR)} in one rename`,
          fix: "offload a folder that lives on its root's own volume",
          paths: [dir as string],
        }),
      );
    }

    const knownRoot = resolveRootId(registry, before.value, ref.root);
    const rootId = knownRoot?.id ?? ulid(host.clock.now().getTime());
    const startedAt = host.clock.now().toISOString();
    const journal: OffloadJournal = {
      v: 1,
      op,
      kind: "offload",
      step: "offload.begin",
      startedAt,
      updatedAt: startedAt,
      pid: io.proc.pid,
      host: io.proc.hostname(),
      project: {
        id: projectId,
        address: ref.address,
        root: ref.root,
        rootId,
        path: ref.path,
        dir: dir as string,
      },
      store: { name: store.name, id: store.id },
      ...(base === undefined ? {} : { base }),
      attempts: [],
      history: [],
    };
    let journaled = false;
    const step = async (name: OffloadStep, change: Partial<OffloadJournal> = {}) => {
      const at = host.clock.now().toISOString();
      Object.assign(journal, change, { step: name, updatedAt: at });
      journal.history.push({ step: name, at });
      await writeJournal(io, paths, journal);
      journaled = true;
      host.faultAt(name);
    };
    /** Ends a run that failed before the commit: nothing local changed, so nothing is left to recover. */
    const abandon = async (failure: Failure): Promise<Failure> => {
      if (journaled) await removeJournal(io, paths, op);
      return failure;
    };
    const now = () => host.clock.now().toISOString();
    const events = storeEventLog(store.blob);

    await step(
      "offload.begin",
      knownRoot === undefined ? { rootCreated: ulid(host.clock.now().getTime()) } : {},
    );
    if (journal.rootCreated !== undefined) {
      const created = await appendEvent(events, {
        v: 1,
        id: journal.rootCreated,
        type: "root-created",
        device: device.id,
        at: now(),
        op,
        root: rootId,
        key: ref.root,
      });
      if (!created.ok) return abandon(created);
      const recorded = await updateRegistry(io, paths, (current) =>
        ok({ ...current, roots: { ...current.roots, [ref.root]: current.roots?.[ref.root] ?? rootId } }),
      );
      if (!recorded.ok) return abandon(recorded);
    }
    phase("resolve", "end");
    if (signal?.aborted) return abandon(cancelled());

    // Preflight, scan and plan: an approved plan counts only while the folder still matches it (D36, D38).
    phase("preflight", "start");
    let approved: Plan | undefined;
    if (req.plan !== undefined) {
      const read = await readPlan(io, paths, req.plan, host.clock.now());
      if (!read.ok) return abandon(read);
      approved = read.value;
      if (approved.kind !== "offload" || approved.project?.dir !== dir) {
        return abandon(
          fail(
            finding("plan.stale", {
              message: `plan ${approved.id} is for ${approved.kind} ${approved.project?.address ?? "another project"}, not for offloading ${ref.address}`,
              fix: `plainport offload ${shellWord(ref.address)} --dry-run plans this offload`,
            }),
          ),
        );
      }
      const blocked = approved.findings.find((f) => f.severity === "block");
      if (blocked !== undefined) return abandon(fail(blocked));
    }
    const prepared = await prepareOffload(host, deps.checks, deps.plugins, {
      dir: dir as string,
      project: { address: ref.address, root: ref.root, path: ref.path, id: projectId },
      loader: deps.loader,
      env: deps.env,
      now: host.clock.now(),
      store: store.name,
      ...(req.keepDeps === true ? { keepDeps: true } : {}),
      ...(signal === undefined ? {} : { signal }),
      onFinding: report,
    });
    if (!prepared.ok) return abandon(signal?.aborted ? cancelled() : prepared);
    const { plan, config } = prepared.value;
    phase("preflight", "end");
    phase("scan", "start");
    phase("scan", "end");
    phase("plan", "start");
    for (const f of plan.findings) report(f);
    if (approved !== undefined && approved.fingerprint !== plan.fingerprint) {
      const blocked = plan.findings.some((f) => f.severity === "block");
      let saved = !blocked;
      if (saved) {
        try {
          await savePlan(io, paths, plan, host.clock.now());
        } catch (error) {
          systemErrorCode(error);
          saved = false;
        }
      }
      return abandon(
        fail(
          finding("plan.stale", {
            message: `the folder changed since plan ${approved.id} was made; nothing was uploaded`,
            fix: saved
              ? `review the fresh plan with plainport offload ${shellWord(ref.address)} --dry-run, then approve it: plainport offload ${shellWord(ref.address)} --plan ${plan.id}`
              : `plainport offload ${shellWord(ref.address)} --dry-run, fix what it reports, then approve the new plan`,
          }),
        ),
      );
    }
    const allow = new Set(req.allow ?? []);
    for (const code of allow) {
      const f = plan.findings.find((x) => x.code === code);
      if (f !== undefined && f.severity === "block" && !f.allowable)
        deps.log("warn", `--allow ${code} has no effect: ${code} cannot be allowed`);
    }
    const blockers = plan.findings.filter(
      (f) => f.severity === "block" && !(f.allowable && allow.has(f.code)),
    );
    const [blocker] = blockers;
    if (blocker !== undefined) return abandon(fail(blocker));
    phase("plan", "end");
    await step("offload.planned", { plan: { id: plan.id, fingerprint: plan.fingerprint } });
    if (signal?.aborted) return abandon(cancelled());

    // Snapshot, then verify: re-stat the folder, and compare the snapshot's listing with the scan it was made from.
    for (const pid of prepared.value.fsmonitor) {
      const stopped = await host.run({
        command: "git",
        args: ["fsmonitor--daemon", "stop"],
        cwd: dir as string,
        env: { PATH: deps.env.PATH ?? "/usr/bin:/bin", HOME: deps.env.HOME ?? paths.home },
        timeoutMs: 30_000,
      });
      deps.log(
        stopped.ok && stopped.value.exitCode === 0 ? "info" : "warn",
        `git fsmonitor daemon ${pid}: ${stopped.ok && stopped.value.exitCode === 0 ? "stopped" : "could not be stopped"}`,
      );
    }
    const strip = plan.strip.map((s) => s.path);
    const strippedBytes = plan.strip.reduce((sum, s) => sum + s.bytes, 0);
    const parent =
      base === undefined ? undefined : before.value.projects[projectId]?.snapshots[base]?.stored[store.name];
    const tags = [
      "plainport",
      `plainport:project=${projectId}`,
      `plainport:root=${rootId}`,
      `plainport:path=${ref.path}`,
      `plainport:op=${op}`,
      "plainport:kind=offload",
    ];
    const ctx: RunContext = {
      op,
      ...(signal === undefined ? {} : { signal }),
      emit: (e) => (e.type === "log" ? deps.log(e.level, e.message) : deps.emit(e)),
    };
    let baseline: TreeScan = prepared.value.tree;
    let previous = parent;
    let verified: { snapshot: string; files: number; bytes: number } | undefined;
    for (let attempt = 1; verified === undefined; attempt++) {
      const excluded = new Set(strip);
      for (const s of baseline.skipped) if (!isExcluded(excluded, s.path)) excluded.add(s.path);
      phase("snapshot", "start");
      await step("offload.snapshot.start");
      const made = await store.engine.snapshot(
        {
          dir: dir as string,
          excludes: [...excluded].sort(),
          ...(previous === undefined ? {} : { parent: previous }),
          tags,
        },
        ctx,
      );
      if (!made.ok) {
        if (made.incomplete !== undefined) {
          // restic wrote a snapshot although it could not read everything (exit 3, D28): name it as discarded.
          const discarded = { snapshot: made.incomplete.snapshot, event: ulid(host.clock.now().getTime()) };
          await step("offload.snapshot.discarded", {
            attempts: [...journal.attempts, discarded.snapshot],
            discarded,
          });
          const written = await appendEvent(events, {
            v: 1,
            id: discarded.event,
            type: "snapshot-discarded",
            device: device.id,
            at: now(),
            op,
            project: projectId,
            root: rootId,
            path: ref.path,
            snapshot: op,
            stored: { [store.name]: discarded.snapshot },
          });
          // Unwritten, it stays journaled for recover to write.
          if (!written.ok) {
            deps.log("warn", `the discarded snapshot could not be recorded yet: ${written.finding.message}`);
            return made;
          }
        }
        return abandon(signal?.aborted ? cancelled() : made);
      }
      await step("offload.snapshot.done", { attempts: [...journal.attempts, made.value.id] });
      phase("snapshot", "end");

      phase("verify", "start");
      const after = await scanTree(io.fs, dir as string);
      if (!after.ok) return abandon(after);
      if (after.value.unreadable.length > 0) {
        return abandon(
          fail(
            finding("fs.unreadable", {
              message: `${plural(after.value.unreadable.length, "path")} in ${dir} became unreadable during the snapshot: ${after.value.unreadable.slice(0, 5).join(", ")}`,
              paths: after.value.unreadable.slice(0, 100),
              fix: "make them readable (chmod u+r), then re-run",
            }),
          ),
        );
      }
      if (after.value.fingerprint !== baseline.fingerprint) {
        if (attempt >= ATTEMPTS) {
          return abandon(
            fail(
              finding("verify.changed", {
                message: `files in ${ref.address} changed while the snapshot was made, twice; nothing local was deleted`,
                fix: "stop whatever is writing to the folder (a dev server, a watcher, an agent), then re-run",
                paths: [dir as string],
              }),
            ),
          );
        }
        deps.log("info", `files in ${ref.address} changed while the snapshot was made; taking it again`);
        phase("verify", "end");
        baseline = after.value;
        previous = made.value.id;
        if (signal?.aborted) return abandon(cancelled());
        continue;
      }
      const checked = await verifyListing({
        engine: store.engine,
        fs: io.fs,
        snapshot: made.value.id,
        dir: dir as string,
        manifest: baseline.manifest,
        excluded,
        ctx,
      });
      if (!checked.ok) return abandon(signal?.aborted ? cancelled() : checked);
      verified = { snapshot: made.value.id, ...checked.value };
    }
    await step("offload.verified", { verified: verified.snapshot });
    phase("verify", "end");
    if (signal?.aborted) return abandon(cancelled());

    // Commit: the head must still be what this copy came from; the offloaded event closes the lease.
    phase("commit", "start");
    const current = await catalog();
    if (!current.ok) return abandon(current);
    const head = headCheck(current.value, projectId, base, ref.address);
    if (head.kind === "incomplete") return abandon(fail(head.finding));
    const event: CatalogEvent = {
      v: 1,
      id: ulid(host.clock.now().getTime()),
      type: "offloaded",
      device: device.id,
      at: now(),
      op,
      project: projectId,
      root: rootId,
      path: ref.path,
      ...(base === undefined ? {} : { base }),
      snapshot: op,
      stored: { [store.name]: verified.snapshot },
      stats: {
        files: verified.files,
        bytes: verified.bytes,
        strippedBytes,
        ecosystems: prepared.value.ecosystems,
      },
    };
    await step("offload.commit.start", { event: event.id });
    const committed = await appendEvent(events, event);
    // Whether a failed append landed is unknown: the journal stays for recover to look (D24).
    if (!committed.ok) return committed;
    await step("offload.committed");
    if (head.kind === "moved") {
      // Another copy moved the head: the snapshot is kept as a fork, and this folder stays (DESIGN "Conflict").
      await removeJournal(io, paths, op);
      return fail(head.finding);
    }
    phase("commit", "end");

    // Release: the only step that touches the folder.
    phase("release", "start");
    const trash = join(rootFolder, TRASH_DIR, op);
    await step("offload.release.trash", { trash });
    await io.fs.mkdirp(trash);
    await io.fs.rename(dir as string, join(trash, basename(dir as string)));
    await io.fs.syncDir(trash);
    await io.fs.syncDir(dirname(dir as string));
    await step("offload.release.moved");

    let stubPath: string | undefined;
    if (config.offload.stub) {
      stubPath = `${dir}${STUB_SUFFIX}`;
      const stub: Stub = StubSchema.parse({
        plainport: 1,
        project: projectId,
        root: ref.root,
        rootId,
        path: ref.path,
        store: store.name,
        snapshot: op,
        offloadedAt: event.at,
        bytes: verified.bytes,
        restore: `plainport onload ${shellWord(ref.address)}`,
      });
      await writeAtomic(io, stubPath, `${JSON.stringify(stub, null, 2)}\n`);
    }
    const updated = await updateRegistry(io, paths, (registry) => {
      const entry = registry.projects[projectId];
      if (entry === undefined) return ok(registry);
      const { onloadedAt: _, ...rest } = entry;
      return ok({ ...registry, projects: { ...registry.projects, [projectId]: { ...rest, base: op } } });
    });
    if (!updated.ok) deps.log("warn", `registry.json was not updated: ${updated.finding.message}`);
    await step("offload.release.stub", stubPath === undefined ? {} : { stub: stubPath });

    const keepMs = durationMs(config.offload.keepLocalFor);
    const keepUntil = keepMs > 0 ? new Date(host.clock.now().getTime() + keepMs).toISOString() : undefined;
    await step("offload.release.delete", keepUntil === undefined ? {} : { keepUntil });
    if (keepUntil === undefined) {
      // Deletes the trash, then the journal, after this command has returned; recover repeats it if it never runs.
      const started = await host.detach({
        command: "/bin/sh",
        args: [
          "-c",
          'chmod -R u+w -- "$1" 2>/dev/null; rm -rf -- "$1" && rm -f -- "$2"',
          "plainport-trash",
          trash,
          journalFile(paths, op),
        ],
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
      });
      if (!started.ok)
        deps.log(
          "warn",
          `the trash ${trash} is not being deleted yet (${started.finding.message}); plainport recover deletes it`,
        );
    }
    phase("release", "end");
    return ok({
      op,
      project: ref.address,
      snapshot: op,
      store: store.name,
      freedBytes: baseline.bytes,
      ...(stubPath === undefined ? {} : { stub: stubPath }),
      trash,
      ...(keepUntil === undefined ? {} : { keepUntil }),
    });
  }
};
