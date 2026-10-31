// plainport resolve <project> --keep <snapshot> (M2 Task 25; Q18; DESIGN.md "Catalog and data model" → Resolution,
// "Conflict at step 7"): settles a conflict by appending one `resolved {keep, over, supersedes}` event, made by Task
// 12's production rule (resolutionFor) from a fresh read of the store, so the fold judges every event it writes valid.
//
// The rules, in the order they are checked:
// - the project's lock, and no unfinished journal of it (journal.pending, fix: recover); a journal that holds the
//   project back no longer (a released trash, and Task 24's held trash) does not count, as for any write (D59);
// - a fresh read of the store, never the mirror alone (store.unreachable otherwise);
// - a format-2 store: a resolved event is never written where v0.1.1 could read it (Q2, Q3), so a format-1 store
//   refuses with `store upgrade` as the fix (store.needs-upgrade);
// - a read that may lack an event of the project refuses (catalog.head-uncertain, D86), and so does one that names
//   what it does not hold or skipped a resolution as invalid (catalog.incomplete): what it lacks could change the tips;
// - a project that is not conflicted and has one live tip has nothing to resolve: exit 0, nothing written. That makes
//   a re-run a no-op, and a re-run after an append whose acknowledgement was lost too;
// - `--keep` names a live tip (snapshot.not-found for one the catalog does not hold, resolve.not-live-tip otherwise);
// - while this device holds a working copy (its folder here), `--keep` is the copy's recorded snapshot, the registry's
//   `base` (Task 23), so a resolve never rejects the line the copy here is on (resolve.copy-here).
//
// It is not journaled: its one effect is the append, which a re-run finds (nothing to resolve) and never repeats. The
// pause seam `resolve.checked` stands between the read and the append, where the race schedule (S7) lets another
// device resolve too.

import {
  type Failure,
  fail,
  finding,
  ok,
  type Phase,
  type Result,
  type StreamEvent,
  shellWord,
} from "@plainport/contract";
import type { CatalogEvent } from "../catalog/events.ts";
import { type CatalogProject, resolutionFor } from "../catalog/fold.ts";
import { catalogReader, headUncertain } from "../catalog/head.ts";
import { appendEvent, storeEventLog } from "../catalog/log.ts";
import { resolveRootId } from "../catalog/roots.ts";
import type { ConfigLoader } from "../config/load.ts";
import type { Device } from "../device.ts";
import type { LocalIo } from "../io.ts";
import { type OffloadJournal, readJournals } from "../journal/index.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { HostPorts } from "../ports/host.ts";
import type { StoreOpener } from "../ports/store.ts";
import { readRegistry } from "../registry.ts";
import type { ProjectRef } from "../roots/address.ts";
import { type ConfiguredStore, openStore } from "../store.ts";
import { readStub } from "../stub.ts";
import { ulid } from "../ulid.ts";
import { registeredFolders, withProjectLock } from "./project-gate.ts";
import { offloadTrashOf, rootFolderOf } from "./release.ts";
import { kindAt, unreadable } from "./restore-tree.ts";

export interface ResolveDeps {
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
  now?: () => Date;
}

export interface ResolveRequest {
  /** The resolved project: a name, an address or its stub. */
  project: ProjectRef;
  /** The snapshot to keep: a live tip. */
  keep: string;
  /** --store: overrides the stub's, the root's and the default store. */
  store?: string;
}

export type ResolveOutcome = {
  op: string;
  /** root:path. */
  project: string;
  store: string;
  /** The snapshot this resolution keeps; absent when there was nothing to resolve and it is not the head. */
  keep?: string;
  /** resolved: this run appended a resolved event. nothing-to-resolve: not conflicted, one live tip; nothing written. */
  outcome: "resolved" | "nothing-to-resolve";
  /**
   * The head the store's catalog shows now, read again after the append (review r2 M5): `keep` once the resolution
   * settles the project, null while it is still conflicted (another device's resolution competes, S7) or when the read
   * again failed; the one live tip when there was nothing to resolve.
   */
  head: string | null;
  /** resolved: whether the project is still conflicted by the read after the append; absent when it failed. */
  conflicted?: boolean;
  /**
   * resolved: this device's held trash (offload.release.held) whose snapshot this resolution rejects: deleted after
   * its fresh grace, as a rejected snapshot's trash is; plainport restore --snapshot reads the snapshot (review r2 M7).
   */
  heldRejected?: { snapshot: string; trash: string }[];
  /** resolved: the resolved event's id. */
  event?: string;
  /** resolved: the snapshots it rejects. */
  over?: string[];
  /** resolved: the active resolutions it replaces. */
  supersedes?: string[];
};

/**
 * The pause seam for the race schedules (see OFFLOAD_PAUSE_SEAMS): the fresh read is checked and the event made,
 * nothing is appended yet. It writes no journal; in a release build nothing pauses there (D67).
 */
export const RESOLVE_PAUSE_SEAMS = ["resolve.checked"] as const;

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Runs the resolve; see the file comment. */
export const runResolve = async (deps: ResolveDeps, req: ResolveRequest): Promise<Result<ResolveOutcome>> => {
  const { host, paths } = deps;
  const io: LocalIo = host;
  const clock = (): Date => deps.now?.() ?? host.clock.now();
  const ref = req.project;
  const { keep } = req;
  const op = ulid(clock().getTime());
  const address = shellWord(ref.address);
  const command = (snapshot: string) => `plainport resolve ${address} --keep ${snapshot} --yes`;
  const phase = (name: Phase, status: "start" | "end") =>
    deps.emit({ type: "phase", op, phase: name, status });
  const report = (f: ReturnType<typeof finding>) => deps.emit({ type: "finding", op, finding: f });

  phase("resolve", "start");
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
  for (const f of store.findings ?? []) report(f);
  const mirror = await deps.openMirror(store.id);
  if (!mirror.ok) return mirror;
  const reader = catalogReader({
    store: store.blob,
    mirror: mirror.value,
    storeId: store.id,
    storeName: store.name,
    now: clock,
    ...(store.catalog === undefined ? {} : { policy: store.catalog }),
    report,
  });
  const registered = await readRegistry(io, paths);
  if (!registered.ok) return registered;
  let id =
    ref.id ??
    Object.entries(registered.value.projects).find(
      ([, e]) => e.root === ref.root && e.path === ref.path,
    )?.[0];
  const notInStore = () =>
    fail(
      finding("project.not-found", {
        message: `store ${store.name} holds no snapshot of ${ref.address}`,
        fix: "check the address (plainport ls lists the projects), or name the store that holds it with --store",
      }),
    );
  if (id === undefined) {
    // A project this device never registered: its id is the catalog's, for its root and path.
    const read = await reader();
    if (!read.ok) return read;
    const rootId = resolveRootId(registered.value, read.value, ref.root)?.id;
    id = Object.entries(read.value.projects).find(([, p]) => p.root === rootId && p.path === ref.path)?.[0];
    if (id === undefined) return notInStore();
  }
  const projectId = id;
  const gate = { io, paths, clock, log: deps.log };
  return withProjectLock<ResolveOutcome>(gate, { id: projectId, address: ref.address }, async (lock) => {
    // The fresh read, under the lock: what it saw is what the event is made from.
    const read = await reader();
    if (!read.ok) return read;
    if (read.value.format !== 2) return needsUpgrade();
    const registry = await readRegistry(io, paths);
    if (!registry.ok) return registry;
    const entry = registry.value.projects[projectId];
    const doubt = headUncertain(
      read.value,
      projectId,
      [stub?.ok ? stub.value.snapshot : undefined, entry?.base],
      ref.address,
      {
        what: "nothing was resolved",
        instead: () =>
          "re-run the resolve once the catalog reads whole (plainport status shows what it left out)",
      },
    );
    if (doubt !== undefined) return fail(doubt.finding);
    const project = read.value.projects[projectId];
    if (project === undefined) return notInStore();
    const incomplete = incompleteOf(project);
    if (incomplete !== undefined) return incomplete;
    if (project.status !== "conflicted" && project.heads.length <= 1) {
      phase("resolve", "end");
      return ok({
        op,
        project: ref.address,
        store: store.name,
        ...(project.head === keep ? { keep } : {}),
        outcome: "nothing-to-resolve" as const,
        head: project.head,
      });
    }
    const tips = [...project.heads].sort();
    if (project.snapshots[keep] === undefined)
      return fail(
        finding("snapshot.not-found", {
          message: `the catalog holds no snapshot ${keep} of ${ref.address}${project.discarded.includes(keep) ? " (it was discarded: restic could not read every file)" : ""}; its live tips are ${tips.join(", ")}`,
          fix: command(tips[0] ?? "<snapshot>"),
        }),
      );
    if (!project.heads.includes(keep))
      return fail(
        finding("resolve.not-live-tip", {
          message: `snapshot ${keep} of ${ref.address} is not a live tip (${project.rejected.includes(keep) ? "a resolution rejected it" : "a later snapshot was made from it"}), so it cannot be kept over the others; its live tips are ${tips.join(", ")}`,
          fix: `${command("<tip>")}, naming one of ${tips.join(", ")}; plainport status ${address} shows each one's device, time and size`,
        }),
      );
    const here = await copyHere(entry?.base, project.heads);
    if (here !== undefined) return here;
    const made = resolutionFor(project, keep);
    if (!made.ok) {
      // Each refusal was checked above from the same read; one here is a bug in this command.
      return fail(
        finding("internal.unexpected", {
          message: `the resolution of ${ref.address} keeping ${keep} was refused (${made.reason}) after its checks passed; nothing was written`,
        }),
      );
    }
    const { over, supersedes } = made.value;
    phase("resolve", "end");

    phase("commit", "start");
    host.faultAt("resolve.checked");
    // lock.ts's known limit: a run that lost its lock to a breaker never appends.
    if (!(await lock.stillHeld()))
      return fail(
        finding("project.locked", {
          message: `the lock on ${ref.address} was taken over by another run; nothing was resolved`,
          fix: "wait for the other plainport run to finish, then re-run",
        }),
      );
    const event = ulid(clock().getTime());
    const resolved: CatalogEvent = {
      v: 1,
      id: event,
      op,
      type: "resolved",
      device: deps.device.id,
      at: clock().toISOString(),
      project: projectId,
      root: project.root,
      path: project.path,
      keep,
      over,
      supersedes,
    };
    const appended = await appendEvent(storeEventLog(store.blob, store.catalog), resolved);
    if (!appended.ok)
      return fail({
        ...appended.finding,
        fix: `${appended.finding.fix === undefined ? "" : `${appended.finding.fix}; then `}re-run ${command(keep)}: if this event landed, the re-run finds nothing to resolve`,
      });
    phase("commit", "end");
    // The head as the store shows it now: a competing resolution (S7) leaves the project conflicted (M5).
    const after = await reader();
    if (!after.ok)
      deps.log("warn", `the catalog could not be read again after the resolution: ${after.finding.message}`);
    const now = after.ok ? after.value.projects[projectId] : undefined;
    const held = await heldRejectedHere(over);
    return ok({
      op,
      project: ref.address,
      store: store.name,
      keep,
      outcome: "resolved" as const,
      head: now?.head ?? null,
      ...(now === undefined ? {} : { conflicted: now.status === "conflicted" }),
      event,
      over,
      supersedes,
      ...(held.length === 0 ? {} : { heldRejected: held }),
    });
  });

  /** This device's held trash of the project whose snapshot `over` rejects: it goes after its fresh grace (M7). */
  async function heldRejectedHere(over: readonly string[]): Promise<{ snapshot: string; trash: string }[]> {
    const read = await readJournals(io, paths);
    return read.journals
      .filter(
        (j): j is OffloadJournal =>
          j.kind === "offload" &&
          j.step === "offload.release.held" &&
          j.project.id === projectId &&
          over.includes(j.op),
      )
      .map((j) => ({ snapshot: j.op, trash: j.trash ?? offloadTrashOf(j) }));
  }

  function needsUpgrade(): Failure {
    return fail(
      finding("store.needs-upgrade", {
        message: `store ${store.name} is format 1 (an M1 store, which plainport v0.1.x still uses), and a resolved event is written only to a format-2 store, which v0.1.x never reads (Q2); nothing was resolved`,
        fix: `stop plainport on every other device that uses store ${store.name}, then plainport store upgrade ${store.name} --others-stopped --yes, then re-run ${command(keep)}`,
      }),
    );
  }

  function incompleteOf(project: CatalogProject): Failure | undefined {
    if (project.missing.length > 0)
      return fail(
        finding("catalog.incomplete", {
          message: `the catalog names ${plural(project.missing.length, "snapshot or resolution")} of ${ref.address} it does not hold (${project.missing.join(", ")}), so its live tips are not known; nothing was resolved`,
          fix: `connect or sync the store that holds them, then re-run ${command(keep)}`,
        }),
      );
    if (project.invalid.length > 0)
      return fail(
        finding("catalog.incomplete", {
          message: `the catalog holds ${plural(project.invalid.length, "resolution")} of ${ref.address} it skipped as invalid (${project.invalid.join(", ")}), so its live tips are not known; nothing was resolved`,
          fix: "upgrade plainport if a newer version wrote them; a resolution plainport writes is never invalid",
        }),
      );
    return undefined;
  }

  /** resolve.copy-here when this device's working copy is here and `keep` is not its recorded snapshot (Q18). */
  async function copyHere(base: string | undefined, heads: readonly string[]): Promise<Failure | undefined> {
    const folders = await registeredFolders(io, paths, deps.env);
    if (!folders.ok) return folders;
    const folder = folders.value.find((f) => f.id === projectId)?.folder;
    if (folder === undefined) return undefined;
    let there: string | undefined;
    try {
      there = await kindAt(io, folder);
    } catch (error) {
      return unreadable(
        folder,
        error,
        "whether this device holds a working copy is unknown; nothing was resolved",
      );
    }
    if (there === undefined && base !== undefined) {
      // A root that is away cannot say whether a copy is there: refuse rather than reject the line it may be on.
      const root = rootFolderOf(ref.path, folder);
      let rootThere: string | undefined;
      try {
        rootThere = await kindAt(io, root);
      } catch {
        rootThere = undefined;
      }
      if (rootThere !== "dir")
        return fail(
          finding("root.path-missing", {
            message: `the root of ${ref.address} (${root}) is not mounted here, so whether this device holds a working copy on snapshot ${base} cannot be told; nothing was resolved`,
            fix: `mount the volume ${root} lives on and re-run, or run the resolve on a device that holds no working copy of ${ref.address}`,
            paths: [root],
          }),
        );
    }
    if (there !== "dir" || base === keep) return undefined;
    const tip = base !== undefined && heads.includes(base) ? base : undefined;
    const here = `or offload this copy here first (plainport offload ${shellWord(ref.address)} --yes), then re-run ${command(keep)}`;
    return fail(
      finding("resolve.copy-here", {
        message: `this device holds a working copy of ${ref.address} at ${folder}, on snapshot ${base ?? "none (never offloaded)"}, and keeping ${keep} would reject the line it is on; while a copy is here, --keep names the copy's own snapshot`,
        fix:
          tip !== undefined
            ? `${command(tip)} keeps this copy's snapshot; to keep ${keep}, run that resolve on a device that holds no working copy of ${ref.address}, or on the one whose copy is on ${keep}, ${here}`
            : `this copy is on no live tip: plainport offload ${shellWord(ref.address)} --fork --yes keeps it as a fork, a live tip that resolve --keep can name (D114); or run ${command(keep)} on a device that holds no working copy of ${ref.address}`,
        paths: [folder],
      }),
    );
  }
};
