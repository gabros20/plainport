// The onload saga (ADR-0008; DESIGN.md "Onload process", "Project lifecycle"): resolve and lock, preflight, restore
// into `<root>/.plainport-staging/<op>/`, verify the staged tree against the snapshot's listing, swap it into place
// with one rename, remove the stub and append the onloaded event (which opens the lease, D43), then the toolchain
// and the frozen install. Onload never merges into an existing folder, and a failed install never undoes a good
// restore: the project is then restored-unhydrated, exit 10, and `plainport hydrate` retries (saga/hydrate.ts).
//
// Until offload's trash is deleted (keepLocalFor holds it), onloading the same head renames that folder back instead
// of restoring it, but only while its fingerprint is still the one its offload verified (D51), and never while a
// detached delete may be running in it (a trash with no deadline).
//
// The journal (journal/<op>.json) is written at every step in ONLOAD_STEPS, each followed by the host's crash seam;
// every side effect is followed by a seam that writes no journal (ONLOAD_AFTER_EFFECT, D52). The commit is the swap's
// rename: before it nothing outside the staging folder has changed, so a failure removes the staging folder and the
// journal; after it every step goes forward. What each step leaves for `plainport recover` (Task 14):
//
//   onload.begin .. onload.verified       roll back: remove `staging` (absent in reuse mode, where nothing moved yet),
//                                         then the journal; the stub still names the project. A rerun of the same
//                                         onload takes the journal over instead (DESIGN step 3): it restores into the
//                                         same staging folder with --overwrite if-changed, so files already written
//                                         are skipped
//   onload.swap.start                     the rename may have happened (a lost write, D24): if `project.dir` stands
//                                         and the source (`staging`, or `reuse.folder`) is gone, go on as from
//                                         onload.swapped; otherwise roll back as above
//   onload.swapped                        the folder is in place: give it `rootMode` if set (D55), remove `stub`
//                                         if it is still this project's (in reuse mode, the trash folder and the
//                                         offload journal `reuse.op` first),
//                                         then go on as from onload.commit.start with a new event id
//   onload.commit.start                   the onloaded event's id (`event`) is journaled: append it if the store lacks
//                                         it (base `snapshot`, over `over`), then go on as from onload.committed
//   onload.committed                      record the project in registry.json (base `over`, onloadedAt, `override`
//                                         when set, unhydrated), then remove the journal; the dependencies are not
//                                         installed, which `plainport hydrate` does
//
// ONLOAD_RECOVERY_NEEDS lists, step by step, the journal fields those rules read.
//
// An injected fault (InjectedFault) is a simulated crash: nothing here catches it.

import { dirname, join, resolve } from "node:path";
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
import { type CatalogEvent, CatalogEventSchema } from "../catalog/events.ts";
import type { CatalogProject } from "../catalog/fold.ts";
import { catalogReader } from "../catalog/head.ts";
import { appendEvent, STORE_EVENTS_PREFIX, storeEventLog } from "../catalog/log.ts";
import { resolveRootId } from "../catalog/roots.ts";
import type { ConfigLoader } from "../config/load.ts";
import type { Device } from "../device.ts";
import { assertSystemError, type LocalIo, systemErrorCode } from "../io.ts";
import {
  type Journal,
  type OffloadJournal,
  type OnloadJournal,
  readJournals,
  removeJournal,
} from "../journal/index.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { EcosystemPlugin } from "../ports/ecosystem.ts";
import type { RunContext } from "../ports/engine.ts";
import type { HostPorts } from "../ports/host.ts";
import type { StoreOpener } from "../ports/store.ts";
import { type ProjectRegistry, readRegistry, updateRegistry } from "../registry.ts";
import type { ProjectRef } from "../roots/address.ts";
import { FINGERPRINT_VERSION, includedFingerprint, scanTree } from "../scan/walk.ts";
import { type ConfiguredStore, openStore } from "../store.ts";
import { readStub, STUB_SUFFIX } from "../stub.ts";
import { ulid } from "../ulid.ts";
import { type HydrateReport, hydrateProject, markHydrated } from "./hydrate.ts";
import { openSaga, runSaga, type Saga, withFix, writeFailed } from "./journaled.ts";
import { nestedProjects, type ProjectLock, withProjectLock } from "./project-gate.ts";
import { offloadTrashOf, rootFolderOf } from "./release.ts";
import { verifyListing } from "./verify.ts";

/** Every journal step, in the order a run reaches them; the crash matrix enumerates its rows from this list. */
export const ONLOAD_STEPS = [
  "onload.begin",
  "onload.restore.start",
  "onload.restored",
  "onload.verified",
  "onload.swap.start",
  "onload.swapped",
  "onload.commit.start",
  "onload.committed",
] as const;
export type OnloadStep = (typeof ONLOAD_STEPS)[number];

/**
 * Crash seams right after a side effect, with no journal write (D52): a fault at one leaves the effect done and the
 * journal at the step named here, as a lost journal write would.
 */
export const ONLOAD_AFTER_EFFECT = {
  "onload.swap.renamed": "onload.swap.start",
  "onload.reuse.cleared": "onload.swap.start",
  "onload.stub.removed": "onload.swapped",
  "onload.commit.appended": "onload.commit.start",
  "onload.registry-updated": "onload.committed",
} as const satisfies Record<string, OnloadStep>;
export type OnloadAfterEffect = keyof typeof ONLOAD_AFTER_EFFECT;

/** The branches a plain run does not take, and what makes a run take each (see OFFLOAD_BRANCHES). */
export const ONLOAD_BRANCHES = {
  reuse: {
    when: "the head's folder still waits in its offload's trash (keepLocalFor), unchanged since it was verified",
    skips: ["onload.restore.start", "onload.restored", "onload.verified"],
    reaches: ["onload.reuse.cleared"],
  },
  resume: {
    when: "an earlier onload of the same snapshot to the same folder stopped before the swap",
    reaches: ["onload.begin", "onload.restore.start", "onload.restored", "onload.verified"],
  },
  stub: { when: "the project's stub stands where it was offloaded", reaches: ["onload.stub.removed"] },
} as const;

/** The steps before the swap: a journal at one of them changed nothing outside its staging folder. */
const BEFORE_SWAP: ReadonlySet<string> = new Set([
  "onload.begin",
  "onload.restore.start",
  "onload.restored",
  "onload.verified",
]);

const IDENTITY = [
  "op",
  "project.id",
  "project.dir",
  "project.path",
  "project.rootId",
  "store.name",
  "store.id",
  "snapshot",
  "stored",
  "over",
];

/** The journal fields (dotted paths) recovery reads at each step, by the table in the file comment. */
export const ONLOAD_RECOVERY_NEEDS: Readonly<Record<OnloadStep, readonly string[]>> = {
  "onload.begin": IDENTITY,
  "onload.restore.start": [...IDENTITY, "staging"],
  "onload.restored": [...IDENTITY, "staging"],
  "onload.verified": [...IDENTITY, "staging"],
  "onload.swap.start": IDENTITY,
  "onload.swapped": IDENTITY,
  "onload.commit.start": [...IDENTITY, "event"],
  "onload.committed": [...IDENTITY, "event"],
};

export const STAGING_DIR = ".plainport-staging";

export interface OnloadDeps {
  host: HostPorts;
  /** The ecosystem plugins: detection, the toolchain and the frozen installs. */
  plugins: readonly EcosystemPlugin[];
  paths: PlainportPaths;
  device: Device;
  /** The environment: config variables, the store's password reference, and what the installs run with. */
  env: Env;
  loader: ConfigLoader;
  opener: StoreOpener;
  /** This device's event mirror for the store with this id (blob-fs's openEventMirror). */
  openMirror(storeId: string): Promise<Result<BlobStore>>;
  emit(event: StreamEvent): void;
  log(level: "debug" | "info" | "warn", message: string): void;
  /** Aborted by Ctrl-C: the saga stops at its next safe point before the swap. */
  signal?: AbortSignal;
  now?: () => Date;
}

export interface OnloadRequest {
  /** The resolved project: a name, an address or its stub. */
  project: ProjectRef;
  /** --snapshot: an older snapshot instead of the head; the lease opens all the same (D43). */
  snapshot?: string;
  /** --to: an absolute folder to land in instead of the root's place for the project. */
  to?: string;
  /** --no-hydrate: false restores without installing. Default true (onload.hydrate in config). */
  hydrate?: boolean;
  /** --store: overrides the stub's, the root's and the default store. */
  store?: string;
}

export type OnloadOutcome = {
  op: string;
  /** 10: restored, not hydrated (the install failed); the outcome is then the failure's data (D14). */
  exitCode: 0 | 10;
  /** root:path. */
  project: string;
  /** The snapshot restored. */
  snapshot: string;
  /** The head it was written over, the copy's next base (D43). */
  over: string;
  store: string;
  /** Where the project now is. */
  dir: string;
  /** restore: restored from the store; reuse: the same head's folder renamed back from the trash. */
  restored: "restore" | "reuse";
  /** Files and bytes the snapshot holds. */
  files: number;
  bytes: number;
  hydrate: HydrateReport;
};

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What is at the path itself: its kind, or undefined when nothing is. */
const kindAt = async (io: LocalIo, path: string): Promise<string | undefined> => {
  try {
    return (await io.fs.lstat(path)).kind;
  } catch (error) {
    const code = systemErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
};

/** The nearest folder at or above `path` that exists. */
const nearestExisting = async (io: LocalIo, path: string): Promise<string> => {
  let at = path;
  while ((await kindAt(io, at)) === undefined && dirname(at) !== at) at = dirname(at);
  return at;
};

const unreadable = (path: string, error: unknown, what: string): Failure =>
  fail(
    finding("fs.unreadable", {
      message: `${path} cannot be inspected (${systemErrorCode(error)}), so ${what}`,
      fix: `check that you can read ${shellWord(path)} and the folder that holds it, then re-run`,
      paths: [path],
    }),
  );

/**
 * Whether the volume holding `folder` ignores case: a probe file made there is looked up with its name upper-cased.
 * (roots/canonical.ts probes a path's own name in its parent, which at a mount point is the volume around it.)
 */
const ignoresCase = async (io: LocalIo, folder: string, op: string): Promise<Result<boolean>> => {
  const probe = join(folder, `.plainport-case-${op.toLowerCase()}`);
  try {
    await io.fs.writeBytesDurable(probe, new Uint8Array(), { exclusive: true });
  } catch (error) {
    return unreadable(folder, error, "whether its volume ignores case is unknown; nothing was restored");
  }
  try {
    return ok((await kindAt(io, join(folder, `.PLAINPORT-CASE-${op.toUpperCase()}`))) !== undefined);
  } catch (error) {
    return unreadable(folder, error, "whether its volume ignores case is unknown; nothing was restored");
  } finally {
    try {
      await io.fs.unlink(probe);
    } catch (error) {
      assertSystemError(error);
    }
  }
};

/** Folds a name the way a case-insensitive volume compares it: Unicode composition and case. */
const fold = (path: string): string => path.normalize("NFC").toLowerCase();

/** Runs the onload; see the file comment. A failure before the swap changed nothing outside its staging folder. */
export const runOnload = async (deps: OnloadDeps, req: OnloadRequest): Promise<Result<OnloadOutcome>> => {
  const { host, paths, device, signal } = deps;
  const io: LocalIo = host;
  const clock = (): Date => deps.now?.() ?? host.clock.now();
  const now = () => clock().toISOString();
  const ref = req.project;
  let op = ulid(clock().getTime());
  const phase = (name: Phase, status: "start" | "end" | "skip") =>
    deps.emit({ type: "phase", op, phase: name, status });
  const report = (f: Finding) => deps.emit({ type: "finding", op, finding: f });
  const cancelled = (): Failure =>
    fail(
      finding("operation.cancelled", {
        message: `the onload of ${ref.address} was stopped before it changed anything; the stub stays`,
        fix: "re-run the onload when you are ready",
      }),
    );

  phase("resolve", "start");
  const requested = req.to === undefined ? ref.dir : resolve(req.to);
  if (requested === undefined) {
    return fail(
      finding("root.unbound", {
        message: `root ${ref.root} has no folder on this device, so ${ref.address} has nowhere to land`,
        fix: `plainport root bind ${ref.root} <path>, or onload it elsewhere: plainport onload ${shellWord(ref.address)} --to <path>`,
      }),
    );
  }
  const landing: string = requested;
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
  const opened = await openStore(io, { paths, env: deps.env, name: storeName, config, opener: deps.opener });
  if (!opened.ok) return opened;
  const store: ConfiguredStore = opened.value;
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

  const registered = await readRegistry(io, paths);
  if (!registered.ok) return registered;
  // The project's ULID: the stub's or this device's registry's, else the catalog's for its root and path.
  let projectId =
    ref.id ??
    Object.entries(registered.value.projects).find(
      ([, e]) => e.root === ref.root && e.path === ref.path,
    )?.[0];
  if (projectId === undefined) {
    const read = await catalog();
    if (!read.ok) return read;
    const rootId = resolveRootId(registered.value, read.value, ref.root)?.id;
    projectId = Object.entries(read.value.projects).find(
      ([, p]) => p.root === rootId && p.path === ref.path,
    )?.[0];
    if (projectId === undefined) {
      return fail(
        finding("project.not-found", {
          message: `store ${store.name} holds no snapshot of ${ref.address}`,
          fix: "check the address (plainport ls lists the projects), or name the store that holds it with --store",
        }),
      );
    }
  }
  const id = projectId;
  const nested = nestedProjects(registered.value, { id, root: ref.root, path: ref.path });
  const gate = { io, paths, clock, log: deps.log };
  return withProjectLock(gate, { id, address: ref.address }, (lock, resumed) => onloadLocked(lock, resumed), {
    related: nested,
    // An onload that stopped before its swap is taken over, never refused (DESIGN step 3).
    resume: (j) => j.kind === "onload" && BEFORE_SWAP.has(j.step),
  });

  async function onloadLocked(lock: ProjectLock, open: Journal | undefined): Promise<Result<OnloadOutcome>> {
    const state = await catalog();
    if (!state.ok) return state;
    const project = state.value.projects[id];
    if (project === undefined) {
      return fail(
        finding("project.not-found", {
          message: `store ${store.name} holds no snapshot of ${ref.address}`,
          fix: "check the address (plainport ls lists the projects), or name the store that holds it with --store",
        }),
      );
    }
    const head = headOf(project);
    if (!head.ok) return head;
    const over = head.value;
    const snapshot = req.snapshot ?? over;
    const made = project.snapshots[snapshot];
    if (made === undefined) {
      return fail(
        finding("snapshot.not-found", {
          message: `the catalog holds no snapshot ${snapshot} of ${ref.address}${project.discarded.includes(snapshot) ? " (it was discarded: restic could not read every file)" : ""}`,
          fix: `plainport onload ${shellWord(ref.address)} restores the head (${over})`,
        }),
      );
    }
    const stored = made.stored[store.name];
    if (stored === undefined) {
      return fail(
        finding("snapshot.not-found", {
          message: `store ${store.name} holds no copy of snapshot ${snapshot} of ${ref.address}; ${Object.keys(made.stored).join(", ")} ${Object.keys(made.stored).length === 1 ? "does" : "do"}`,
          fix: `plainport onload ${shellWord(ref.address)} --store ${shellWord(Object.keys(made.stored)[0] ?? "<name>")}`,
        }),
      );
    }

    // An earlier onload that stopped before its swap: taken over when it restores the same snapshot to the same
    // folder, else rolled back now (its staging folder and journal), since nothing else of it changed anything.
    let resumed = open?.kind === "onload" ? open : undefined;
    if (resumed !== undefined && (resumed.snapshot !== snapshot || resumed.project.dir !== landing)) {
      const dropped = await dropStaging(resumed);
      if (!dropped.ok) return dropped;
      resumed = undefined;
    }
    if (resumed !== undefined) op = resumed.op;
    phase("resolve", "end");

    phase("preflight", "start");
    const lease = project.lease;
    if (lease !== null && lease.device !== device.id) {
      const held = finding("lease.held", {
        message: `${ref.address} is onloaded on device ${lease.device} since ${lease.at}; a second working copy here can diverge from it, and the first of the two to offload wins (the other becomes a fork)`,
        fix:
          config.onload.leases === "strict"
            ? `offload it on that device first, or set onload.leases = "warn" to onload it here anyway`
            : `offload it on that device first, or keep in mind that two copies now exist`,
      });
      if (config.onload.leases === "strict") return fail({ ...held, severity: "block" }, 8);
      report(held);
    }

    const occupied = await occupiedBy(project, over);
    if (occupied !== undefined) return occupied;
    const stubPath = ref.dir === undefined ? undefined : `${ref.dir}${STUB_SUFFIX}`;
    const rootFolder = req.to === undefined ? rootFolderOf(ref.path, landing) : dirname(landing);
    const placed = await landingChecks(rootFolder);
    if (!placed.ok) return placed;
    const ctx: RunContext = {
      op,
      ...(signal === undefined ? {} : { signal }),
      emit: (e) => (e.type === "log" ? deps.log(e.level, e.message) : deps.emit(e)),
    };

    // The same head's folder, still in its offload's trash: renamed back rather than restored.
    const reuse =
      resumed === undefined && snapshot === over && req.to === undefined
        ? await reusable(snapshot, landing)
        : undefined;
    let files = 0;
    let bytes = 0;
    let rootMode: number | undefined;
    if (reuse === undefined) {
      const listed = await listSnapshot(stored, ctx, made.event, placed.value);
      if (!listed.ok) return signal?.aborted ? cancelled() : listed;
      files = listed.value.files;
      bytes = listed.value.bytes;
      rootMode = listed.value.rootMode;
    }
    phase("preflight", "end");
    if (signal?.aborted) return cancelled();

    const staging = join(rootFolder, STAGING_DIR, op);
    const startedAt = now();
    const journal: OnloadJournal = resumed ?? {
      v: 1,
      op,
      kind: "onload",
      step: "onload.begin",
      startedAt,
      updatedAt: startedAt,
      pid: io.proc.pid,
      host: io.proc.hostname(),
      project: {
        id,
        address: ref.address,
        root: ref.root,
        rootId: project.root,
        path: ref.path,
        dir: landing,
      },
      store: { name: store.name, id: store.id },
      snapshot,
      stored,
      over,
      ...(reuse === undefined ? { staging } : { reuse }),
      ...(req.to === undefined ? {} : { override: true as const }),
      ...(stubPath === undefined ? {} : { stub: stubPath }),
      ...(rootMode === undefined ? {} : { rootMode }),
      history: [],
    };
    if (resumed !== undefined) Object.assign(journal, { pid: io.proc.pid, host: io.proc.hostname() });
    const saga = openSaga<OnloadJournal, OnloadStep>(
      { io, paths, faultAt: (point) => host.faultAt(point), clock, log: deps.log },
      journal,
    );

    const result = await runSaga(saga, async (): Promise<Result<OnloadOutcome>> => {
      const begun = await saga.step("onload.begin");
      if (!begun.ok) return begun;

      if (journal.reuse === undefined) {
        const restored = await restoreAndVerify(saga, ctx, resumed !== undefined);
        if (!restored.ok) return abandon(saga, restored);
        if (signal?.aborted) return abandon(saga, cancelled());
      }
      return swapAndCommit(saga, lock, files, bytes);
    });
    if (!result.ok) return result;
    return hydrate(result.value);
  }

  /** The head onload restores over; catalog.incomplete or catalog.head-moved when it has none (D44). */
  function headOf(project: CatalogProject): Result<string> {
    if (project.missing.length > 0) {
      return fail(
        finding("catalog.incomplete", {
          message: `the catalog names ${plural(project.missing.length, "snapshot")} of ${ref.address} it does not hold (${project.missing.join(", ")}), so its head is unknown; nothing was restored`,
          fix: "connect the store that holds them (plainport store replicate syncs them), or run plainport doctor",
        }),
      );
    }
    if (project.conflicts.length > 0 || project.head === null) {
      return fail(
        finding("catalog.head-moved", {
          message: `${ref.address} is conflicted in the catalog: two copies were offloaded from the same snapshot (${project.conflicts.map((c) => c.join(" and ")).join("; ")}); nothing was restored`,
          fix: `plainport resolve ${shellWord(ref.address)} settles which copy wins (M2); plainport restore ${shellWord(ref.address)} --snapshot <id> --to <path> reads either side by side`,
        }),
      );
    }
    return ok(project.head);
  }

  /** path.occupied when anything stands where the project would land (DESIGN: it never merges). */
  async function occupiedBy(project: CatalogProject, over: string): Promise<Failure | undefined> {
    const target = landing;
    let there: string | undefined;
    try {
      there = await kindAt(io, target);
    } catch (error) {
      return unreadable(target, error, "whether the project can land there is unknown; nothing was restored");
    }
    if (there !== undefined) {
      const entry = registered.ok ? registered.value.projects[id] : undefined;
      let stubbed = false;
      try {
        stubbed = (await kindAt(io, `${target}${STUB_SUFFIX}`)) !== undefined;
      } catch (error) {
        assertSystemError(error);
      }
      // offload.diverged-after-commit (D52): the folder stands with no stub while the catalog says shelved; it is
      // this project's own working copy, ahead of (or at) its head.
      // This project's own copy here, by registry.json: its base is a snapshot of it and nothing stubs it.
      const ours =
        target === ref.dir &&
        there === "dir" &&
        !stubbed &&
        entry !== undefined &&
        entry.base !== undefined &&
        (entry.base === over || project.snapshots[entry.base] !== undefined);
      // Shelved in the catalog, yet here: offload.diverged-after-commit kept it (D52). Otherwise it is onloaded here.
      const kept = ours && project.status === "shelved";
      return fail(
        finding("path.occupied", {
          message: kept
            ? `${target} is this project's own working copy, kept when its offload was committed as snapshot ${entry?.base} after the folder changed (offload.diverged-after-commit); onload never merges into it`
            : ours
              ? `${ref.address} is already onloaded here, at ${target}; onload never merges into it`
              : `${target} already exists (a ${there}), so ${ref.address} was not onloaded there; onload never merges into an existing folder`,
          fix: kept
            ? `keep working in ${shellWord(target)}; the next offload builds on snapshot ${entry?.base}. For a second copy: plainport onload ${shellWord(ref.address)} --to <path>`
            : ours
              ? `work in ${shellWord(target)}; plainport offload ${shellWord(ref.address)} --yes shelves it`
              : `move ${shellWord(target)} aside, or onload elsewhere: plainport onload ${shellWord(ref.address)} --to <path>`,
          paths: [target],
        }),
      );
    }
    // --to while the project's folder stands at its place: one working copy per device.
    if (req.to !== undefined && ref.dir !== undefined && ref.dir !== target) {
      try {
        if ((await kindAt(io, ref.dir)) === "dir") {
          return fail(
            finding("path.occupied", {
              message: `${ref.address} is already here at ${ref.dir}, so it was not onloaded a second time at ${target}`,
              fix: `work in ${shellWord(ref.dir)}, or offload it first (plainport offload ${shellWord(ref.address)} --yes)`,
              paths: [ref.dir],
            }),
          );
        }
      } catch (error) {
        return unreadable(
          ref.dir,
          error,
          "whether the project is already here is unknown; nothing was restored",
        );
      }
    }
    return undefined;
  }

  /**
   * The landing folder's surroundings: the root's folder exists and is writable, and the nearest folder above the
   * landing place is on its volume (staging is renamed into place in one step). The nearest existing folder.
   */
  async function landingChecks(rootFolder: string): Promise<Result<string>> {
    const target = landing;
    let rootKind: string | undefined;
    let nearest: string;
    try {
      rootKind = await kindAt(io, rootFolder);
      nearest = await nearestExisting(io, dirname(target));
    } catch (error) {
      return unreadable(rootFolder, error, "the project could not be onloaded there");
    }
    if (rootKind !== "dir") {
      return fail(
        finding("root.path-missing", {
          message: `${rootFolder}, where ${ref.address} lands, does not exist or is not a folder`,
          fix: `create it (mkdir -p ${shellWord(rootFolder)}) or mount its volume, then re-run`,
          paths: [rootFolder],
        }),
      );
    }
    if (!(await io.fs.writable(nearest))) {
      return fail(
        finding("root.not-writable", {
          message: `plainport cannot write in ${nearest}, so ${ref.address} cannot land at ${target}`,
          fix: `make ${shellWord(nearest)} writable (chmod u+w), or onload elsewhere with --to <path>`,
          paths: [nearest],
        }),
      );
    }
    try {
      const [a, b] = await Promise.all([io.fs.stat(rootFolder), io.fs.stat(nearest)]);
      if (a.dev !== b.dev) {
        return fail(
          finding("fs.cross-volume", {
            message: `${nearest} is on another volume than ${rootFolder}, so the restored folder cannot be moved from ${join(rootFolder, STAGING_DIR)} into place in one rename`,
            fix: "onload to a folder on the root's own volume, or use --to with a folder on the other volume",
            paths: [nearest],
          }),
        );
      }
    } catch (error) {
      return unreadable(nearest, error, "the project could not be onloaded there");
    }
    return ok(nearest);
  }

  /**
   * The trash folder of the offload that made `snapshot`, when it can be renamed back: its trash is held by
   * keepLocalFor (so no detached delete runs in it) and it still has the fingerprint that offload verified (D51).
   */
  async function reusable(
    snapshot: string,
    target: string,
  ): Promise<{ op: string; folder: string } | undefined> {
    let journals: Awaited<ReturnType<typeof readJournals>>;
    try {
      journals = await readJournals(io, paths);
    } catch (error) {
      assertSystemError(error);
      return undefined;
    }
    const offload = journals.journals.find(
      (j): j is OffloadJournal =>
        j.kind === "offload" &&
        j.op === snapshot &&
        j.project.id === id &&
        j.project.dir === target &&
        j.step === "offload.release.delete" &&
        j.keepUntil !== undefined,
    );
    if (offload === undefined || offload.plan?.fp !== FINGERPRINT_VERSION) return undefined;
    const folder = join(offloadTrashOf(offload), target.slice(dirname(target).length + 1));
    const scanned = await scanTree(io.fs, folder);
    if (!scanned.ok) return undefined;
    const same =
      includedFingerprint(scanned.value, new Set(offload.plan.excluded ?? [])) === offload.plan.fingerprint;
    if (!same) {
      deps.log(
        "info",
        `${folder} changed since its offload verified it, so it is left for its own deadline and the snapshot is restored`,
      );
      return undefined;
    }
    return { op: offload.op, folder };
  }

  /**
   * Reads the snapshot's listing once before anything is written: its totals, names that differ only by case
   * (fs.case-collision on a case-insensitive volume) and the space the restore needs (fs.no-space).
   */
  async function listSnapshot(
    stored: string,
    ctx: RunContext,
    event: string,
    nearest: string,
  ): Promise<Result<{ files: number; bytes: number; rootMode?: number }>> {
    let files = 0;
    let bytes = 0;
    const byFold = new Map<string, string[]>();
    const listed = await store.engine.entries(
      stored,
      (entry) => {
        if (entry.type === "file") {
          files++;
          bytes += entry.size ?? 0;
        }
        const key = fold(entry.path);
        const same = byFold.get(key);
        if (same === undefined) byFold.set(key, [entry.path]);
        else same.push(entry.path);
      },
      ctx,
    );
    if (!listed.ok) return listed;
    const collisions = [...byFold.values()].filter((names) => names.length > 1);
    if (collisions.length > 0) {
      const insensitive = await ignoresCase(io, nearest, op);
      if (!insensitive.ok) return insensitive;
      if (insensitive.value) {
        const names = collisions.flat().sort();
        return fail(
          finding("fs.case-collision", {
            message: `the snapshot holds names that differ only by case (${collisions
              .slice(0, 5)
              .map((c) => c.sort().join(" and "))
              .join(
                "; ",
              )}${collisions.length > 5 ? "; …" : ""}), and ${nearest} is on a case-insensitive volume, where one would overwrite the other; nothing was restored`,
            fix: `onload to a case-sensitive volume: plainport onload ${shellWord(ref.address)} --to <path>`,
            paths: names.slice(0, 100),
          }),
        );
      }
    }
    // The dependencies the install puts back, as the offload recorded them (DESIGN step 2).
    let stripped = 0;
    let rootMode: number | undefined;
    const got = await store.blob.get(`${STORE_EVENTS_PREFIX}${event}.json`);
    if (got.ok && got.value !== null) {
      try {
        const parsed = CatalogEventSchema.safeParse(JSON.parse(new TextDecoder().decode(got.value)));
        if (parsed.success && parsed.data.type === "offloaded") {
          stripped = parsed.data.stats.strippedBytes;
          rootMode = parsed.data.rootMode;
        } else if (parsed.success && "stats" in parsed.data) stripped = parsed.data.stats.strippedBytes;
      } catch {
        // Unreadable here, as the fold would skip it: the dependencies are not counted.
      }
    }
    const needed = Math.ceil((bytes + stripped) * 1.1);
    let free: number;
    try {
      free = await io.fs.freeBytes(nearest);
    } catch (error) {
      return unreadable(nearest, error, "its free space is unknown; nothing was restored");
    }
    if (free < needed) {
      return fail(
        finding("fs.no-space", {
          message: `${ref.address} needs about ${needed} bytes on the volume of ${nearest} (the snapshot's ${bytes}, ${stripped} of dependencies and a 10% margin), and ${free} are free; nothing was restored`,
          fix: "free some space (plainport offload another project, or empty the trash), or onload to another volume with --to <path>",
          paths: [nearest],
        }),
      );
    }
    return ok({ files, bytes, ...(rootMode === undefined ? {} : { rootMode }) });
  }

  /** Restore into staging (taking over one left by a stopped onload), then compare it with the listing. */
  async function restoreAndVerify(
    saga: Saga<OnloadJournal, OnloadStep>,
    ctx: RunContext,
    resuming: boolean,
  ): Promise<Result<void>> {
    const staging = saga.journal.staging as string;
    phase("restore", "start");
    // Made here, not by restic: a snapshot holds the folder's contents, not the folder's own mode, and restic makes a
    // target it creates private (0700). This one gets a new folder's mode, as the project folder had.
    try {
      await io.fs.mkdirp(staging);
    } catch (error) {
      return writeFailed(error, `making ${staging}`, false, staging);
    }
    const starting = await saga.step("onload.restore.start");
    if (!starting.ok) return starting;
    const restored = await store.engine.restore(
      saga.journal.stored,
      staging,
      ctx,
      resuming ? { overwrite: "if-changed" } : {},
    );
    if (!restored.ok) return signal?.aborted ? cancelled() : restored;
    const done = await saga.step("onload.restored");
    if (!done.ok) return done;
    phase("restore", "end");
    if (signal?.aborted) return cancelled();

    phase("verify", "start");
    const scanned = await scanTree(io.fs, staging);
    if (!scanned.ok) return scanned;
    const checked = await verifyListing({
      engine: store.engine,
      fs: io.fs,
      snapshot: saga.journal.stored,
      dir: staging,
      manifest: scanned.value.manifest,
      excluded: new Set(),
      ctx,
    });
    if (!checked.ok) {
      if (signal?.aborted) return cancelled();
      return withFix(
        {
          ...checked,
          finding: {
            ...checked.finding,
            message: `${checked.finding.message.replace(/the folder's scan/g, "the restored folder")}; the restored copy was removed and the stub stays`,
          },
        },
        `re-run plainport onload ${shellWord(ref.address)}; if it fails again, run restic check on the store`,
      );
    }
    const verified = await saga.step("onload.verified");
    if (!verified.ok) return verified;
    phase("verify", "end");
    return ok(undefined);
  }

  /** A failure before the swap: the staging folder goes (the journal with it, by runSaga), the stub stays. */
  async function abandon(saga: Saga<OnloadJournal, OnloadStep>, failure: Failure): Promise<Failure> {
    const staging = saga.journal.staging;
    if (staging === undefined) return failure;
    try {
      await io.fs.removeTree(staging);
    } catch (error) {
      assertSystemError(error);
      deps.log("warn", `the staging folder ${staging} could not be removed; plainport recover removes it`);
      return saga.keep(failure);
    }
    return failure;
  }

  /** Rolls back an earlier onload that stopped before its swap: its staging folder, then its journal. */
  async function dropStaging(journal: OnloadJournal): Promise<Result<void>> {
    try {
      if (journal.staging !== undefined) await io.fs.removeTree(journal.staging);
      await removeJournal(io, paths, journal.op);
    } catch (error) {
      return writeFailed(
        error,
        `removing the interrupted onload ${journal.op}`,
        false,
        journal.staging ?? "",
      );
    }
    deps.log(
      "info",
      `the interrupted onload ${journal.op} of ${ref.address} (another snapshot or folder) was rolled back`,
    );
    return ok(undefined);
  }

  /** The swap (the commit), the stub, the onloaded event and the registry (DESIGN step 5). */
  async function swapAndCommit(
    saga: Saga<OnloadJournal, OnloadStep>,
    lock: ProjectLock,
    files: number,
    bytes: number,
  ): Promise<Result<OnloadOutcome>> {
    const journal = saga.journal;
    const target = journal.project.dir;
    const source = journal.reuse?.folder ?? (journal.staging as string);
    phase("swap", "start");
    if (!(await lock.stillHeld()))
      return abandon(
        saga,
        fail(
          finding("project.locked", {
            message: `the lock on ${ref.address} was taken over by another run during the onload; nothing was swapped in and the stub stays`,
            fix: "wait for the other plainport run to finish, then re-run",
          }),
        ),
      );
    const swapping = await saga.step("onload.swap.start");
    if (!swapping.ok) return abandon(saga, swapping);
    try {
      await io.fs.mkdirp(dirname(target));
      // rename(2) replaces an empty folder; something that appeared since preflight is never merged into or replaced.
      if ((await kindAt(io, target)) !== undefined) {
        return abandon(
          saga,
          fail(
            finding("path.occupied", {
              message: `${target} appeared while ${ref.address} was restored; it was left alone and nothing was swapped in`,
              fix: `move ${shellWord(target)} aside, or onload elsewhere: plainport onload ${shellWord(ref.address)} --to <path>`,
              paths: [target],
            }),
          ),
        );
      }
      await io.fs.rename(source, target);
      await io.fs.syncDir(dirname(target));
    } catch (error) {
      const code = systemErrorCode(error);
      if (code === "EXDEV")
        return abandon(
          saga,
          fail(
            finding("fs.cross-volume", {
              message: `${source} could not be renamed to ${target}: they are on different volumes; nothing was swapped in`,
              fix: "onload to a folder on the root's own volume",
              paths: [target],
            }),
          ),
        );
      return abandon(saga, writeFailed(error, `moving ${source} to ${target}`, false, target));
    }
    saga.commit();
    saga.after("onload.swap.renamed");
    // The folder's own mode, which the snapshot does not hold (D55); set after the rename, so a folder without
    // owner write can still be moved into place. A renamed-back folder kept its own.
    if (journal.rootMode !== undefined) {
      try {
        await io.fs.chmod(target, journal.rootMode);
      } catch (error) {
        assertSystemError(error);
        deps.log(
          "warn",
          `${target} could not be given its mode ${journal.rootMode.toString(8)}; it keeps a new folder's`,
        );
      }
    }
    if (journal.reuse !== undefined) {
      // The offload whose trash this was is finished: its trash folder (now empty) and its journal go.
      try {
        await io.fs.removeTree(dirname(journal.reuse.folder));
        await removeJournal(io, paths, journal.reuse.op);
      } catch (error) {
        assertSystemError(error);
        deps.log(
          "warn",
          `the offload ${journal.reuse.op}'s empty trash or journal could not be removed; plainport recover removes them`,
        );
      }
      saga.after("onload.reuse.cleared");
    }
    const swapped = await saga.step("onload.swapped");
    if (!swapped.ok) return swapped;

    // The stub goes only while it is this project's; anything else at the path is never touched (D47).
    if (journal.stub !== undefined) {
      const at = await readStub(io, journal.stub);
      if (at.ok && at.value.project === id) {
        try {
          await io.fs.unlink(journal.stub);
        } catch (error) {
          return writeFailed(error, `removing the stub ${journal.stub}`, true, journal.stub);
        }
        saga.after("onload.stub.removed");
      }
    }

    const event: CatalogEvent = {
      v: 1,
      id: ulid(clock().getTime()),
      type: "onloaded",
      device: device.id,
      at: now(),
      op: journal.op,
      project: id,
      root: journal.project.rootId,
      path: journal.project.path,
      base: journal.snapshot,
      over: journal.over,
    };
    const starting = await saga.step("onload.commit.start", { event: event.id });
    if (!starting.ok) return starting;
    const appended = await appendEvent(storeEventLog(store.blob), event);
    if (!appended.ok)
      return withFix(
        appended,
        `the files are in ${target}; run plainport recover once the store accepts writes, to record the onload`,
      );
    saga.after("onload.commit.appended");
    const committed = await saga.step("onload.committed");
    if (!committed.ok) return committed;
    phase("swap", "end");

    // This device's copy: its place, its base (the head it was written over, D43), not hydrated yet.
    const at = now();
    const recorded = await updateRegistry(io, paths, (registry: ProjectRegistry) => {
      const entry = registry.projects[id];
      const {
        override: _o,
        unhydrated: _u,
        ...rest
      } = entry ?? { root: ref.root, path: ref.path, registeredAt: at };
      return ok({
        ...registry,
        roots: { ...registry.roots, [ref.root]: registry.roots?.[ref.root] ?? journal.project.rootId },
        projects: {
          ...registry.projects,
          [id]: {
            ...rest,
            root: ref.root,
            path: ref.path,
            ...(journal.override === true ? { override: target } : {}),
            base: journal.over,
            onloadedAt: at,
            ...(journal.reuse === undefined ? { unhydrated: true as const } : {}),
          },
        },
      });
    });
    if (!recorded.ok) return recorded;
    saga.after("onload.registry-updated");
    await saga.close();
    return ok({
      op: journal.op,
      exitCode: 0,
      project: ref.address,
      snapshot: journal.snapshot,
      over: journal.over,
      store: journal.store.name,
      dir: target,
      restored: journal.reuse === undefined ? "restore" : "reuse",
      files,
      bytes,
      hydrate: { status: "none", steps: [], untrusted: [] },
    });
  }

  /** Agent state (later milestones), the toolchain and the frozen install (DESIGN steps 6 to 8). */
  async function hydrate(outcome: OnloadOutcome): Promise<Result<OnloadOutcome>> {
    phase("agents", "skip");
    if (outcome.restored === "reuse") {
      phase("toolchain", "skip");
      phase("hydrate", "skip");
      phase("hooks", "skip");
      return ok({ ...outcome, hydrate: { status: "reused", steps: [], untrusted: [] } });
    }
    if (req.hydrate === false || !config.onload.hydrate) {
      phase("toolchain", "skip");
      phase("hydrate", "skip");
      phase("hooks", "skip");
      deps.log(
        "info",
        `${ref.address} was restored without its dependencies; plainport hydrate ${shellWord(ref.address)} installs them`,
      );
      return ok({ ...outcome, hydrate: { status: "skipped", steps: [], untrusted: [] } });
    }
    const done = await hydrateProject(
      {
        host,
        plugins: deps.plugins,
        env: deps.env,
        loader: deps.loader,
        op,
        emit: deps.emit,
        log: deps.log,
        ...(signal === undefined ? {} : { signal }),
      },
      outcome.dir,
      ref.address,
    );
    phase("hooks", "skip");
    const result = { ...outcome, hydrate: done.report };
    if (done.failure !== undefined) return failWith(done.failure.finding, { ...result, exitCode: 10 }, 10);
    const marked = await markHydrated(host, paths, id, true);
    if (!marked.ok) deps.log("warn", `registry.json was not updated: ${marked.finding.message}`);
    return ok(result);
  }
};
