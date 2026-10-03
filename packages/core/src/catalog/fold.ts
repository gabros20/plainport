// The fold (DESIGN.md "Catalog and data model" → Fold rules, ADR-0009): a pure function from a set of catalog events
// to the state of every project and root. It sees a set, not a sequence: events are de-duplicated by id and sorted
// before anything else, so folding any permutation, or a union with copies from another store, gives the same state
// (invariant 4). Sorting by id only settles ties deterministically; history comes from the `base` chain, never from
// ids or clocks.
//
// Rules, per project:
// - Snapshots form a tree through `base`. A snapshot's depth is one more than its base's (1 when the base is unknown;
//   a cycle of bases, which only a broken writer could make, is cut where the walk meets it). A snapshot named by a
//   snapshot-discarded event (D28) is out of the tree: never a head, never part of a conflict.
// - Each status event gets a position on that chain: an offloaded event sits at its snapshot's depth (2·d), and an
//   onloaded event just after the head it was written over (`over`, D43), or the snapshot it restored when the event
//   predates `over` (2·d + 1), so before anything made from that working copy. Onloading an older snapshot therefore
//   comes after the head, not behind it. An `over` the catalog holds but that is not the restored snapshot or made
//   from it (older, on another fork, discarded) is ignored and the onload is ordered by what it restored.
// - Status is the event furthest along the chain: offloaded → shelved, onloaded → local; local when there is none.
// - A fork makes the project conflicted until a resolved event (M2) picks a side (D41): a kept snapshot with two or
//   more kept children, offloaded or checkpointed alike. Two first offloads (no base) are a fork too. DESIGN's "two
//   offloaded events with the same base" is the special case; a checkpoint on one side must not hide the other.
// - Heads are the tips: kept snapshots nothing kept was made from. `head` is the one tip, and only when the chain is
//   whole: it is null when the project is conflicted, when a base, an onloaded snapshot or an onload's `over` is
//   missing from the events (`missing`: a partial mirror, D41; an older snapshot never becomes the head by default,
//   and an `over` proves a newer snapshot exists), or when bases loop.
// - The lease: an onloaded event with no offloaded event from the same device further along the chain. Of several
//   such, the one furthest along wins, then the smallest event id, so there is at most one (invariant 5).
//
// Per root: the first root-created event (smallest id) names it; each device's binding is its latest root-bound
// (largest id: a device's own ULIDs follow its own clock).

import { z } from "zod";
import { RelativePathSchema, RootKeySchema } from "../registry.ts";
import { UlidSchema } from "../ulid.ts";
import type { CatalogEvent, ProjectEvent, RootEvent } from "./events.ts";

const SnapshotSchema = z.strictObject({
  kind: z.enum(["offloaded", "checkpointed"]),
  base: UlidSchema.optional(),
  /** The event that made it. */
  event: UlidSchema,
  device: UlidSchema,
  at: z.iso.datetime(),
  stored: z.record(z.string(), z.string()),
});

const LeaseSchema = z.strictObject({
  device: UlidSchema,
  /** The onloaded event that opened it. */
  event: UlidSchema,
  /** The snapshot the device restored. */
  base: UlidSchema,
  at: z.iso.datetime(),
});

export const CatalogProjectSchema = z.strictObject({
  root: UlidSchema,
  path: RelativePathSchema,
  status: z.enum(["local", "shelved", "conflicted"]),
  head: UlidSchema.nullable(),
  heads: z.array(UlidSchema),
  lease: LeaseSchema.nullable(),
  /** Each fork: the kept snapshots made from one base, sorted. */
  conflicts: z.array(z.array(UlidSchema)),
  /** Snapshots that events name as a base but the catalog does not hold; while any is listed there is no head. */
  missing: z.array(UlidSchema),
  discarded: z.array(UlidSchema),
  snapshots: z.record(UlidSchema, SnapshotSchema),
});
export type CatalogProject = z.infer<typeof CatalogProjectSchema>;

export const CatalogRootSchema = z.strictObject({
  /** Null until the root-created event arrives. */
  key: RootKeySchema.nullable(),
  label: z.string().optional(),
  created: UlidSchema.nullable(),
  /** Device ULID → that device's folder for the root. */
  bindings: z.record(UlidSchema, z.strictObject({ path: z.string(), event: UlidSchema })),
});
export type CatalogRoot = z.infer<typeof CatalogRootSchema>;

export const CatalogStateSchema = z.strictObject({
  projects: z.record(UlidSchema, CatalogProjectSchema),
  roots: z.record(UlidSchema, CatalogRootSchema),
});
export type CatalogState = z.infer<typeof CatalogStateSchema>;

/**
 * The version of these rules and of CatalogStateSchema. A cached fold (state.json) records it and is rebuilt when it
 * differs, so bump it whenever the fold, the event types it reads or the state's shape change (D43).
 */
export const FOLD_VERSION = 3;

export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One event per id; of two different events claiming one id (a broken copy), the one whose JSON sorts first. */
const canonical = (events: readonly CatalogEvent[]): CatalogEvent[] => {
  const byId = new Map<string, { event: CatalogEvent; text: string }>();
  for (const event of events) {
    const text = JSON.stringify(event);
    const seen = byId.get(event.id);
    if (seen === undefined || text < seen.text) byId.set(event.id, { event, text });
  }
  return [...byId.values()].map((entry) => entry.event).sort((a, b) => compare(a.id, b.id));
};

type Producer = Extract<ProjectEvent, { type: "offloaded" | "checkpointed" }>;

const foldProject = (events: ProjectEvent[]): CatalogProject => {
  const discarded = new Set<string>();
  for (const e of events) if (e.type === "snapshot-discarded") discarded.add(e.snapshot);

  // Kept producers, and each snapshot's first producer (events are sorted by id).
  const producers = events.filter(
    (e): e is Producer => (e.type === "offloaded" || e.type === "checkpointed") && !discarded.has(e.snapshot),
  );
  const made = new Map<string, Producer>();
  for (const e of producers) if (!made.has(e.snapshot)) made.set(e.snapshot, e);

  const depth = new Map<string, number>();
  let cyclic = false;
  for (const start of [...made.keys()].sort(compare)) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let at: string | undefined = start;
    let below = 0;
    while (at !== undefined && made.has(at)) {
      const known = depth.get(at);
      if (known !== undefined) {
        below = known;
        break;
      }
      if (onPath.has(at)) {
        cyclic = true; // only a broken writer makes one: cut here, and trust no head
        break;
      }
      path.push(at);
      onPath.add(at);
      at = made.get(at)?.base;
    }
    for (let i = path.length - 1; i >= 0; i--) depth.set(path[i] as string, ++below);
  }
  const depthOf = (snapshot: string | undefined): number =>
    snapshot === undefined ? 0 : (depth.get(snapshot) ?? 0);

  // Ancestry in O(1) (m12): a depth-first numbering of the forest of kept snapshots, hung from their first bases
  // (an unknown base is a node of its own, so it counts as an ancestor of what was made from it). `ancestor` is on
  // `snapshot`'s chain exactly when its interval encloses `snapshot`'s. Snapshots a cycle cuts off from every root
  // get no interval and fall back to a bounded walk, as only a broken writer makes one.
  const children = new Map<string, string[]>();
  const rootsOfForest: string[] = [];
  for (const [snapshot, e] of made) {
    if (e.base === undefined) rootsOfForest.push(snapshot);
    else if (e.base !== snapshot) {
      if (!made.has(e.base) && !children.has(e.base)) rootsOfForest.push(e.base);
      children.set(e.base, [...(children.get(e.base) ?? []), snapshot]);
    }
  }
  const enter = new Map<string, number>();
  const exit = new Map<string, number>();
  let clock = 0;
  for (const root of rootsOfForest) {
    const stack: { node: string; next: number }[] = [{ node: root, next: 0 }];
    enter.set(root, clock++);
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { node: string; next: number };
      const below = children.get(top.node) ?? [];
      if (top.next < below.length) {
        const child = below[top.next++] as string;
        enter.set(child, clock++);
        stack.push({ node: child, next: 0 });
      } else {
        exit.set(top.node, clock++);
        stack.pop();
      }
    }
  }
  /** Whether `ancestor` is `snapshot` or one of the snapshots it was made from. */
  const descends = (snapshot: string, ancestor: string): boolean => {
    const a = enter.get(snapshot);
    const b = enter.get(ancestor);
    if (a !== undefined && b !== undefined)
      return b <= a && (exit.get(snapshot) as number) <= (exit.get(ancestor) as number);
    for (let at: string | undefined = snapshot, steps = 0; at !== undefined && steps <= made.size; steps++) {
      if (at === ancestor) return true;
      at = made.get(at)?.base;
    }
    return false;
  };
  /** An onload's place: after `over` when over is a snapshot made from `base` (m2), else after `base`. */
  const anchorOf = (e: Extract<ProjectEvent, { type: "onloaded" }>): string =>
    e.over !== undefined && made.has(e.over) && descends(e.over, e.base) ? e.over : e.base;
  // Each event's place on the chain, computed once (m12).
  const positions = new Map<string, number>();
  const position = (e: ProjectEvent): number => {
    let at = positions.get(e.id);
    if (at === undefined) {
      at = e.type === "onloaded" ? 2 * depthOf(anchorOf(e)) + 1 : 2 * depthOf((e as Producer).snapshot);
      positions.set(e.id, at);
    }
    return at;
  };

  const offloads = producers.filter((e) => e.type === "offloaded");
  const onloads = events.filter((e) => e.type === "onloaded");

  // Status: the event furthest along the chain; the smallest id among equals.
  let tip: ProjectEvent | undefined;
  for (const e of [...offloads, ...onloads]) {
    if (tip === undefined || position(e) > position(tip) || (position(e) === position(tip) && e.id < tip.id))
      tip = e;
  }

  const byBase = new Map<string, Set<string>>();
  for (const e of producers) {
    const key = e.base ?? "";
    byBase.set(key, (byBase.get(key) ?? new Set()).add(e.snapshot));
  }
  const conflicts = [...byBase.values()]
    .filter((snaps) => snaps.size > 1)
    .map((snaps) => [...snaps].sort(compare))
    .sort((a, b) => compare(a.join(), b.join()));

  const parents = new Set(
    producers.flatMap((e) => (e.base === undefined || e.base === e.snapshot ? [] : [e.base])),
  );
  const heads = [...made.keys()].filter((s) => !parents.has(s) && made.get(s)?.base !== s).sort(compare);
  const held = (snapshot: string | undefined): boolean => snapshot === undefined || made.has(snapshot);
  const missing = [
    ...new Set(
      [...producers, ...onloads].flatMap((e) => [
        ...(held(e.base) ? [] : [e.base as string]),
        // An onload's `over` proves that a snapshot newer than `base` exists (D43): one the catalog does not hold
        // leaves the head incomplete (D41, m9), even though it is ignored for ordering above.
        ...(e.type === "onloaded" && !held(e.over) ? [e.over as string] : []),
      ]),
    ),
  ].sort(compare);
  const whole = conflicts.length === 0 && missing.length === 0 && !cyclic;

  // Each device's offload furthest along the chain closes every onload of that device before it.
  const furthestOffload = new Map<string, number>();
  for (const e of offloads)
    furthestOffload.set(e.device, Math.max(furthestOffload.get(e.device) ?? -1, position(e)));
  let lease: (typeof onloads)[number] | undefined;
  for (const o of onloads) {
    const closed = (furthestOffload.get(o.device) ?? -1) > position(o);
    if (closed) continue;
    if (
      lease === undefined ||
      position(o) > position(lease) ||
      (position(o) === position(lease) && o.id < lease.id)
    )
      lease = o;
  }

  const address = tip ?? (events[0] as ProjectEvent);
  const snapshots: CatalogProject["snapshots"] = {};
  for (const [id, e] of [...made.entries()].sort(([a], [b]) => compare(a, b))) {
    snapshots[id] = {
      kind: e.type,
      ...(e.base === undefined ? {} : { base: e.base }),
      event: e.id,
      device: e.device,
      at: e.at,
      stored: e.stored,
    };
  }
  return {
    root: address.root,
    path: address.path,
    status: conflicts.length > 0 ? "conflicted" : tip?.type === "offloaded" ? "shelved" : "local",
    head: whole && heads.length === 1 ? (heads[0] as string) : null,
    heads,
    lease:
      lease === undefined ? null : { device: lease.device, event: lease.id, base: lease.base, at: lease.at },
    conflicts,
    missing,
    discarded: [...discarded].sort(compare),
    snapshots,
  };
};

const foldRoots = (events: RootEvent[]): CatalogState["roots"] => {
  const roots: CatalogState["roots"] = {};
  const entry = (id: string): CatalogRoot => {
    roots[id] ??= { key: null, created: null, bindings: {} };
    return roots[id];
  };
  for (const e of events) {
    const root = entry(e.root);
    if (e.type === "root-created") {
      if (root.created !== null) continue; // sorted by id: the first one names the root
      root.key = e.key;
      root.created = e.id;
      if (e.label !== undefined) root.label = e.label;
    } else {
      root.bindings[e.device] = { path: e.path, event: e.id }; // sorted by id: the last one wins
    }
  }
  return roots;
};

/** Folds a set of catalog events into the state of every project and root. Pure; the order of `events` is irrelevant. */
export const foldCatalog = (events: readonly CatalogEvent[]): CatalogState => {
  const sorted = canonical(events);
  const byProject = new Map<string, ProjectEvent[]>();
  const rootEvents: RootEvent[] = [];
  for (const e of sorted) {
    if (!("project" in e)) rootEvents.push(e);
    else if (byProject.has(e.project)) byProject.get(e.project)?.push(e);
    else byProject.set(e.project, [e]);
  }
  const projects: CatalogState["projects"] = {};
  for (const id of [...byProject.keys()].sort(compare))
    projects[id] = foldProject(byProject.get(id) as ProjectEvent[]);
  return { projects, roots: foldRoots(rootEvents) };
};

/** Every root ULID created with this key, the first created (smallest root-created id) first. */
export const rootIdsForKey = (state: CatalogState, key: string): string[] =>
  Object.entries(state.roots)
    .filter(([, root]) => root.key === key && root.created !== null)
    .sort(([, a], [, b]) => compare(a.created as string, b.created as string))
    .map(([id]) => id);
