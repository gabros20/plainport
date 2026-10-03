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
//                                          event the journal names (rootCreated) may or may not be on the store,
//                                          and the store's root claim (meta/v1/root.json) names this root; both are
//                                          harmless and stay
//   offload.snapshot.start                 restic may have written a snapshot nothing names (tagged
//                                          plainport:op=<op>): roll back
//   offload.snapshot.discarded             restic's incomplete snapshot (exit 3) is journaled: write its
//                                          snapshot-discarded event if the store lacks it, then roll back (D28)
//   offload.snapshot.done, offload.verified  the next step's write (commit.start or diverged) may be the one a power
//                                          loss dropped after its event reached the store (D24, D50), so first
//                                          search the store for an offloaded event of this op (every event carries
//                                          `op`) that names a snapshot in `attempts`. None: roll back. One that the
//                                          catalog folds as the project's head (snapshot = op): it was committed,
//                                          so go on as from offload.committed (the fingerprint check included). One
//                                          that is not the head (the project forked): handle it as offload.diverged
//   offload.diverged                       the head moved: the event (`event`, `diverged`) keeps the snapshot as a
//                                          fork. Append it if the store lacks it, never release, remove the journal
//   offload.commit.start                   the offloaded event's id is journaled: if the store holds it, go on as
//                                          from offload.committed; if not, roll back (a lost write never deletes a
//                                          folder, D24)
//   offload.committed .. release.stub      committed: finish release as the journal's `release` says (rename,
//                                          stub, registry, delete), but while the folder still stands at
//                                          project.dir, only if scanTree(project.dir) still has the verified
//                                          fingerprint (plan.fingerprint: the plan of the attempt that was verified).
//                                          The machine may have been used for hours since the crash; if the folder
//                                          changed, keep it, write no stub, and report
//                                          offload.diverged-after-commit naming the snapshot (D51): the folder and
//                                          the committed snapshot are two copies for resolve. The trash is `trash`;
//                                          when the release.trash
//                                          write was lost (the journal says committed and has none), it is
//                                          offloadTrashOf(journal), and the folder may already be in it: look in
//                                          both places. The stub's offloadedAt and bytes are the event's
//   offload.release.delete                 released: delete the trash once keepUntil (if any) has passed
//
// RECOVERY_NEEDS lists, step by step, the journal fields those rules read; the saga's tests check each is there.
//
// The parts, each reusable by onload (Task 13) and recover (Task 14): saga/project-gate.ts (the lock and the
// journal.pending gate), saga/journaled.ts (the journal, its crash seams and what a failure leaves), catalog/head.ts
// (the catalog read, the head check, the root check), saga/snapshot.ts (snapshot.start .. snapshot.done, D28),
// saga/verify.ts (step 7's re-stat, listing, re-stat) and saga/release.ts (release.trash .. release.delete, from the
// journal alone).
//
// A saga that ends on its own, success or expected failure, leaves nothing open: on a failure before the commit
// nothing local has changed, so it removes its journal; on success the detached delete removes the trash and then
// the journal. An expected I/O failure after the commit (a rename refused, a full disk) returns fs.write-failed and
// keeps the journal, so recover finishes. Ctrl-C (the signal) is honoured at the safe points before the commit
// (between phases, and inside restic, which it stops); one that lands after the commit stops before release, with
// the journal kept for recover (D52). Release itself starts by re-checking the folder's fingerprint (D51, D52).
//
// An injected fault (InjectedFault) is a simulated crash: nothing here catches it.

import { join } from "node:path";
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
import type { CatalogEvent } from "../catalog/events.ts";
import { catalogReader, headCheck, otherRoot, rootMismatch } from "../catalog/head.ts";
import { appendEvent, storeEventLog } from "../catalog/log.ts";
import { claimStoreRoot } from "../catalog/root-claim.ts";
import { resolveRootId } from "../catalog/roots.ts";
import type { ConfigLoader } from "../config/load.ts";
import type { Device } from "../device.ts";
import { type LocalIo, systemErrorCode } from "../io.ts";
import type { OffloadJournal } from "../journal/index.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import { type PlanBoundary, type PreparedOffload, prepareOffload } from "../plan/planner.ts";
import type { Plan } from "../plan/schema.ts";
import { planBlocker, planCommand } from "../plan/schema.ts";
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
import { readStub, STUB_SUFFIX } from "../stub.ts";
import { ulid } from "../ulid.ts";
import { openSaga, runSaga } from "./journaled.ts";
import { withProjectLock } from "./project-gate.ts";
import { releaseOffload, rootFolderOf, TRASH_DIR } from "./release.ts";
import { takeSnapshot } from "./snapshot.ts";
import { isExcluded, verifySnapshot } from "./verify.ts";

export { durationMs, offloadTrashOf, TRASH_DIR } from "./release.ts";

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

/**
 * Crash seams right after a side effect, with no journal write (D52): a fault at one leaves the effect done and the
 * journal at the step named here, as a lost journal write would. The crash matrix stops at these as well as at every
 * step, so it reaches the states the recover table is written for.
 */
export const OFFLOAD_AFTER_EFFECT = {
  "offload.root-created": "offload.begin",
  "offload.snapshot.discarded.appended": "offload.snapshot.discarded",
  "offload.diverged.appended": "offload.diverged",
  "offload.commit.appended": "offload.commit.start",
  "offload.release.renamed": "offload.release.trash",
  "offload.release.stub-placed": "offload.release.moved",
  "offload.release.registry-updated": "offload.release.moved",
  "offload.release.detached": "offload.release.delete",
} as const satisfies Record<string, OffloadStep>;
export type OffloadAfterEffect = keyof typeof OFFLOAD_AFTER_EFFECT;

/**
 * The branches a plain run does not take, and what makes a run take each, so the crash matrix can show it covered
 * every row: the steps and seams only a branch reaches, and the retry that reaches the preparation twice.
 */
export const OFFLOAD_BRANCHES = {
  discarded: {
    when: "restic cannot read a file during the upload (exit 3, D28)",
    reaches: ["offload.snapshot.discarded", "offload.snapshot.discarded.appended"],
  },
  diverged: {
    when: "another copy moves the project's head during the upload",
    reaches: ["offload.diverged", "offload.diverged.appended"],
  },
  retry: {
    when: "a file changes during the upload, once",
    reaches: [
      "offload.preflight.done",
      "offload.scan.done",
      "offload.strip.done",
      "offload.planned",
      "offload.snapshot.start",
      "offload.snapshot.done",
    ],
  },
  firstOffloadOfRoot: { when: "the root has no root-created event yet", reaches: ["offload.root-created"] },
  keepStub: { when: "offload.stub = true (the default)", reaches: ["offload.release.stub-placed"] },
  detached: { when: 'offload.keepLocalFor = "0" (the default)', reaches: ["offload.release.detached"] },
} as const;

/** What every journal names: the operation, the project and its folder, the store. */
const IDENTITY = [
  "op",
  "project.id",
  "project.dir",
  "project.path",
  "project.rootId",
  "store.name",
  "store.id",
];
/** Decided with the plan: how release goes, whatever the config says by the time recover runs. */
const POLICY = [...IDENTITY, "plan.id", "release.keepLocalFor", "release.stub"];

/**
 * The journal fields (dotted paths) recovery reads at each step, by the table in the file comment: a journal at that
 * step always holds them. Task 14's recover reads nothing else. plan.fingerprint is listed wherever recovery may
 * release a folder that still stands (D51): release.trash may be the last write before a rename that did happen.
 */
export const RECOVERY_NEEDS: Readonly<Record<OffloadStep, readonly string[]>> = {
  "offload.begin": IDENTITY,
  "offload.preflight.done": IDENTITY,
  "offload.scan.done": IDENTITY,
  "offload.strip.done": IDENTITY,
  "offload.planned": POLICY,
  "offload.snapshot.start": POLICY,
  "offload.snapshot.discarded": [...POLICY, "discarded.snapshot", "discarded.event"],
  "offload.snapshot.done": [...POLICY, "plan.fingerprint", "attempts.0"],
  "offload.verified": [...POLICY, "plan.fingerprint", "attempts.0", "verified"],
  "offload.diverged": [...POLICY, "verified", "event", "diverged"],
  "offload.commit.start": [...POLICY, "plan.fingerprint", "verified", "event"],
  "offload.committed": [...POLICY, "plan.fingerprint", "verified", "event"],
  "offload.release.trash": [...POLICY, "plan.fingerprint", "verified", "event", "trash"],
  "offload.release.moved": [...POLICY, "verified", "event", "trash"],
  "offload.release.stub": [...POLICY, "verified", "event", "trash"],
  "offload.release.delete": [...POLICY, "verified", "event", "trash"],
};

/** Plans and snapshots per offload: the first, and one more when files changed during the upload. */
const ATTEMPTS = 2;

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

/** operation.cancelled once the offload is committed: release did not start, and recover finishes it (D52). */
const cancelledAfterCommit = (address: string, op: string): Failure =>
  fail(
    finding("operation.cancelled", {
      message: `the offload of ${address} was committed as snapshot ${op} and then stopped before release; the folder is as it was`,
      fix: "plainport recover finishes the release (it checks the folder is unchanged first)",
    }),
  );

const cancelled = (): Failure =>
  fail(
    finding("operation.cancelled", {
      message: "the offload was stopped before it changed anything local; the folder is as it was",
      fix: "re-run the offload when you are ready",
    }),
  );

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

/** The project's folder, checked to be a folder here; project.not-found or fs.unreadable when it is not. */
const locate = async (io: LocalIo, ref: ProjectRef): Promise<Result<string>> => {
  const notHere = (detail: string, shelved = ref.stub !== undefined) =>
    fail(
      finding("project.not-found", {
        message: `${ref.address} ${detail}, so there is nothing here to offload`,
        fix: shelved
          ? `it is shelved: plainport onload ${shellWord(ref.address)} brings it back`
          : `plainport root bind ${ref.root} <path> if the root lives elsewhere on this device`,
      }),
    );
  const dir = ref.dir;
  if (dir === undefined) return notHere("has no folder on this device");
  try {
    const kind = (await io.fs.lstat(dir)).kind;
    if (kind === "symlink") return notHere(`is a symlink at ${dir}; offload the folder it points to`);
    if (kind !== "dir") return notHere(`is not a folder at ${dir}`);
    return ok(dir);
  } catch (error) {
    const code = systemErrorCode(error);
    if (code !== "ENOENT") {
      return fail(
        finding("fs.unreadable", {
          message: `${dir} cannot be inspected (${code}), so it was not offloaded`,
          fix: `check that you can read ${shellWord(dir)} and the folder that holds it, then re-run`,
          paths: [dir],
        }),
      );
    }
    // ProjectRef's match "address" (or a stub) means the folder was never checked: it is simply not here.
    const stub = (await readStub(io, `${dir}${STUB_SUFFIX}`)).ok;
    return notHere(
      stub ? `is shelved (its stub is at ${dir}${STUB_SUFFIX})` : `has no folder at ${dir}`,
      stub,
    );
  }
};

/** fs.cross-volume when the folder cannot be renamed into its root's trash in one step; nothing when it can. */
const sameVolume = async (io: LocalIo, folder: string, rootFolder: string): Promise<Failure | undefined> => {
  let here: { dev: number };
  let beside: { dev: number };
  try {
    [here, beside] = await Promise.all([io.fs.stat(folder), io.fs.stat(rootFolder)]);
  } catch (error) {
    const code = systemErrorCode(error);
    return fail(
      finding("fs.unreadable", {
        message: `${folder} or ${rootFolder} cannot be inspected (${code}), so it was not offloaded`,
        fix: "check that you can read both folders, then re-run",
        paths: [folder, rootFolder],
      }),
    );
  }
  if (here.dev === beside.dev) return undefined;
  return fail(
    finding("fs.cross-volume", {
      message: `${folder} is a separate volume from ${rootFolder}, so it cannot be moved aside into ${join(rootFolder, TRASH_DIR)} in one rename`,
      fix: "offload a folder that lives on its root's own volume",
      paths: [folder],
    }),
  );
};

/** Runs the offload; see the file comment. A failure before the commit changed nothing local. */
export const runOffload = async (deps: OffloadDeps, req: OffloadRequest): Promise<Result<OffloadOutcome>> => {
  const { host, paths, device, signal } = deps;
  const io: LocalIo = host;
  const clock = (): Date => deps.now?.() ?? host.clock.now();
  const now = () => clock().toISOString();
  const ref = req.project;
  const op = ulid(clock().getTime());
  const phase = (name: Phase, status: "start" | "end") =>
    deps.emit({ type: "phase", op, phase: name, status });
  const report = (f: Finding) => deps.emit({ type: "finding", op, finding: f });

  phase("resolve", "start");
  const located = await locate(io, ref);
  if (!located.ok) return located;
  const folder = located.value;

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
  let projectId = ref.id ?? "";
  const registered = await updateRegistry(io, paths, (registry) => {
    if (projectId === "")
      projectId =
        Object.entries(registry.projects).find(([, e]) => e.root === ref.root && e.path === ref.path)?.[0] ??
        "";
    if (projectId !== "" && registry.projects[projectId] !== undefined) return ok(registry);
    if (projectId === "") projectId = ulid(clock().getTime());
    const registeredAt = clock().toISOString();
    return ok({
      ...registry,
      projects: { ...registry.projects, [projectId]: { root: ref.root, path: ref.path, registeredAt } },
    });
  });
  if (!registered.ok) return registered;
  const base = registered.value.projects[projectId]?.base;

  const gate = { io, paths, clock, log: deps.log };
  return withProjectLock(gate, { id: projectId, address: ref.address }, async () => {
    const mirror = await deps.openMirror(store.id);
    if (!mirror.ok) return mirror;
    const catalog = catalogReader({
      store: store.blob,
      mirror: mirror.value,
      storeId: store.id,
      storeName: store.name,
      now: clock,
      report,
    });
    const before = await catalog();
    if (!before.ok) return before;
    const early = headCheck(before.value, projectId, base, ref.address);
    if (early.kind !== "ok") return fail(early.finding);
    const ctx: RunContext = {
      op,
      ...(signal === undefined ? {} : { signal }),
      emit: (e) => (e.type === "log" ? deps.log(e.level, e.message) : deps.emit(e)),
    };
    // Preflight's "the credentials work" (DESIGN "Offload process" step 2): the password opens the repository.
    const opens = await store.engine.list({ tags: ["plainport", `plainport:project=${projectId}`] }, ctx);
    if (!opens.ok) return signal?.aborted ? cancelled() : opens;
    const crossVolume = await sameVolume(io, folder, rootFolderOf(ref.path, folder));
    if (crossVolume !== undefined) return crossVolume;

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
    const shared = otherRoot(before.value, rootId);
    if (shared !== undefined) return fail(rootMismatch(store.name, ref.root, shared));
    // The store is claimed for this root before anything else is written to it, so of two roots' first offloads at
    // once exactly one goes on (D50).
    const claim = await claimStoreRoot(store.blob, rootId);
    if (!claim.ok) return claim;
    if (claim.value.root !== rootId)
      return fail(
        rootMismatch(store.name, ref.root, before.value.roots[claim.value.root]?.key ?? claim.value.root),
      );
    const needsRootEvent = (before.value.roots[rootId]?.created ?? null) === null;

    const startedAt = now();
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
    const saga = openSaga<OffloadJournal, OffloadStep>(
      { io, paths, faultAt: (point) => host.faultAt(point), clock, log: deps.log },
      journal,
    );
    const events = storeEventLog(store.blob);

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
          const written = await saga.step(reached);
          if (!written.ok) failed = written;
        }
      };
      const prepared = await prepareOffload(host, deps.checks, deps.plugins, {
        dir: folder,
        project: { address: ref.address, root: ref.root, path: ref.path, id: projectId },
        loader: deps.loader,
        env: deps.env,
        now: clock(),
        ...(req.store === undefined ? {} : { store: req.store }),
        storeId: store.id,
        ...(req.keepDeps === true ? { keepDeps: true } : {}),
        ...(req.allow === undefined ? {} : { allow: req.allow }),
        ...(signal === undefined ? {} : { signal }),
        ...(journalSteps ? { boundary, onFinding: report } : {}),
        stopFsmonitor: true,
        log: deps.log,
      });
      if (failed !== undefined) return failed;
      return prepared;
    };

    /** plan.stale (exit 6), the fresh plan saved and carried as the error's data (D14, D38). */
    const stale = async (message: string, uploaded = false): Promise<Failure> => {
      const fresh = await plan(false);
      if (!fresh.ok) return fresh;
      let saved = planBlocker(fresh.value.plan) === undefined;
      if (saved) {
        try {
          await savePlan(io, paths, fresh.value.plan, clock());
        } catch (error) {
          systemErrorCode(error);
          saved = false;
        }
      }
      return failWith(
        finding("plan.stale", {
          message: `${message}; ${
            uploaded
              ? "a snapshot was uploaded but not committed, so it is never a head, and nothing local was deleted"
              : "nothing was uploaded"
          }`,
          fix: saved
            ? `review the fresh plan (it is this error's data), then approve it: ${planCommand(fresh.value.plan)}`
            : `plainport offload ${shellWord(ref.address)} --dry-run, fix what it reports, then approve the new plan`,
        }),
        fresh.value.plan,
        6,
      );
    };

    type Verified = { prepared: PreparedOffload; snapshot: string; files: number; bytes: number };

    /** Plans, snapshots and verifies, once more when the folder changed during the upload (DESIGN steps 3–7). */
    const snapshotVerified = async (approved: Plan | undefined): Promise<Result<Verified>> => {
      const allow = new Set(req.allow ?? []);
      /** Findings streamed so far: a retry streams only what is new in its plan. */
      const reported = new Set<string>();
      let previous =
        base === undefined
          ? undefined
          : before.value.projects[projectId]?.snapshots[base]?.stored[store.name];
      for (let attempt = 1; ; attempt++) {
        // Preflight, scan, strip set and plan, from scratch on every attempt: nothing of an earlier one is kept.
        const planned = await plan(true);
        if (!planned.ok) return signal?.aborted ? cancelled() : planned;
        const prepared = planned.value;
        const current = prepared.plan;
        for (const f of current.findings) {
          const key = JSON.stringify(f);
          if (reported.has(key)) continue;
          reported.add(key);
          report(f);
        }
        if (approved !== undefined && approvalKey(approved) !== approvalKey(current)) {
          return stale(
            attempt === 1
              ? `the folder, the options or the config changed since plan ${approved.id} was approved`
              : `files changed during the upload, so plan ${approved.id} no longer describes the folder`,
            attempt > 1,
          );
        }
        for (const code of allow) {
          const f = current.findings.find((x) => x.code === code);
          if (attempt === 1 && f !== undefined && f.severity === "block" && !f.allowable)
            deps.log("warn", `--allow ${code} has no effect: ${code} cannot be allowed`);
        }
        // The plan records --allow (options.allow), so its blocker is the one that list leaves (D50).
        const blocker = planBlocker(current);
        if (blocker !== undefined) return fail(blocker);
        const settled = await saga.step("offload.planned", {
          plan: { id: current.id, fingerprint: current.fingerprint },
          release: {
            keepLocalFor: prepared.config.offload.keepLocalFor,
            stub: prepared.config.offload.stub,
          },
        });
        if (!settled.ok) return settled;
        if (signal?.aborted) return cancelled();

        // The fingerprint, re-checked right before restic reads the folder (DESIGN "Offload process" step 6).
        phase("snapshot", "start");
        const right = await scanTree(io.fs, folder);
        if (!right.ok) return right;
        if (right.value.fingerprint !== current.fingerprint)
          return stale("the folder changed between the plan and the snapshot");
        const excluded = new Set(current.strip.map((s) => s.path));
        for (const s of prepared.tree.skipped) if (!isExcluded(excluded, s.path)) excluded.add(s.path);
        const taken = await takeSnapshot({
          saga,
          engine: store.engine,
          events,
          device: device.id,
          clock,
          log: deps.log,
          excludes: [...excluded].sort(),
          ...(previous === undefined ? {} : { parent: previous }),
          ctx,
          cancelled,
        });
        if (!taken.ok) return taken;
        phase("snapshot", "end");

        phase("verify", "start");
        const checked = await verifySnapshot({
          engine: store.engine,
          fs: io.fs,
          dir: folder,
          snapshot: taken.value,
          tree: prepared.tree,
          excluded,
          ctx,
        });
        if (!checked.ok) return signal?.aborted ? cancelled() : checked;
        if (!checked.value.changed) return ok({ prepared, snapshot: taken.value, ...checked.value.totals });
        phase("verify", "end");
        if (approved !== undefined)
          return stale(
            `files changed during the upload, so plan ${approved.id} no longer describes the folder`,
            true,
          );
        if (attempt >= ATTEMPTS) {
          return fail(
            finding("verify.changed", {
              message: `files in ${ref.address} changed while the snapshot was made or checked, twice; nothing local was deleted`,
              fix: "stop whatever is writing to the folder (a dev server, a watcher, an agent), then re-run",
              paths: [folder],
            }),
          );
        }
        deps.log(
          "info",
          `files in ${ref.address} changed while the snapshot was made; planning and taking it again`,
        );
        previous = taken.value;
        if (signal?.aborted) return cancelled();
      }
    };

    /** Commit (DESIGN step 7's head check and event), then release (step 8). */
    const commitAndRelease = async (verified: Verified): Promise<Result<OffloadOutcome>> => {
      phase("commit", "start");
      const current = await catalog();
      // Ctrl-C during the reload is honoured like any other pre-commit safe point, whatever the reload returned.
      if (signal?.aborted) return cancelled();
      if (!current.ok) return current;
      // A store from before root claims (D50) can still be shared by a root whose first offload raced this one (D48).
      const sharedNow = otherRoot(current.value, rootId);
      if (sharedNow !== undefined) return fail(rootMismatch(store.name, ref.root, sharedNow));
      const head = headCheck(current.value, projectId, base, ref.address);
      if (head.kind === "incomplete") return fail(head.finding);
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
          strippedBytes: verified.prepared.plan.strip.reduce((sum, s) => sum + s.bytes, 0),
          ecosystems: verified.prepared.ecosystems,
        },
      };
      if (head.kind === "moved") {
        // Another copy moved the head: the snapshot is kept as a fork and this folder stays (DESIGN "Conflict"). Its
        // own branch, so a crash here never reads as a commit to release.
        const forked = await saga.step("offload.diverged", { event: event.id, diverged: true });
        if (!forked.ok) return forked;
        const kept = await appendEvent(events, event);
        if (!kept.ok) return saga.keep(kept);
        saga.after("offload.diverged.appended");
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
      const starting = await saga.step("offload.commit.start", { event: event.id });
      if (!starting.ok) return starting;
      const appended = await appendEvent(events, event);
      // Whether a failed append landed is unknown: the journal stays for recover to look (D24).
      if (!appended.ok) return saga.keep(appended);
      saga.after("offload.commit.appended");
      saga.commit();
      const done = await saga.step("offload.committed");
      if (!done.ok) return done;
      phase("commit", "end");
      // A cancel after the commit stops here, before release touches the folder; recover finishes it (D52).
      if (signal?.aborted) return cancelledAfterCommit(ref.address, op);

      phase("release", "start");
      const released = await releaseOffload(
        { host, paths, saga, clock, log: deps.log },
        { at: event.at, bytes: verified.bytes },
      );
      if (!released.ok) return released;
      phase("release", "end");
      const { trash, stub, keepUntil, freed } = released.value;
      return ok({
        op,
        project: ref.address,
        snapshot: op,
        store: store.name,
        freedBytes: freed ? verified.prepared.tree.bytes : 0,
        ...(stub === undefined ? {} : { stub }),
        trash,
        ...(keepUntil === undefined ? {} : { keepUntil }),
      });
    };

    return runSaga(saga, async () => {
      const begun = await saga.step(
        "offload.begin",
        needsRootEvent ? { rootCreated: ulid(clock().getTime()) } : {},
      );
      if (!begun.ok) return begun;
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
        if (!created.ok) return created;
        saga.after("offload.root-created");
      }
      phase("resolve", "end");
      if (signal?.aborted) return cancelled();

      let approved: Plan | undefined;
      if (req.plan !== undefined) {
        const read = await readPlan(io, paths, req.plan, clock());
        if (!read.ok) return read;
        approved = read.value;
        const blocked = planBlocker(approved);
        if (blocked !== undefined) return fail(blocked);
      }
      const verified = await snapshotVerified(approved);
      if (!verified.ok) return verified;
      const verifiedStep = await saga.step("offload.verified", { verified: verified.value.snapshot });
      if (!verifiedStep.ok) return verifiedStep;
      phase("verify", "end");
      if (signal?.aborted) return cancelled();
      return commitAndRelease(verified.value);
    });
  });
};
