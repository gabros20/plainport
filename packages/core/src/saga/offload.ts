// The offload saga (ADR-0008; DESIGN.md "Offload process", "Project lifecycle"): resolve and lock, preflight, scan,
// plan, snapshot, verify, commit, release. The project folder is touched only in release, after the snapshot has been
// verified against the scan and the offloaded event is on the store; release renames the folder into
// `<root>/.plainport-trash/<op>/`, writes the stub where it stood, and leaves the deletion to a detached process.
//
// The journal (journal/<op>.json) is written at every step in OFFLOAD_STEPS, and each step then calls the host's
// crash seam, faultAt(step), so the crash matrix can stop the saga at any of them. What each step leaves for
// `plainport recover` (Task 14) when the process dies there:
//
//   offload.begin .. offload.planned       roll back (remove the journal). On a retry these are reached again while
//                                          `attempts` names the earlier attempt's restic snapshot, which no event
//                                          names: it stays unexplained (D28 (d)), never a head. A root-created
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
//                                          `op`) that names a snapshot in `attempts`. None: roll back. One the
//                                          fold's conflicts name (the project forked): handle it as
//                                          offload.diverged. No head for another reason (a base the catalog does
//                                          not hold): pending, journal kept (D61). Otherwise (the head is this
//                                          snapshot or one made from it): committed, so go on as from
//                                          offload.committed (the fingerprint check included)
//   offload.diverged                       the head moved: the event (`event`, `diverged`) keeps the snapshot as a
//                                          fork (F1). Append it if the store lacks it, never release, record the
//                                          snapshot as the folder's base, remove the journal
//   offload.commit.start                   the offloaded event's id is journaled: if the store holds it, go on as
//                                          from offload.committed; if not, roll back (a lost write never deletes a
//                                          folder, D24)
//   offload.committed .. release.stub      committed (the journal's word: its committed write follows the
//                                          event's durable append, D24): finish release as `release` says (rename,
//                                          stub, registry, delete), but while the folder still stands at
//                                          project.dir, only once the store's catalog, read again, shows no fork
//                                          naming the snapshot (F2: one keeps the folder on its snapshot, closes the
//                                          journal, forked; a store that does not answer leaves it pending), and
//                                          only if scanTree(project.dir) still has the verified
//                                          fingerprint (plan.fingerprint: the plan of the attempt that was verified).
//                                          The machine may have been used for hours since the crash; if the folder
//                                          changed, keep it, write no stub, and report
//                                          offload.diverged-after-commit naming the snapshot, now the head and the
//                                          device's base (D51, D52). The trash is `trash`;
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
import type { CatalogProject } from "../catalog/fold.ts";
import {
  catalogReader,
  headCheck,
  leaseAhead,
  namesSnapshot,
  otherRoot,
  rootMismatch,
  storeHolding,
} from "../catalog/head.ts";
import { appendEvent, eventAt, mirrorEventLog, storeEventLog } from "../catalog/log.ts";
import { claimStoreRoot } from "../catalog/root-claim.ts";
import { resolveRootId } from "../catalog/roots.ts";
import { storedHere, storedKey } from "../catalog/stored.ts";
import type { ConfigLoader } from "../config/load.ts";
import type { Device } from "../device.ts";
import { assertSystemError, type LocalIo, systemErrorCode } from "../io.ts";
import type { OffloadJournal } from "../journal/index.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import { type PlanBoundary, type PreparedOffload, prepareOffload } from "../plan/planner.ts";
import type { Plan } from "../plan/schema.ts";
import { planBlocker, planCommand } from "../plan/schema.ts";
import { prunePlans, readPlan, savePlan } from "../plan/store.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { HostChecks } from "../ports/checks.ts";
import type { EcosystemPlugin } from "../ports/ecosystem.ts";
import type { RunContext } from "../ports/engine.ts";
import type { HostPorts } from "../ports/host.ts";
import type { StoreOpener } from "../ports/store.ts";
import { ensureRegistered, readRegistry, updateRegistry } from "../registry.ts";
import type { ProjectRef } from "../roots/address.ts";
import { FINGERPRINT_VERSION, includedFingerprint, scanTree } from "../scan/walk.ts";
import { type ConfiguredStore, openStore } from "../store.ts";
import { freshStores, type ProtectedStore } from "../store-overlap.ts";
import { refuseWhileUpgrading } from "../stores/upgrade.ts";
import { readStub, STUB_SUFFIX } from "../stub.ts";
import { ulid } from "../ulid.ts";
import { openSaga, runSaga } from "./journaled.ts";
import {
  type Nested,
  nestedProjects,
  type ProjectLock,
  registeredFolders,
  withProjectLock,
} from "./project-gate.ts";
import { type OffloadConflict, recordBase, releaseOffload, rootFolderOf, TRASH_DIR } from "./release.ts";
import { takeSnapshot } from "./snapshot.ts";
import { isExcluded, verifySnapshot } from "./verify.ts";

export { durationMs, type OffloadConflict, offloadTrashOf, TRASH_DIR } from "./release.ts";

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
  // Not an effect but the release's catalog read (F2): a crash between it and the rename leaves release.trash with the
  // folder in place, and recover reads the catalog again.
  "offload.release.reread": "offload.release.trash",
  "offload.snapshot.discarded.appended": "offload.snapshot.discarded",
  "offload.diverged.appended": "offload.diverged",
  "offload.diverged.based": "offload.diverged",
  "offload.commit.appended": "offload.commit.start",
  "offload.release.renamed": "offload.release.trash",
  "offload.release.stub-placed": "offload.release.moved",
  "offload.release.registry-updated": "offload.release.moved",
  "offload.release.detached": "offload.release.delete",
} as const satisfies Record<string, OffloadStep>;
export type OffloadAfterEffect = keyof typeof OFFLOAD_AFTER_EFFECT;

/**
 * Pause seams for the race schedules (M2 Task 14, test/support/schedules.ts): points where a test stops one device
 * while another acts. They write no journal and are no crash rows; in a release build nothing pauses there (D67).
 * offload.head-checked is right after a head check that passed, before the event is appended; offload.committed is
 * the journal step; offload.release.reread is the last point before the folder's final check and its rename, where
 * the catalog is read again before release (Q16).
 */
export const OFFLOAD_PAUSE_SEAMS = [
  "offload.head-checked",
  "offload.committed",
  "offload.release.reread",
] as const;

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
    reaches: ["offload.diverged", "offload.diverged.appended", "offload.diverged.based"],
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
  "offload.snapshot.done": [...POLICY, "plan.fingerprint", "plan.fp", "plan.excluded", "attempts.0"],
  "offload.verified": [...POLICY, "plan.fingerprint", "plan.fp", "plan.excluded", "attempts.0", "verified"],
  "offload.diverged": [...POLICY, "verified", "event", "diverged"],
  "offload.commit.start": [...POLICY, "plan.fingerprint", "plan.fp", "plan.excluded", "verified", "event"],
  "offload.committed": [...POLICY, "plan.fingerprint", "plan.fp", "plan.excluded", "verified", "event"],
  "offload.release.trash": [
    ...POLICY,
    "plan.fingerprint",
    "plan.fp",
    "plan.excluded",
    "verified",
    "event",
    "trash",
  ],
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
  /**
   * --fork (D114): a copy whose base is behind the head is uploaded and kept as a fork at the commit (F1), leaving the
   * project conflicted, instead of being refused before the upload with catalog.head-moved.
   */
  fork?: boolean;
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
  /** Bytes the local copy still holds in the trash: the whole folder while it is kept or waits, else 0. */
  keptBytes: number;
  /** With keptBytes: what frees them, plainport gc once keepUntil has passed, or plainport recover. */
  freedBy?: string;
  /** The folder moved to `trash`: deleted (its detached delete has started), kept (keepLocalFor) or waiting (recover). */
  localCopy: "deleted" | "kept" | "waiting";
  /**
   * With localCopy deleted: the detached delete has started, nothing more (r3 #4). It checks the folder before it
   * deletes (D87); a refusal keeps it, and status, ls, gc and the start of the next command say why.
   */
  deleteStarted?: true;
  /** Absent when config says stub = false. */
  stub?: string;
  /** Where the folder is kept or waits to be deleted; absent when localCopy is deleted (D77). */
  trash?: string;
  /** keepLocalFor: the trash is kept until then. */
  keepUntil?: string;
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
    // A fingerprint of another kind (D53) is never equal to one of this kind, whatever its text.
    fp: plan.fp ?? 1,
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
  // An existing trash holder must be a real folder on the same volume too, or the rename fails after the commit.
  const holder = join(rootFolder, TRASH_DIR);
  try {
    const trash = await io.fs.lstat(holder);
    if (trash.kind !== "dir" || (await io.fs.stat(holder)).dev !== beside.dev)
      return fail(
        finding("fs.cross-volume", {
          message: `${holder} is ${trash.kind === "dir" ? "on another volume" : `a ${trash.kind}, not a folder`}, so ${folder} cannot be moved aside into it in one rename`,
          fix: `remove or rename ${shellWord(holder)} (plainport makes it again), then re-run`,
          paths: [holder],
        }),
      );
  } catch (error) {
    if (systemErrorCode(error) !== "ENOENT")
      return fail(
        finding("fs.unreadable", {
          message: `${holder} cannot be inspected (${systemErrorCode(error)}), so ${folder} was not offloaded`,
          fix: `check that you can read ${shellWord(holder)}, then re-run`,
          paths: [holder],
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

/**
 * lease.held when another device holds the project's lease and its onload is not behind this copy (leaseAhead): its
 * copy and this one now differ, and the first of the two offloaded becomes the head. Where that onload sits is read
 * from its event in the mirror the catalog read just brought up to the store. A warning only (Q17, D114).
 */
export const leaseHeld = async (
  project: CatalogProject | undefined,
  mirror: BlobStore,
  copy: { device: string; base: string | undefined; address: string },
): Promise<Finding | undefined> => {
  const held = project?.lease ?? null;
  if (held === null || held.device === copy.device) return undefined;
  const read = await eventAt(mirrorEventLog(mirror), held.event);
  const opened = read.ok && read.value !== null && "event" in read.value ? read.value.event : undefined;
  const over = opened?.type === "onloaded" ? (opened.over ?? opened.base) : undefined;
  const lease = leaseAhead(project, copy.device, copy.base, over);
  if (lease === undefined) return undefined;
  return finding("lease.held", {
    message: `${copy.address} is onloaded on device ${lease.device} since ${lease.at}, level with or further along than this copy; if this copy is offloaded first, that one becomes a fork when it is offloaded`,
    fix: "offload it on that device first if its copy should be the head",
  });
};

/**
 * The dry run's lease check (D114): lease.held as the real run would warn it, from the store's catalog, so a plan never
 * previews clean and then warns at its run. The plan needs no store, so this is best effort: a project this device
 * never registered has no lease to name, and a store or mirror that cannot be read leaves it unsaid, with a log line.
 */
export const previewLease = async (
  deps: Pick<
    OffloadDeps,
    "host" | "paths" | "device" | "env" | "loader" | "opener" | "openMirror" | "log" | "now"
  >,
  req: Pick<OffloadRequest, "project" | "store">,
): Promise<Finding | undefined> => {
  const { host, paths } = deps;
  const ref = req.project;
  const clock = (): Date => deps.now?.() ?? host.clock.now();
  const unsaid = (why: string) => {
    deps.log("info", `whether another device holds the lease of ${ref.address} was not checked: ${why}`);
    return undefined;
  };
  const registry = await readRegistry(host, paths);
  if (!registry.ok) return unsaid(registry.finding.message);
  const id =
    ref.id ??
    Object.entries(registry.value.projects).find(([, e]) => e.root === ref.root && e.path === ref.path)?.[0];
  if (id === undefined) return undefined;
  const loaded = await deps.loader.load({ env: deps.env, root: ref.root });
  if (!loaded.ok) return unsaid(loaded.finding.message);
  const name = req.store ?? loaded.value.config.roots[ref.root]?.store ?? loaded.value.config.defaultStore;
  if (name === undefined) return undefined;
  const opened = await openStore(host, {
    paths,
    env: deps.env,
    name,
    config: loaded.value.config,
    opener: deps.opener,
    now: clock,
  });
  if (!opened.ok) return unsaid(opened.finding.message);
  const mirror = await deps.openMirror(opened.value.id);
  if (!mirror.ok) return unsaid(mirror.finding.message);
  const read = await catalogReader({
    store: opened.value.blob,
    mirror: mirror.value,
    storeId: opened.value.id,
    storeName: opened.value.name,
    now: clock,
    ...(opened.value.catalog === undefined ? {} : { policy: opened.value.catalog }),
    report: (f) => deps.log("info", `${f.code}: ${f.message}`),
  })();
  if (!read.ok) return unsaid(read.finding.message);
  return leaseHeld(read.value.projects[id], mirror.value, {
    device: deps.device.id,
    base: registry.value.projects[id]?.base,
    address: ref.address,
  });
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
  // Long-expired plans go with a real run, never with a dry run, which writes only its plan file (N5).
  await prunePlans(io, paths, clock(), req.plan);

  const loaded = await deps.loader.load({ env: deps.env, root: ref.root });
  if (!loaded.ok) return loaded;
  // The local stores release never moves a folder holding (D83), read again right before the rename (F2).
  // A fresh, clean read: never the loader's last good copy (astra r2 finding 5).
  const stores = (): Promise<Result<ProtectedStore[]>> => freshStores(io, paths, deps.env);
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
    now: clock,
  });
  if (!opened.ok) return opened;
  const store: ConfiguredStore = opened.value;
  // A config assertion the measurement contradicts (D111) is said, and the measured value used.
  for (const f of store.findings ?? []) report(f);
  // Q2: an upgrade under way (its upgrade-intent marker stands) is waited out; this is the offload's first read of the
  // store, so one that cannot be reached fails here, before anything is uploaded.
  const upgrading = await refuseWhileUpgrading(store.blob, storeName, "offload");
  if (!upgrading.ok) return upgrading;

  // The project's ULID: the registry's, or a new one recorded there, under its lock, so two runs agree on it.
  const registered = await ensureRegistered(
    io,
    paths,
    { ...(ref.id === undefined ? {} : { id: ref.id }), root: ref.root, path: ref.path },
    () => ulid(clock().getTime()),
    clock().toISOString(),
  );
  if (!registered.ok) return registered;
  const projectId = registered.value.id;
  const base = registered.value.registry.projects[projectId]?.base;
  const storeIds = registered.value.registry.stores ?? {};

  const gate = { io, paths, clock, log: deps.log };
  // Nesting by effective folders (D53 revised): a project placed inside this folder with --to counts.
  const folders = await registeredFolders(io, paths, deps.env);
  if (!folders.ok) return folders;
  const related = await nestedProjects(io, paths, folders.value, { id: projectId, folder });
  if (!related.ok) return related;
  const nested = related.value;
  return withProjectLock(gate, { id: projectId, address: ref.address }, (lock) => offloadLocked(lock), {
    related: nested,
  });

  async function offloadLocked(lock: ProjectLock): Promise<Result<OffloadOutcome>> {
    // A registered project inside the folder that is here would be offloaded inside this one (D53).
    const inside = await nestedHere(io, nested);
    if (!inside.ok) return inside;
    const [first] = inside.value;
    if (first !== undefined) {
      return fail(
        finding("project.nested", {
          message: `${ref.address} holds ${inside.value.map((n) => n.address).join(", ")}, ${
            inside.value.length === 1 ? "a registered project" : "registered projects"
          } of its own, so it was not offloaded; nothing was uploaded`,
          fix: `offload the inner project first (plainport offload ${shellWord(first.address)} --yes), or unregister it`,
          paths: inside.value.map((n) => n.dir),
        }),
      );
    }
    const mirror = await deps.openMirror(store.id);
    if (!mirror.ok) return mirror;
    const catalog = catalogReader({
      store: store.blob,
      mirror: mirror.value,
      storeId: store.id,
      storeName: store.name,
      now: clock,
      ...(store.catalog === undefined ? {} : { policy: store.catalog }),
      report,
    });
    const before = await catalog();
    if (!before.ok) return before;
    // The project's home store (Q12): a copy whose base this store's catalog does not name came from another store's
    // history, which this device's mirrors name (an offline store by its mirror).
    const home =
      base === undefined || namesSnapshot(before.value, projectId, base)
        ? undefined
        : {
            store: store.name,
            holder: await storeHolding({
              stores: storeIds,
              exclude: store.id,
              id: projectId,
              snapshot: base,
              openMirror: deps.openMirror,
            }),
          };
    const early = headCheck(before.value, projectId, base, ref.address, home);
    // A copy on a line a resolution rejected is live work (D103), and --fork asks for a copy behind the head to be
    // kept (D114): either is uploaded and kept as a fork at the commit (F1), so it conflicts and never vanishes,
    // instead of being refused here with nothing uploaded.
    const forkAtCommit =
      early.kind === "moved" &&
      (req.fork === true ||
        (base !== undefined && before.value.projects[projectId]?.rejected.includes(base) === true));
    if (early.kind !== "ok" && !forkAtCommit) return fail(early.finding);
    // Another device's working copy, onloaded further along the chain (Q17: advisory): a warning, never a refusal;
    // onload.leases = "strict" governs onload only (D114).
    const lease = await leaseHeld(before.value.projects[projectId], mirror.value, {
      device: device.id,
      base,
      address: ref.address,
    });
    if (lease !== undefined) report(lease);
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
    const events = storeEventLog(store.blob, store.catalog);

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

    /**
     * plan.stale (exit 6), the fresh plan saved and carried as the error's data (D14, D38). `current` is a plan made
     * from the folder as it is now, when there is one; otherwise the folder is planned again.
     */
    const stale = async (message: string, uploaded = false, current?: PreparedOffload): Promise<Failure> => {
      const fresh = current === undefined ? await plan(false) : ok(current);
      if (!fresh.ok) return signal?.aborted ? cancelled() : fresh;
      let saved = planBlocker(fresh.value.plan) === undefined;
      if (saved) {
        try {
          await savePlan(io, paths, fresh.value.plan);
        } catch (error) {
          assertSystemError(error);
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
          fix: !saved
            ? `plainport offload ${shellWord(ref.address)} --dry-run, fix what it reports, then approve the new plan`
            : req.plan === undefined
              ? `re-run the same command to offload the folder as it is now (plainport offload ${shellWord(ref.address)} --yes), or review the fresh plan (it is this error's data) and approve it: ${planCommand(fresh.value.plan)}`
              : `review the fresh plan (it is this error's data), then approve it: ${planCommand(fresh.value.plan)}`,
        }),
        fresh.value.plan,
        6,
      );
    };

    /** rootMode: the folder's own mode, read once before the snapshot, for its tag and its event alike (Q5 ii). */
    type Verified = {
      prepared: PreparedOffload;
      snapshot: string;
      files: number;
      bytes: number;
      rootMode?: number;
    };

    /** Plans, snapshots and verifies, once more when the folder changed during the upload (DESIGN steps 3–7). */
    const snapshotVerified = async (approved: Plan | undefined): Promise<Result<Verified>> => {
      const allow = new Set(req.allow ?? []);
      /** Findings streamed so far: a retry streams only what is new in its plan. */
      const reported = new Set<string>();
      const parent = base === undefined ? undefined : before.value.projects[projectId]?.snapshots[base];
      let previous = parent === undefined ? undefined : storedHere(parent.stored);
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
            prepared,
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
          plan: {
            id: current.id,
            fingerprint: current.fingerprint,
            fp: FINGERPRINT_VERSION,
            excluded: current.strip.map((s) => s.path),
          },
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
        const stripped = new Set(current.strip.map((s) => s.path));
        if (includedFingerprint(right.value, stripped) !== current.fingerprint)
          return stale("the folder changed between the plan and the snapshot");
        const excluded = new Set(stripped);
        for (const s of prepared.tree.skipped) if (!isExcluded(excluded, s.path)) excluded.add(s.path);
        // The folder's own mode, which the snapshot does not hold (D55), read once: the tag (Q5 ii) and the event both
        // record this value, so an onload restores the same mode whichever of them it reads. A chmod during the upload
        // is not part of this snapshot, as an edit after verification is not.
        let folderMode: number | undefined;
        try {
          folderMode = (await io.fs.lstat(folder)).mode;
        } catch (error) {
          assertSystemError(error);
          deps.log(
            "warn",
            `the mode of ${folder} could not be read; an onload gives the folder a new folder's mode`,
          );
        }
        const taken = await takeSnapshot({
          saga,
          engine: store.engine,
          events,
          storedKey: storedKey(store, before.value.format),
          device: device.id,
          clock,
          log: deps.log,
          excludes: [...excluded].sort(),
          ...(previous === undefined ? {} : { parent: previous }),
          ...(folderMode === undefined ? {} : { rootMode: folderMode }),
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
          tree: { fingerprint: current.fingerprint, manifest: prepared.tree.manifest },
          stripped,
          excluded,
          ctx,
        });
        if (!checked.ok) return signal?.aborted ? cancelled() : checked;
        if (!checked.value.changed)
          return ok({
            prepared,
            snapshot: taken.value,
            ...checked.value.totals,
            ...(folderMode === undefined ? {} : { rootMode: folderMode }),
          });
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
      const head = headCheck(current.value, projectId, base, ref.address, home);
      if (head.kind === "incomplete") return fail(head.finding);
      // The folder's own mode as the snapshot's tag records it (D55, Q5 ii): onload gives it back.
      const { rootMode } = verified;
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
        stored: { [storedKey(store, current.value.format)]: verified.snapshot },
        ...(rootMode === undefined ? {} : { rootMode }),
        stats: {
          files: verified.files,
          bytes: verified.bytes,
          strippedBytes: verified.prepared.plan.strip.reduce((sum, s) => sum + s.bytes, 0),
          stripped: verified.prepared.plan.strip.length,
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
        // F1: the folder stays, on its own snapshot: the next offload builds on it, and resolve --keep names it.
        // The registry's base must name the fork, or resolve --keep refuses this copy: a write that fails keeps the
        // journal at diverged, and recover writes it again.
        const based = await recordBase({ host, paths }, saga.journal);
        if (!based.ok) return saga.keep(based);
        saga.after("offload.diverged.based");
        const conflict: OffloadConflict = {
          op,
          exitCode: 8,
          kind: "fork",
          project: ref.address,
          snapshot: op,
          store: store.name,
          stored: verified.snapshot,
        };
        // The fork is made: the fix is what to do with it, not --fork again.
        const made = {
          ...head.finding,
          fix: `this folder stays on its own snapshot ${op}, kept as a fork; plainport compare ${shellWord(ref.address)} writes the other copy into its repository beside it`,
        };
        return failWith(made, conflict, 8);
      }
      host.faultAt("offload.head-checked");
      // lock.ts's known limit: a run that lost its lock to a breaker never commits.
      if (!(await lock.stillHeld()))
        return fail(
          finding("project.locked", {
            message: `the lock on ${ref.address} was taken over by another run during the offload; nothing was committed and nothing local was deleted`,
            fix: "wait for the other plainport run to finish, then re-run",
          }),
        );
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
        {
          host,
          paths,
          saga,
          clock,
          log: deps.log,
          stillHeld: lock.stillHeld,
          env: deps.env,
          stores,
          store: { name: store.name, semantics: store.blob.semantics() },
          // F2: the catalog read fresh again right before the rename (Q16).
          reread: catalog,
        },
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
        keptBytes: freed ? 0 : verified.prepared.tree.bytes,
        ...(freed ? {} : { freedBy: keepUntil === undefined ? "plainport recover" : "plainport gc" }),
        localCopy: freed ? "deleted" : keepUntil === undefined ? "waiting" : "kept",
        ...(freed ? { deleteStarted: true as const } : {}),
        ...(stub === undefined ? {} : { stub }),
        // A deleted local copy's trash is already going, so it is not named (D77).
        ...(freed ? {} : { trash }),
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
  }
};

/** The registered projects inside `folder` (D53) whose own folder is here. */
const nestedHere = async (
  io: LocalIo,
  nested: readonly Nested[],
): Promise<Result<{ address: string; dir: string }[]>> => {
  const found: { address: string; dir: string }[] = [];
  for (const n of nested) {
    // Inside it, or at the very same folder (R2): either way its files would go with this one.
    if (!n.inside && !n.same) continue;
    const dir = n.folder;
    try {
      if ((await io.fs.lstat(dir)).kind === "dir") found.push({ address: n.address, dir });
    } catch (error) {
      const code = systemErrorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return fail(
        finding("fs.unreadable", {
          message: `${dir} cannot be inspected (${code}), so whether ${n.address} is here is unknown; nothing was offloaded`,
          fix: `check that you can read ${shellWord(dir)}, then re-run`,
          paths: [dir],
        }),
      );
    }
  }
  return ok(found);
};
