// The offload saga (ADR-0008; DESIGN.md "Offload process", "Project lifecycle"): resolve and lock, preflight, scan,
// plan, snapshot, verify, commit, release. The project folder is touched only in release, after the snapshot has been
// verified against the scan and the offloaded event is on the store; release renames the folder into
// `<root>/.plainport-trash/<op>/`, writes the stub where it stood, and leaves the deletion to a detached process.
//
// The journal (journal/<op>.json) is written at every step in OFFLOAD_STEPS, and each step then calls the host's
// crash seam, faultAt(step), so the crash matrix can stop the saga at any of them. What each step leaves for
// `plainport recover` (Task 14) when the process dies there:
//
//   offload.begin .. offload.planned       nothing is uploaded yet: roll back (remove the journal). A root-created
//                                          event the journal names (rootCreated) may or may not be on the store;
//                                          either is harmless
//   offload.snapshot.start                 restic may have written a snapshot nothing names: roll back
//   offload.snapshot.discarded             restic's incomplete snapshot (exit 3) is journaled: write its
//                                          snapshot-discarded event if the store lacks it, then roll back (D28)
//   offload.snapshot.done, offload.verified  a snapshot nothing names yet: roll back
//   offload.diverged                       the head moved: the event (`event`, `diverged`) keeps the snapshot as a
//                                          fork. Append it if the store lacks it, never release, remove the journal
//   offload.commit.start                   the offloaded event's id is journaled: if the store holds it, finish
//                                          release; if not, roll back (a lost write never deletes a folder, D24)
//   offload.committed .. release.stub      committed: finish release as the journal's `release` says (rename,
//                                          stub, registry, delete)
//   offload.release.delete                 released: delete the trash once keepUntil (if any) has passed
//
// A saga that ends on its own, success or expected failure, leaves nothing open: on a failure before the commit
// nothing local has changed, so it removes its journal; on success the detached delete removes the trash and then
// the journal. An expected I/O failure after the commit (a rename refused, a full disk) returns fs.write-failed and
// keeps the journal, so recover finishes. Ctrl-C (the signal) is honoured at the safe points before the commit
// (between phases, and inside restic, which it stops); after the commit the saga finishes release.
//
// An injected fault (InjectedFault) is a simulated crash: nothing here catches it.

import { basename, dirname, join } from "node:path";
import {
  type Failure,
  type Finding,
  fail,
  failWith,
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
import { type PlanBoundary, type PreparedOffload, prepareOffload } from "../plan/planner.ts";
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
import { scanTree } from "../scan/walk.ts";
import { type ConfiguredStore, openStore } from "../store.ts";
import { readStub, STUB_SUFFIX, type Stub, StubSchema } from "../stub.ts";
import { ulid } from "../ulid.ts";
import { isExcluded, verifyListing } from "./verify.ts";

/**
 * Every journal step, in the order a run reaches them; the crash matrix enumerates its rows from this list.
 * The preparation steps through snapshot.done are reached again when an edit during the upload makes the offload
 * plan and snapshot once more; snapshot.discarded only when restic could not read a file (exit 3); diverged, instead
 * of commit.start and what follows, only when the head moved during the upload.
 */
export const OFFLOAD_STEPS = [
  "offload.begin",
  "offload.preflight.done",
  "offload.scan.done",
  "offload.strip.done",
  "offload.planned",
  "offload.snapshot.start",
  "offload.snapshot.discarded",
  "offload.snapshot.done",
  "offload.verified",
  "offload.diverged",
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

/** Plans and snapshots per offload: the first, and one more when files changed during the upload. */
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
  /** The command's clock (plans, events, deadlines); the host's when absent. */
  now?: () => Date;
}

export interface OffloadRequest {
  /** The resolved project; it must have a folder on this device. */
  project: ProjectRef;
  /** An approved plan's id (--plan): it runs only as it was approved (folder, options, config). */
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
  /** Bytes freed now: the whole folder once its deletion has started, 0 while the trash is kept or waits. */
  freedBytes: number;
  /** Absent when config says stub = false. */
  stub?: string;
  /** Where the folder waits to be deleted. */
  trash: string;
  /** keepLocalFor: the trash is kept until then. */
  keepUntil?: string;
}

/** The error data of exit 8 (D14): the snapshot this offload made, kept as a fork. */
export interface OffloadConflict {
  op: string;
  exitCode: 8;
  project: string;
  /** The plainport snapshot id, and this store's restic id for it. */
  snapshot: string;
  store: string;
  stored: string;
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

/** fs.write-failed for an expected I/O error (systemErrorCode rethrows anything else, a bug). */
const writeFailed = (error: unknown, what: string, committed: boolean, path: string): Failure => {
  const code = systemErrorCode(error);
  return fail(
    finding("fs.write-failed", {
      message: `${what} failed (${code}): ${(error as Error).message}${committed ? "; the snapshot is committed, and nothing is lost" : "; nothing local was changed"}`,
      fix: committed
        ? "fix what the message names (permissions, free space), then run plainport recover to finish the offload"
        : "fix what the message names (permissions, free space), then re-run",
      paths: [path],
    }),
  );
};

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

/** What an approval must still hold for a fresh plan to run as the approved one (D36, D38). */
const approvalKey = (plan: Plan): string =>
  JSON.stringify({
    kind: plan.kind,
    dir: plan.project?.dir,
    store: plan.project?.store,
    fingerprint: plan.fingerprint,
    options: plan.options,
    strip: plan.strip.map((s) => [s.path, s.plugin]),
    findings: plan.findings.map((f) => [f.code, f.severity]).sort(),
  });

/** Runs the offload; see the file comment. A failure before the commit changed nothing local. */
export const runOffload = async (deps: OffloadDeps, req: OffloadRequest): Promise<Result<OffloadOutcome>> => {
  const { host, paths, device, signal } = deps;
  const io: LocalIo = host;
  const clock = (): Date => deps.now?.() ?? host.clock.now();
  const ref = req.project;
  const op = ulid(clock().getTime());
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
    const stub = (await readStub(io, `${dir}${STUB_SUFFIX}`)).ok;
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
    id ??= ulid(clock().getTime());
    const registeredAt = clock().toISOString();
    return ok({
      ...registry,
      projects: { ...registry.projects, [id]: { root: ref.root, path: ref.path, registeredAt } },
    });
  });
  if (!registered.ok) return registered;
  const projectId = id as string;
  const base = registered.value.projects[projectId]?.base;

  const lock = await acquireLock(io, join(paths.locksDir, `${projectId}.lock`), {
    timeoutMs: 0,
    held: lockHeld(ref.address),
    now: clock,
  });
  if (!lock.ok) return lock;
  try {
    return await locked();
  } finally {
    await lock.value.release();
  }

  async function locked(): Promise<Result<OffloadOutcome>> {
    const folder = dir as string;
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
        now: clock(),
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

    const rootFolder = rootFolderOf(ref, folder);
    const [here, beside] = await Promise.all([io.fs.stat(folder), io.fs.stat(rootFolder)]);
    if (here.dev !== beside.dev) {
      return fail(
        finding("fs.cross-volume", {
          message: `${folder} is a separate volume from ${rootFolder}, so it cannot be moved aside into ${join(rootFolder, TRASH_DIR)} in one rename`,
          fix: "offload a folder that lives on its root's own volume",
          paths: [folder],
        }),
      );
    }

    // The root's ULID, decided under the registry lock so concurrent first offloads in one root agree (D40): the one
    // this device recorded, else the catalog's, else a new one. It is recorded either way.
    let rootId = "";
    const rooted = await updateRegistry(io, paths, (registry) => {
      rootId = resolveRootId(registry, before.value, ref.root)?.id ?? ulid(clock().getTime());
      return ok(
        registry.roots?.[ref.root] === rootId
          ? registry
          : { ...registry, roots: { ...registry.roots, [ref.root]: rootId } },
      );
    });
    if (!rooted.ok) return rooted;
    const needsRootEvent = (before.value.roots[rootId]?.created ?? null) === null;

    const startedAt = clock().toISOString();
    const journal: OffloadJournal = {
      v: 1,
      op,
      kind: "offload",
      step: "offload.begin",
      startedAt,
      updatedAt: startedAt,
      pid: io.proc.pid,
      host: io.proc.hostname(),
      project: { id: projectId, address: ref.address, root: ref.root, rootId, path: ref.path, dir: folder },
      store: { name: store.name, id: store.id },
      ...(base === undefined ? {} : { base }),
      attempts: [],
      history: [],
    };
    let journaled = false;
    let committed = false;
    /** Journals a step, then reaches the crash seam. An I/O error is fs.write-failed, never an exception. */
    const step = async (name: OffloadStep, change: Partial<OffloadJournal> = {}): Promise<Result<void>> => {
      const at = clock().toISOString();
      Object.assign(journal, change, { step: name, updatedAt: at });
      journal.history.push({ step: name, at });
      try {
        await writeJournal(io, paths, journal);
      } catch (error) {
        return writeFailed(error, `writing the journal at ${name}`, committed, journalFile(paths, op));
      }
      journaled = true;
      host.faultAt(name);
      return ok(undefined);
    };
    /** Ends a run that failed before the commit: nothing local changed, so nothing is left to recover. */
    const abandon = async (failure: Failure): Promise<Failure> => {
      if (journaled) {
        try {
          await removeJournal(io, paths, op);
        } catch (error) {
          systemErrorCode(error);
          deps.log(
            "warn",
            `the journal ${journalFile(paths, op)} could not be removed; plainport recover removes it`,
          );
        }
      }
      return failure;
    };
    const now = () => clock().toISOString();
    const events = storeEventLog(store.blob);

    const begun = await step("offload.begin", needsRootEvent ? { rootCreated: ulid(clock().getTime()) } : {});
    if (!begun.ok) return abandon(begun);
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
    }
    phase("resolve", "end");
    if (signal?.aborted) return abandon(cancelled());

    let approved: Plan | undefined;
    if (req.plan !== undefined) {
      const read = await readPlan(io, paths, req.plan, clock());
      if (!read.ok) return abandon(read);
      approved = read.value;
      const blocked = approved.findings.find((f) => f.severity === "block");
      if (blocked !== undefined) return abandon(fail(blocked));
    }

    /** Plans the offload, phase by phase, journaling each boundary as it is crossed. */
    const plan = async (journalSteps: boolean): Promise<Result<PreparedOffload>> => {
      let failed: Failure | undefined;
      const boundary = async (at: PlanBoundary) => {
        if (failed !== undefined) return;
        const [name, status] = at.split(".") as [string, string];
        if (name !== "strip") phase(name as Phase, status as "start" | "end");
        if (!journalSteps) return;
        const reached =
          at === "preflight.end"
            ? "offload.preflight.done"
            : at === "scan.end"
              ? "offload.scan.done"
              : at === "strip.end"
                ? "offload.strip.done"
                : undefined;
        if (reached !== undefined) {
          const written = await step(reached);
          if (!written.ok) failed = written;
        }
      };
      const prepared = await prepareOffload(host, deps.checks, deps.plugins, {
        dir: folder,
        project: { address: ref.address, root: ref.root, path: ref.path, id: projectId },
        loader: deps.loader,
        env: deps.env,
        now: clock(),
        store: store.name,
        ...(req.keepDeps === true ? { keepDeps: true } : {}),
        ...(req.allow === undefined ? {} : { allow: req.allow }),
        ...(signal === undefined ? {} : { signal }),
        ...(journalSteps ? { boundary, onFinding: report } : {}),
      });
      if (failed !== undefined) return failed;
      return prepared;
    };
    /** plan.stale (exit 6), the fresh plan saved and carried as the error's data (D14, D38). */
    const stale = async (message: string): Promise<Failure> => {
      const fresh = await plan(false);
      if (!fresh.ok) return abandon(fresh);
      const blocked = fresh.value.plan.findings.some((f) => f.severity === "block");
      let saved = !blocked;
      if (saved) {
        try {
          await savePlan(io, paths, fresh.value.plan, clock());
        } catch (error) {
          systemErrorCode(error);
          saved = false;
        }
      }
      const address = shellWord(ref.address);
      return abandon(
        failWith(
          finding("plan.stale", {
            message: `${message}; nothing was uploaded`,
            fix: saved
              ? `review the fresh plan (it is this error's data, or plainport offload ${address} --dry-run), then approve it: plainport offload ${address} --plan ${fresh.value.plan.id}`
              : `plainport offload ${address} --dry-run, fix what it reports, then approve the new plan`,
          }),
          fresh.value.plan,
          6,
        ),
      );
    };

    const allow = new Set(req.allow ?? []);
    const ctx: RunContext = {
      op,
      ...(signal === undefined ? {} : { signal }),
      emit: (e) => (e.type === "log" ? deps.log(e.level, e.message) : deps.emit(e)),
    };
    let previous =
      base === undefined ? undefined : before.value.projects[projectId]?.snapshots[base]?.stored[store.name];
    let prepared: PreparedOffload | undefined;
    let verified: { snapshot: string; files: number; bytes: number } | undefined;
    for (let attempt = 1; verified === undefined; attempt++) {
      // Preflight, scan, strip set and plan, from scratch on every attempt: nothing of an earlier one is kept.
      const planned = await plan(true);
      if (!planned.ok) return abandon(signal?.aborted ? cancelled() : planned);
      prepared = planned.value;
      const current = prepared.plan;
      if (attempt === 1) for (const f of current.findings) report(f);
      if (approved !== undefined && approvalKey(approved) !== approvalKey(current)) {
        return stale(
          attempt === 1
            ? `the folder, the options or the config changed since plan ${approved.id} was approved`
            : `files changed during the upload, so plan ${approved.id} no longer describes the folder`,
        );
      }
      for (const code of allow) {
        const f = current.findings.find((x) => x.code === code);
        if (attempt === 1 && f !== undefined && f.severity === "block" && !f.allowable)
          deps.log("warn", `--allow ${code} has no effect: ${code} cannot be allowed`);
      }
      const blocker = current.findings.find(
        (f) => f.severity === "block" && !(f.allowable && allow.has(f.code)),
      );
      if (blocker !== undefined) return abandon(fail(blocker));
      const settled = await step("offload.planned", {
        plan: { id: current.id, fingerprint: current.fingerprint },
        release: {
          keepLocalFor: prepared.config.offload.keepLocalFor,
          stub: prepared.config.offload.stub,
        },
      });
      if (!settled.ok) return abandon(settled);
      if (signal?.aborted) return abandon(cancelled());

      for (const pid of prepared.fsmonitor) {
        const stopped = await host.run({
          command: "git",
          args: ["fsmonitor--daemon", "stop"],
          cwd: folder,
          env: { PATH: deps.env.PATH ?? "/usr/bin:/bin", HOME: deps.env.HOME ?? paths.home },
          timeoutMs: 30_000,
        });
        const done = stopped.ok && stopped.value.exitCode === 0;
        deps.log(
          done ? "info" : "warn",
          `git fsmonitor daemon ${pid}: ${done ? "stopped" : "could not be stopped"}`,
        );
      }

      // The fingerprint, re-checked right before restic reads the folder (DESIGN "Offload process" step 6).
      phase("snapshot", "start");
      const right = await scanTree(io.fs, folder);
      if (!right.ok) return abandon(right);
      if (right.value.fingerprint !== current.fingerprint)
        return stale("the folder changed between the plan and the snapshot");

      const excluded = new Set(current.strip.map((s) => s.path));
      for (const s of prepared.tree.skipped) if (!isExcluded(excluded, s.path)) excluded.add(s.path);
      const starting = await step("offload.snapshot.start");
      if (!starting.ok) return abandon(starting);
      const made = await store.engine.snapshot(
        {
          dir: folder,
          excludes: [...excluded].sort(),
          ...(previous === undefined ? {} : { parent: previous }),
          tags: [
            "plainport",
            `plainport:project=${projectId}`,
            `plainport:root=${rootId}`,
            `plainport:path=${ref.path}`,
            `plainport:op=${op}`,
            "plainport:kind=offload",
          ],
        },
        ctx,
      );
      if (!made.ok) {
        if (made.incomplete !== undefined) {
          // restic wrote a snapshot although it could not read everything (exit 3, D28): name it as discarded.
          const discarded = { snapshot: made.incomplete.snapshot, event: ulid(clock().getTime()) };
          const noted = await step("offload.snapshot.discarded", {
            attempts: [...journal.attempts, discarded.snapshot],
            discarded,
          });
          if (!noted.ok) return noted;
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
      const done = await step("offload.snapshot.done", { attempts: [...journal.attempts, made.value.id] });
      if (!done.ok) return abandon(done);
      phase("snapshot", "end");

      // Verify: re-stat the folder, then compare the snapshot's listing with the scan it was made from.
      phase("verify", "start");
      const after = await scanTree(io.fs, folder);
      if (!after.ok) return abandon(after);
      if (after.value.fingerprint !== prepared.tree.fingerprint) {
        phase("verify", "end");
        if (approved !== undefined)
          return stale(
            `files changed during the upload, so plan ${approved.id} no longer describes the folder`,
          );
        if (attempt >= ATTEMPTS) {
          return abandon(
            fail(
              finding("verify.changed", {
                message: `files in ${ref.address} changed while the snapshot was made, twice; nothing local was deleted`,
                fix: "stop whatever is writing to the folder (a dev server, a watcher, an agent), then re-run",
                paths: [folder],
              }),
            ),
          );
        }
        deps.log(
          "info",
          `files in ${ref.address} changed while the snapshot was made; planning and taking it again`,
        );
        previous = made.value.id;
        if (signal?.aborted) return abandon(cancelled());
        continue;
      }
      const checked = await verifyListing({
        engine: store.engine,
        fs: io.fs,
        snapshot: made.value.id,
        dir: folder,
        manifest: prepared.tree.manifest,
        excluded,
        ctx,
      });
      if (!checked.ok) return abandon(signal?.aborted ? cancelled() : checked);
      verified = { snapshot: made.value.id, ...checked.value };
    }
    const ready = prepared as PreparedOffload;
    const policy = journal.release as NonNullable<OffloadJournal["release"]>;
    const verifiedStep = await step("offload.verified", { verified: verified.snapshot });
    if (!verifiedStep.ok) return abandon(verifiedStep);
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
      id: ulid(clock().getTime()),
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
        strippedBytes: ready.plan.strip.reduce((sum, s) => sum + s.bytes, 0),
        ecosystems: ready.ecosystems,
      },
    };
    if (head.kind === "moved") {
      // Another copy moved the head: the snapshot is kept as a fork and this folder stays (DESIGN "Conflict"). Its
      // own branch, so a crash here never reads as a commit to release.
      const forked = await step("offload.diverged", { event: event.id, diverged: true });
      if (!forked.ok) return abandon(forked);
      const kept = await appendEvent(events, event);
      if (!kept.ok) return kept;
      await abandon(fail(head.finding));
      const conflict: OffloadConflict = {
        op,
        exitCode: 8,
        project: ref.address,
        snapshot: op,
        store: store.name,
        stored: verified.snapshot,
      };
      return failWith(head.finding, conflict, 8);
    }
    const starting = await step("offload.commit.start", { event: event.id });
    if (!starting.ok) return abandon(starting);
    const appended = await appendEvent(events, event);
    // Whether a failed append landed is unknown: the journal stays for recover to look (D24).
    if (!appended.ok) return appended;
    committed = true;
    const done = await step("offload.committed");
    if (!done.ok) return done;
    phase("commit", "end");

    // Release: the only step that touches the folder, as the journal's release policy says.
    phase("release", "start");
    const trash = join(rootFolder, TRASH_DIR, op);
    const toTrash = await step("offload.release.trash", { trash });
    if (!toTrash.ok) return toTrash;
    try {
      await io.fs.mkdirp(trash);
      await io.fs.rename(folder, join(trash, basename(folder)));
      await io.fs.syncDir(trash);
      await io.fs.syncDir(dirname(folder));
    } catch (error) {
      if (systemErrorCode(error) === "EXDEV") {
        return fail(
          finding("fs.cross-volume", {
            message: `${folder} could not be renamed into ${trash}: it is on another volume; the snapshot is committed`,
            fix: "plainport recover finishes the offload once the folder can be moved",
            paths: [folder],
          }),
        );
      }
      return writeFailed(error, `moving ${folder} into ${trash}`, true, folder);
    }
    const moved = await step("offload.release.moved");
    if (!moved.ok) return moved;

    let stubPath: string | undefined;
    if (policy.stub) {
      stubPath = `${folder}${STUB_SUFFIX}`;
      const there = await readStub(io, stubPath);
      const present = await io.fs.lstat(stubPath).then(
        () => true,
        (error: unknown) => (systemErrorCode(error) === "ENOENT" ? false : Promise.reject(error)),
      );
      // D47: only an absent path or this project's own stub may be replaced; preflight blocked anything else, so this
      // is something put there since. It is left alone and recover writes the stub once it is moved.
      if (present && !(there.ok && there.value.project === projectId)) {
        return fail(
          finding("path.stub-occupied", {
            message: `${stubPath} appeared during the offload and is not this project's stub; the snapshot is committed and the folder is in ${trash}`,
            fix: `move ${shellWord(stubPath)} somewhere else, then run plainport recover`,
            paths: [stubPath],
          }),
        );
      }
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
      try {
        await writeAtomic(io, stubPath, `${JSON.stringify(stub, null, 2)}\n`);
      } catch (error) {
        return writeFailed(error, `writing the stub ${stubPath}`, true, stubPath);
      }
    }
    const updated = await updateRegistry(io, paths, (registry) => {
      const entry = registry.projects[projectId];
      if (entry === undefined) return ok(registry);
      const { onloadedAt: _, ...rest } = entry;
      return ok({ ...registry, projects: { ...registry.projects, [projectId]: { ...rest, base: op } } });
    });
    if (!updated.ok) deps.log("warn", `registry.json was not updated: ${updated.finding.message}`);
    const stubbed = await step("offload.release.stub", stubPath === undefined ? {} : { stub: stubPath });
    if (!stubbed.ok) return stubbed;

    const keepMs = durationMs(policy.keepLocalFor);
    const keepUntil = keepMs > 0 ? new Date(clock().getTime() + keepMs).toISOString() : undefined;
    const released = await step("offload.release.delete", keepUntil === undefined ? {} : { keepUntil });
    if (!released.ok) return released;
    let freed = false;
    if (keepUntil === undefined) {
      // Deletes the trash, then the journal, after this command has returned (D47); recover repeats it if it never runs.
      const started = await host.deleteTrashDetached(trash, journalFile(paths, op));
      if (started.ok) freed = true;
      else
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
      freedBytes: freed ? ready.tree.bytes : 0,
      ...(stubPath === undefined ? {} : { stub: stubPath }),
      trash,
      ...(keepUntil === undefined ? {} : { keepUntil }),
    });
  }
};
