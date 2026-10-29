// What an operation reads of a store's catalog before it writes there (DESIGN.md "Offload process" step 7, "Catalog
// and data model"): the catalog itself through the one read path (a stale read is store.unreachable, never trusted for
// a write), whether the project's head is still the snapshot this working copy came from, and whether the store
// serves another root (ADR-0010, D48). Offload uses it now; onload's lease check reads the same head.
//
// A fold that left out an event it could not read or use is not known to be whole (D86), and the event's ULID says
// nothing about whether it is newer than the head: its time is its writer's clock, which may run slow (Task 21,
// astra's Important 6). So an event left out that may be any project's (its project cannot be told or, on a sealed
// store, authenticated) makes every head on the store uncertain, and one whose project is known makes that project's
// head uncertain, whatever this device knows; a head-dependent default then refuses with catalog.head-uncertain. The
// way on is an explicit --snapshot: the newest snapshot this device knows that no readable event names (its stub's,
// its registry entry's base), when there is one, and only that one; its restic snapshot is found by its op tag
// (unfoldedSnapshot), so onload restores it and removes its stub as usual. The doubt clears when the event reads.
//
// A project's home store (Q12): before replication (M3) a project's history lives in one store. An offload or onload
// whose store's catalog does not name the snapshot this copy came from refuses with store.history-elsewhere, naming
// the store whose catalog this device's mirror shows holding it (stores by id; a mirror stands in for an offline
// store), never starting a second history elsewhere.

import { type Finding, fail, finding, ok, type Result, shellWord } from "@plainport/contract";
import type { Scheduler } from "../deadline.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { Engine, RunContext } from "../ports/engine.ts";
import type { ProjectRegistry } from "../registry.ts";
import type { Stub } from "../stub.ts";
import type { CatalogPolicy } from "./codec.ts";
import { type CatalogProject, type CatalogState, compare } from "./fold.ts";
import { type Doubt, loadCatalog, readMirrorCatalog, type Tainted } from "./log.ts";

/** How long a write's catalog read may take (one listing and one batch read) before the store counts as unreachable. */
export const WRITE_SYNC_DEADLINE_MS = 120_000;

/**
 * A catalog read for writing: the fold, the events it left out that may change state (D86), and the store's format,
 * which keys the `stored` entry of the events written on top of it (Q11).
 */
export type CatalogRead = CatalogState & {
  uncertain: readonly string[];
  /** The stored-multiple events left out (Q11): their projects' heads are uncertain whatever this device knows. */
  tainted: readonly Tainted[];
  /** The events left out by whose they are (Task 21). */
  doubt: Doubt;
  format: 1 | 2;
};

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * A reader of the store's catalog for writing on top of it: the folded state when the store answered, the store's
 * own finding (store.unreachable when it gave none) when only the mirror's stale copy could be read. The read's
 * findings go to `report`.
 */
export const catalogReader =
  (options: {
    store: BlobStore;
    mirror: BlobStore;
    storeId: string;
    storeName: string;
    /** The store's catalog policy; plain when absent. */
    policy?: CatalogPolicy;
    now(): Date;
    report(finding: Finding): void;
    /** WRITE_SYNC_DEADLINE_MS on the real timers unless a test says otherwise. */
    deadlineMs?: number;
    scheduler?: Scheduler;
  }): (() => Promise<Result<CatalogRead>>) =>
  async () => {
    // Always fresh: a write reads the store itself, never the mirror's state alone.
    const read = await loadCatalog({
      store: options.store,
      mirror: options.mirror,
      storeId: options.storeId,
      now: options.now(),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      deadline: {
        ms: options.deadlineMs ?? WRITE_SYNC_DEADLINE_MS,
        store: options.storeName,
        ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      },
    });
    if (!read.ok) return read;
    if (read.value.stale)
      return fail(
        read.value.unreachable ??
          finding("store.unreachable", { message: `store ${options.storeName} could not be reached` }),
      );
    for (const f of read.value.findings) options.report(f);
    return ok({
      ...read.value.state,
      uncertain: read.value.uncertain,
      tainted: read.value.tainted,
      doubt: read.value.doubt,
      format: read.value.format ?? 1,
    });
  };

/** Whether a readable event names `snapshot`: one the project holds, discarded, or named as a base it lacks. */
const named = (project: CatalogProject | undefined, snapshot: string): boolean =>
  project !== undefined &&
  (project.snapshots[snapshot] !== undefined ||
    project.discarded.includes(snapshot) ||
    project.missing.includes(snapshot));

export interface HeadDoubt {
  finding: Finding;
  /**
   * The newest snapshot this device knows that no readable event names, or that a stored-multiple event names: the
   * one --snapshot may restore. Absent when there is none: then any snapshot named with --snapshot may be.
   */
  newest?: string;
}

/** A read as the doubt rule takes it: `doubt` when the read scoped it, else every event in `uncertain` taints all. */
type Doubted = CatalogState & { uncertain?: readonly string[]; tainted?: readonly Tainted[]; doubt?: Doubt };

/** The events left out that may change project `id`'s head: those that may be any project's, and its own. */
const doubtFor = (read: Doubted, id: string): string[] => {
  const doubt = read.doubt ?? { store: [...(read.uncertain ?? [])], projects: {} };
  return [...new Set([...doubt.store, ...(doubt.projects[id] ?? [])])].sort(compare);
};

/**
 * catalog.head-uncertain (D86, Task 21) when the read left out an event that may change project `id`'s head: one that
 * may be any project's, or one of its own, whatever its ULID's time; else undefined. `known` are the snapshots this
 * device knows of the project (its stub's, its registry entry's base): the newest of them no readable event names
 * is the one --snapshot may restore. `said.what` says what was not done ("nothing was restored"), `said.instead` the
 * way on, given that newest snapshot when there is one.
 */
export const headUncertain = (
  read: Doubted,
  id: string,
  known: readonly (string | undefined)[],
  address: string,
  said: { what: string; instead: (newest?: string) => string },
): HeadDoubt | undefined => {
  const uncertain = doubtFor(read, id);
  if (uncertain.length === 0) return undefined;
  const project = read.projects[id];
  const unnamed = [
    ...new Set(known.filter((s): s is string => s !== undefined && !named(project, s))),
  ].sort();
  // A stored-multiple snapshot of this project (Q11) is known to exist whatever this device knows: its head is not.
  const hidden = [
    ...new Set(
      (read.tainted ?? [])
        .filter((t) => t.project === id && t.type !== "snapshot-discarded" && !named(project, t.snapshot))
        .map((t) => t.snapshot),
    ),
  ].sort();
  const newest = [...unnamed, ...hidden].sort().at(-1);
  const latest = project?.head ?? null;
  const events = `${plural(uncertain.length, "event")} it could not read or use (${uncertain.join(", ")})`;
  const message =
    unnamed.length > 0
      ? `this device knows snapshot ${unnamed.join(" and ")} of ${address}, which no readable catalog event names, and the catalog left out ${events}; its head${latest === null ? "" : ` ${latest}`} may be older than the newest snapshot, so ${said.what}`
      : hidden.length > 0
        ? `an event the catalog cannot use names snapshot ${hidden.join(" and ")} of ${address} in several stores (stored-multiple), and the catalog left out ${events}; its head${latest === null ? "" : ` ${latest}`} may be older than the newest snapshot, so ${said.what}`
        : `the catalog left out ${events}, which may name a newer snapshot of ${address} whatever their ids' times say (a writer's clock may run slow); its head${latest === null ? "" : ` ${latest}`} may not be the newest, so ${said.what}`;
  return {
    ...(newest === undefined ? {} : { newest }),
    finding: finding("catalog.head-uncertain", {
      message,
      fix: `${said.instead(newest)}; or upgrade plainport if a newer version wrote ${uncertain.length === 1 ? "that event" : "those events"}`,
    }),
  };
};

/** Whether the store's catalog names `snapshot` of project `id` (Q12): it holds this copy's history. */
export const namesSnapshot = (state: CatalogState, id: string, snapshot: string): boolean =>
  named(state.projects[id], snapshot);

/**
 * The store whose catalog holds `snapshot` of project `id`, by this device's mirrors (Q12): each store this device set
 * up, by id (a store under two names is one), other than `exclude`, read from its mirror alone, so an offline store
 * still answers. Its name, or undefined when no mirror holds it.
 */
export const storeHolding = async (options: {
  /** Store name → id (registry.json's stores). */
  stores: Readonly<Record<string, string>>;
  exclude: string;
  id: string;
  snapshot: string;
  openMirror(storeId: string): Promise<Result<BlobStore>>;
}): Promise<string | undefined> => {
  const seen = new Set<string>([options.exclude]);
  for (const [name, storeId] of Object.entries(options.stores).sort(([a], [b]) => compare(a, b))) {
    if (seen.has(storeId)) continue;
    seen.add(storeId);
    const mirror = await options.openMirror(storeId);
    if (!mirror.ok) continue;
    const read = await readMirrorCatalog({
      mirror: mirror.value,
      storeId,
      reason: finding("store.unreachable", {
        message: `store ${name} was read from this device's mirror only`,
      }),
    });
    if (read.ok && read.value.state.projects[options.id]?.snapshots[options.snapshot] !== undefined)
      return name;
  }
  return undefined;
};

/** store.history-elsewhere (Q12): `store`'s catalog does not name the snapshot this copy came from. */
export const historyElsewhere = (options: {
  store: string;
  address: string;
  snapshot: string;
  holder: string | undefined;
  what: string;
}): Finding =>
  finding("store.history-elsewhere", {
    message: `this copy of ${options.address} came from snapshot ${options.snapshot}, which store ${options.store}'s catalog does not name: the project's history is in ${options.holder === undefined ? "a store this device cannot tell (unknown)" : `store ${options.holder}`}, and a second history is never started elsewhere (Q12); ${options.what}`,
    fix:
      options.holder === undefined
        ? `connect the store that holds snapshot ${options.snapshot}, and name it with --store <name>`
        : `use the project's home store: --store ${options.holder}, or set the root's store back to ${options.holder}`,
  });

/**
 * The restic ids a project's skipped stored-multiple discards name (Q11): never restored by tag, as a readable discard
 * is not.
 */
export const taintedDiscards = (read: { tainted?: readonly Tainted[] }, id: string): string[] =>
  (read.tainted ?? [])
    .filter((t) => t.project === id && t.type === "snapshot-discarded")
    .flatMap((t) => t.stored);

/** The restic tag that holds the project folder's own mode (Q5 ii), in octal: `plainport:mode=0755`. */
export const rootModeTag = (mode: number): string =>
  `plainport:mode=${(mode & 0o7777).toString(8).padStart(4, "0")}`;

/** The folder mode a snapshot's tags record; undefined when none does (a snapshot from before the tag). */
export const rootModeOfTags = (tags: readonly string[]): number | undefined => {
  for (const tag of tags) {
    const octal = /^plainport:mode=([0-7]{1,5})$/.exec(tag)?.[1];
    if (octal === undefined) continue;
    const mode = Number.parseInt(octal, 8);
    if (mode <= 0o7777) return mode;
  }
  return undefined;
};

/**
 * The restic id of `snapshot`, a snapshot of project `id` whose event the catalog could not read (D86): the one
 * snapshot in the repository tagged with its op, leaving out any the catalog names as discarded, with the folder mode
 * its tag records (the event, which holds rootMode, being the unreadable one). snapshot.not-found when there is none,
 * or more than one to choose from.
 */
export const unfoldedSnapshot = async (
  engine: Engine,
  options: { id: string; snapshot: string; discarded: readonly string[]; address: string; ctx?: RunContext },
): Promise<Result<{ id: string; rootMode?: number }>> => {
  const listed = await engine.list(
    { tags: ["plainport", `plainport:project=${options.id}`, `plainport:op=${options.snapshot}`] },
    options.ctx,
  );
  if (!listed.ok) return listed;
  const found = listed.value.filter((s) => !options.discarded.includes(s.id));
  const [only] = found;
  if (found.length === 1 && only !== undefined) {
    const rootMode = rootModeOfTags(only.tags);
    return ok({ id: only.id, ...(rootMode === undefined ? {} : { rootMode }) });
  }
  return fail(
    finding("snapshot.not-found", {
      message:
        found.length === 0
          ? `the repository holds no snapshot tagged as ${options.snapshot} of ${options.address}, and the catalog cannot read the event that names it; nothing was restored`
          : `the repository holds ${found.length} snapshots tagged as ${options.snapshot} of ${options.address} (${found.map((s) => s.id).join(", ")}), and the event that says which one was kept cannot be read; nothing was restored`,
      fix: "upgrade plainport if a newer version wrote the unreadable event; until then restore an older snapshot side by side: plainport restore <project> --snapshot <id> --to <path>",
    }),
  );
};

/**
 * The project as this device's own records know it (D88), for --snapshot under doubt when no readable event names it at
 * all (its first offload's event unreadable): its root's ULID from its stub, when the stub is this project's at this
 * root and path, else from registry.json, with no snapshots folded. Undefined when neither record says.
 */
export const recordedProject = (options: {
  id: string;
  root: string;
  path: string;
  stub: Stub | undefined;
  registry: ProjectRegistry;
}): CatalogProject | undefined => {
  const { id, root, path, stub, registry } = options;
  const entry = registry.projects[id];
  if (entry !== undefined && (entry.root !== root || entry.path !== path)) return undefined;
  const ours = stub !== undefined && stub.project === id && stub.root === root && stub.path === path;
  const rootId = ours ? stub.rootId : entry !== undefined ? registry.roots?.[root] : undefined;
  if (rootId === undefined) return undefined;
  return {
    root: rootId,
    path,
    status: "shelved",
    head: null,
    heads: [],
    lease: null,
    conflicts: [],
    missing: [],
    discarded: [],
    resolutions: [],
    rejected: [],
    kept: [],
    invalid: [],
    snapshots: {},
  };
};

export type HeadCheck = { kind: "ok" } | { kind: "moved" | "incomplete"; finding: Finding };

/**
 * The catalog's view of the head this working copy should offload on top of; a refusal when it is not that. With
 * `home` (Q12), a base the catalog does not name at all is store.history-elsewhere, naming `home.holder`.
 */
export const headCheck = (
  state: Doubted,
  id: string,
  base: string | undefined,
  address: string,
  home?: { store: string; holder: string | undefined },
): HeadCheck => {
  // A fold that may lack an event of this project cannot say whether the head moved (D86, Task 21).
  const uncertain = headUncertain(state, id, [base], address, {
    what: "nothing was offloaded",
    instead: () => "keep this folder as it is until the catalog reads whole",
  });
  if (uncertain !== undefined) return { kind: "incomplete", finding: uncertain.finding };
  const project = state.projects[id];
  if (home !== undefined && base !== undefined && !named(project, base)) {
    return {
      kind: "incomplete",
      finding: historyElsewhere({
        store: home.store,
        address,
        snapshot: base,
        holder: home.holder,
        what: "nothing was offloaded",
      }),
    };
  }
  const kept = project !== undefined && (project.heads.length > 0 || project.conflicts.length > 0);
  if (project !== undefined && project.missing.length > 0) {
    return {
      kind: "incomplete",
      finding: finding("catalog.incomplete", {
        message: `the catalog names ${plural(project.missing.length, "snapshot")} of ${address} it does not hold (${project.missing.join(", ")}), so its head is unknown; nothing was offloaded`,
        fix: "connect the store that holds them, then re-run",
      }),
    };
  }
  if (!kept) {
    if (base === undefined) return { kind: "ok" };
    return {
      kind: "incomplete",
      finding: finding("catalog.incomplete", {
        message: `this copy of ${address} came from snapshot ${base}, which the store's catalog does not hold`,
        fix: "check that the root's store is the one the project was onloaded from, then re-run",
      }),
    };
  }
  const moved = (detail: string) => ({
    kind: "moved" as const,
    finding: finding("catalog.head-moved", {
      message: `${address} ${detail}; nothing local was deleted`,
      fix: `keep this folder; plainport restore ${shellWord(address)} --snapshot <id> --to <path> reads the other copy side by side (settling which copy wins arrives in M2)`,
    }),
  });
  if (project.conflicts.length > 0 || project.head === null) return moved("is conflicted in the catalog");
  if (project.head !== base)
    return moved(
      `was offloaded from another copy since this one was made: the head is ${project.head}, this copy came from ${base ?? "no snapshot"}`,
    );
  return { kind: "ok" };
};

/** A root of the store's catalog other than `rootId` (by key when known): the store already serves it (D48). */
export const otherRoot = (state: CatalogState, rootId: string): string | undefined => {
  const roots = new Set(Object.keys(state.roots));
  for (const project of Object.values(state.projects)) roots.add(project.root);
  roots.delete(rootId);
  const [other] = [...roots].sort();
  return other === undefined ? undefined : (state.roots[other]?.key ?? other);
};

export const rootMismatch = (store: string, root: string, other: string): Finding =>
  finding("store.root-mismatch", {
    message: `store ${store} already holds root ${other}'s snapshots; one repository serves one root (ADR-0010), so root ${root} was not offloaded there`,
    fix: `give root ${root} its own store: plainport init --store-path <path> --store <name> --yes, then set roots.${root}.store to it`,
  });
