import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { ulid } from "../ulid.ts";
import { type CatalogEvent, type CatalogState, foldCatalog, rootIdsForKey } from "./index.ts";

// Property tests run at least 1,000 cases each (Task 11 stop condition).
const RUNS = { numRuns: 1000 };

const zero = (b: Uint8Array) => b;
const idAt = (ms: number) => ulid(ms, zero);
const PROJECT = idAt(1);
const ROOT = idAt(2);
const DEVICES = [idAt(3), idAt(4), idAt(5)] as const;
const [A, B] = DEVICES;
const RESTIC = "ab".repeat(32);
const stats = { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] };

// Readable ids for the unit tests: S(n) is a snapshot, E(n) an event; their order says nothing about history.
const S = (n: number) => idAt(1_000_000 + n);
const E = (n: number) => idAt(2_000_000 + n);

const base = (id: string, device: string) => ({
  v: 1 as const,
  id,
  device,
  at: "2026-10-03T12:00:00.000Z",
  op: id,
  project: PROJECT,
  root: ROOT,
  path: "clients/acme/web",
});
const registered = (id: string, device: string): CatalogEvent => ({
  ...base(id, device),
  type: "registered",
});
const offloaded = (id: string, device: string, snapshot: string, from?: string): CatalogEvent => ({
  ...base(id, device),
  type: "offloaded",
  ...(from === undefined ? {} : { base: from }),
  snapshot,
  stored: { ssd: RESTIC },
  stats,
});
const checkpointed = (id: string, device: string, snapshot: string, from?: string): CatalogEvent => ({
  ...base(id, device),
  type: "checkpointed",
  ...(from === undefined ? {} : { base: from }),
  snapshot,
  stored: { ssd: RESTIC },
  stats,
});
const onloaded = (id: string, device: string, from: string): CatalogEvent => ({
  ...base(id, device),
  type: "onloaded",
  base: from,
});
const discarded = (id: string, device: string, snapshot: string): CatalogEvent => ({
  ...base(id, device),
  type: "snapshot-discarded",
  snapshot,
  stored: { ssd: RESTIC },
});
const rootCreated = (id: string, device: string, root: string, key: string): CatalogEvent => ({
  v: 1,
  id,
  device,
  at: "2026-10-03T12:00:00.000Z",
  op: id,
  type: "root-created",
  root,
  key,
});
const rootBound = (id: string, device: string, root: string, path: string): CatalogEvent => ({
  v: 1,
  id,
  device,
  at: "2026-10-03T12:00:00.000Z",
  op: id,
  type: "root-bound",
  root,
  path,
});

const project = (state: CatalogState) => {
  const p = state.projects[PROJECT];
  if (p === undefined) throw new Error("project missing from the fold");
  return p;
};

describe("catalog: fold rules", () => {
  test("a registered project with no snapshot is local, with no head and no lease", () => {
    const p = project(foldCatalog([registered(E(1), A)]));
    expect(p).toMatchObject({ status: "local", head: null, heads: [], lease: null, conflicts: [] });
    expect(p.root).toBe(ROOT);
    expect(p.path).toBe("clients/acme/web");
  });

  test("offload shelves; onload makes it local and opens the lease; the next offload closes it", () => {
    const first = [registered(E(1), A), offloaded(E(2), A, S(1))];
    expect(project(foldCatalog(first))).toMatchObject({ status: "shelved", head: S(1), lease: null });

    const onload = [...first, onloaded(E(3), B, S(1))];
    expect(project(foldCatalog(onload))).toMatchObject({
      status: "local",
      head: S(1),
      lease: { device: B, event: E(3), base: S(1) },
    });

    const again = [...onload, offloaded(E(4), B, S(2), S(1))];
    expect(project(foldCatalog(again))).toMatchObject({
      status: "shelved",
      head: S(2),
      heads: [S(2)],
      lease: null,
    });
  });

  test("status follows the base chain, not timestamps or ids", () => {
    // The offload of S2 has the smaller id and the earlier clock, but its base is the snapshot B onloaded.
    const events = [
      { ...offloaded(E(9), A, S(1)), at: "2026-10-03T12:00:00.000Z" },
      { ...onloaded(E(8), B, S(1)), at: "2026-10-03T13:00:00.000Z" },
      { ...offloaded(E(1), B, S(2), S(1)), at: "2020-01-01T00:00:00.000Z" },
    ];
    expect(project(foldCatalog(events))).toMatchObject({ status: "shelved", head: S(2), lease: null });
  });

  test("two offloaded events with the same base are conflicted, with both snapshots kept as heads", () => {
    const events = [
      offloaded(E(1), A, S(1)),
      onloaded(E(2), A, S(1)),
      onloaded(E(3), B, S(1)),
      offloaded(E(4), A, S(2), S(1)),
      offloaded(E(5), B, S(3), S(1)),
    ];
    const p = project(foldCatalog(events));
    expect(p.status).toBe("conflicted");
    expect(p.heads).toEqual([S(2), S(3)]);
    expect(p.head).toBeNull();
    expect(p.conflicts).toEqual([[S(2), S(3)]]);
  });

  test("two first offloads (no base) of one project are conflicted too", () => {
    const p = project(foldCatalog([offloaded(E(1), A, S(1)), offloaded(E(2), B, S(2))]));
    expect(p.status).toBe("conflicted");
    expect(p.conflicts).toEqual([[S(1), S(2)]]);
  });

  test("a conflict stays until resolved, even after work continues on one side", () => {
    const events = [
      offloaded(E(1), A, S(1)),
      offloaded(E(2), A, S(2), S(1)),
      offloaded(E(3), B, S(3), S(1)),
      onloaded(E(4), A, S(3)),
      offloaded(E(5), A, S(4), S(3)),
    ];
    const p = project(foldCatalog(events));
    expect(p.status).toBe("conflicted");
    // D41: a conflicted project has no head; both branch tips are listed.
    expect(p.head).toBeNull();
    expect(p.heads).toEqual([S(2), S(4)]);
  });

  test("a fork through a checkpoint is conflicted too (D41): any kept snapshot with two kept children", () => {
    // The spec review's example: A and B both onload S1; A checkpoints S2; B offloads S3; A offloads S4 from S2.
    const events = [
      offloaded(E(1), A, S(1)),
      onloaded(E(2), A, S(1)),
      onloaded(E(3), B, S(1)),
      checkpointed(E(4), A, S(2), S(1)),
      offloaded(E(5), B, S(3), S(1)),
      offloaded(E(6), A, S(4), S(2)),
    ];
    const p = project(foldCatalog(events));
    expect(p.status).toBe("conflicted");
    expect(p.head).toBeNull();
    expect(p.conflicts).toEqual([[S(2), S(3)]]);
    expect(p.heads).toEqual([S(3), S(4)]);
  });

  test("two checkpoints from one snapshot are a fork as well", () => {
    const events = [
      offloaded(E(1), A, S(1)),
      checkpointed(E(2), A, S(2), S(1)),
      checkpointed(E(3), B, S(3), S(1)),
    ];
    expect(project(foldCatalog(events))).toMatchObject({
      status: "conflicted",
      head: null,
      conflicts: [[S(2), S(3)]],
    });
  });

  test("a checkpoint moves the head but not the status, and keeps the lease", () => {
    const events = [offloaded(E(1), A, S(1)), onloaded(E(2), A, S(1)), checkpointed(E(3), A, S(2), S(1))];
    expect(project(foldCatalog(events))).toMatchObject({
      status: "local",
      head: S(2),
      lease: { device: A, base: S(1) },
    });
    const offload = [...events, offloaded(E(4), A, S(3), S(2))];
    expect(project(foldCatalog(offload))).toMatchObject({ status: "shelved", head: S(3), lease: null });
  });

  test("a discarded snapshot is never a head, even if an offloaded event names it (D28)", () => {
    const events = [
      offloaded(E(1), A, S(1)),
      onloaded(E(2), A, S(1)),
      discarded(E(3), A, S(2)),
      // A buggy or forged offloaded naming the discarded snapshot changes nothing.
      offloaded(E(4), A, S(2), S(1)),
      checkpointed(E(5), A, S(2), S(1)),
    ];
    const p = project(foldCatalog(events));
    expect(p).toMatchObject({ status: "local", head: S(1), heads: [S(1)], lease: { device: A } });
    expect(p.discarded).toEqual([S(2)]);
    expect(Object.keys(p.snapshots)).toEqual([S(1)]);
  });

  test("a discarded snapshot does not make a conflict", () => {
    const events = [
      offloaded(E(1), A, S(1)),
      offloaded(E(2), A, S(2), S(1)),
      offloaded(E(3), A, S(3), S(1)),
      discarded(E(4), A, S(3)),
    ];
    expect(project(foldCatalog(events))).toMatchObject({ status: "shelved", head: S(2), conflicts: [] });
  });

  test("two devices onloading one snapshot: exactly one lease, and only that device's offload ends it", () => {
    const events = [offloaded(E(1), A, S(1)), onloaded(E(2), A, S(1)), onloaded(E(3), B, S(1))];
    const both = project(foldCatalog(events));
    expect(both.lease?.device).toBe(A);

    // B offloads: B's copy is gone, A's onload is still open, so A holds the lease while the project is shelved.
    const bOff = project(foldCatalog([...events, offloaded(E(4), B, S(2), S(1))]));
    expect(bOff).toMatchObject({ status: "shelved", head: S(2), lease: { device: A, event: E(2) } });
  });

  test("a later onload along the chain takes the lease over an older open one", () => {
    const events = [
      offloaded(E(1), A, S(1)),
      onloaded(E(2), A, S(1)),
      onloaded(E(3), B, S(1)),
      offloaded(E(4), B, S(2), S(1)),
      onloaded(E(5), B, S(2)),
    ];
    expect(project(foldCatalog(events)).lease).toMatchObject({ device: B, event: E(5), base: S(2) });
  });

  test("a base the catalog does not hold marks the head incomplete, never an older snapshot (D41)", () => {
    const unknownBase = project(foldCatalog([offloaded(E(1), A, S(2), S(1))]));
    expect(unknownBase).toMatchObject({ status: "shelved", head: null, missing: [S(1)] });
    // A mirror that lost S3's event: S1 <- S2 <- (S3) <- S4. S2 must not become the head.
    const gap = project(
      foldCatalog([offloaded(E(1), A, S(1)), offloaded(E(2), A, S(2), S(1)), offloaded(E(4), A, S(4), S(3))]),
    );
    expect(gap).toMatchObject({ head: null, missing: [S(3)] });
    // An onload of a snapshot the catalog lacks is a gap too.
    expect(project(foldCatalog([offloaded(E(1), A, S(1)), onloaded(E(2), A, S(9))]))).toMatchObject({
      head: null,
      missing: [S(9)],
    });
    // With every event present, the head is back and nothing is missing.
    const whole = project(
      foldCatalog([
        offloaded(E(1), A, S(1)),
        offloaded(E(2), A, S(2), S(1)),
        offloaded(E(3), A, S(3), S(2)),
        offloaded(E(4), A, S(4), S(3)),
      ]),
    );
    expect(whole).toMatchObject({ head: S(4), missing: [] });
  });

  test("a cycle of bases still folds, whatever the order", () => {
    const cycle = foldCatalog([offloaded(E(1), A, S(1), S(2)), offloaded(E(2), A, S(2), S(1))]);
    expect(project(cycle).head).toBeNull(); // only a broken writer makes a cycle: no head is trusted
    const reversed = foldCatalog([offloaded(E(2), A, S(2), S(1)), offloaded(E(1), A, S(1), S(2))]);
    expect(reversed).toEqual(cycle);
  });

  test("roots: created by key, each device's latest binding by event id; duplicates of an event change nothing", () => {
    const other = idAt(6);
    const events = [
      rootCreated(E(1), A, ROOT, "work"),
      rootBound(E(2), A, ROOT, "~/work"),
      rootBound(E(5), A, ROOT, "~/code/work"),
      rootBound(E(3), B, ROOT, "/srv/work"),
      rootCreated(E(4), B, other, "work"),
    ];
    const state = foldCatalog([...events, ...events]);
    expect(state.roots[ROOT]).toEqual({
      key: "work",
      created: E(1),
      bindings: { [A]: { path: "~/code/work", event: E(5) }, [B]: { path: "/srv/work", event: E(3) } },
    });
    expect(rootIdsForKey(state, "work")).toEqual([ROOT, other]);
    expect(rootIdsForKey(state, "personal")).toEqual([]);
  });

  test("a binding for a root whose root-created event has not arrived is kept, with no key yet", () => {
    const state = foldCatalog([rootBound(E(1), A, ROOT, "~/work")]);
    expect(state.roots[ROOT]).toEqual({
      key: null,
      created: null,
      bindings: { [A]: { path: "~/work", event: E(1) } },
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Property tests. Histories are simulated from random steps on three devices, with ids drawn from a random pool so
// that id order says nothing about the order things happened in.

type Kind = "register" | "onload" | "offload" | "checkpoint" | "discard" | "create-root" | "bind";
interface Step {
  kind: Kind;
  device: number;
  pick: number;
}
/** Mostly onloads and offloads, so leases, races and conflicts are common. */
const kindArb: fc.Arbitrary<Kind> = fc.oneof(
  { arbitrary: fc.constant("onload" as const), weight: 5 },
  { arbitrary: fc.constant("offload" as const), weight: 5 },
  { arbitrary: fc.constant("checkpoint" as const), weight: 2 },
  {
    arbitrary: fc.constantFrom(
      "register" as const,
      "discard" as const,
      "create-root" as const,
      "bind" as const,
    ),
    weight: 2,
  },
);
const stepArb: fc.Arbitrary<Step> = fc.record({
  kind: kindArb,
  device: fc.integer({ min: 0, max: 2 }),
  pick: fc.nat({ max: 1000 }),
});
const POOL = 80;
const historyArb = fc.record({
  steps: fc.array(stepArb, { minLength: 1, maxLength: 30, size: "max" }),
  times: fc.uniqueArray(fc.integer({ min: 10_000_000, max: 2 ** 47 - 1 }), {
    minLength: POOL,
    maxLength: POOL,
  }),
});

const ids = (times: number[]) => {
  let next = 0;
  return () => idAt(times[next++] as number);
};
const randomAt = (time: number) => new Date(1_700_000_000_000 + (time % 10_000_000_000)).toISOString();

/** Any interleaving, races included: devices onload any snapshot and offload whatever copy they hold. */
const simulate = ({ steps, times }: { steps: Step[]; times: number[] }): CatalogEvent[] => {
  const id = ids(times);
  const snaps: string[] = [];
  const copy: (string | undefined)[] = [undefined, undefined, undefined];
  const events: CatalogEvent[] = [];
  const push = (event: CatalogEvent) =>
    events.push({ ...event, at: randomAt(times[events.length] as number) });
  for (const { kind, device, pick } of steps) {
    const dev = DEVICES[device] as string;
    const held = copy[device];
    switch (kind) {
      case "register":
        push(registered(id(), dev));
        break;
      case "onload": {
        if (snaps.length === 0) break;
        const s = snaps[pick % snaps.length] as string;
        push(onloaded(id(), dev, s));
        copy[device] = s;
        break;
      }
      case "offload": {
        if (held === undefined && snaps.length > 0 && pick % 3 !== 0) break; // a stale offload now and then
        const s = id();
        push(offloaded(id(), dev, s, held));
        snaps.push(s);
        copy[device] = undefined;
        break;
      }
      case "checkpoint": {
        if (held === undefined) break;
        const s = id();
        push(checkpointed(id(), dev, s, held));
        snaps.push(s);
        copy[device] = s;
        break;
      }
      case "discard":
        push(discarded(id(), dev, id()));
        break;
      case "create-root":
        push(rootCreated(id(), dev, pick % 2 === 0 ? ROOT : idAt(7), pick % 3 === 0 ? "personal" : "work"));
        break;
      case "bind":
        push(rootBound(id(), dev, pick % 2 === 0 ? ROOT : idAt(7), `/w/${pick}`));
        break;
    }
  }
  return events;
};

/** Events wired at random: bases point anywhere in a small pool, so cycles, unknown bases and forks all occur. */
const tangledArb = fc
  .array(
    fc.record({
      kind: fc.constantFrom("offloaded", "checkpointed", "onloaded", "snapshot-discarded"),
      device: fc.integer({ min: 0, max: 2 }),
      snapshot: fc.integer({ min: 0, max: 7 }),
      base: fc.option(fc.integer({ min: 0, max: 7 }), { nil: undefined }),
      time: fc.integer({ min: 10_000_000, max: 2 ** 47 - 1 }),
    }),
    { maxLength: 25 },
  )
  .map((rows) => {
    const seen = new Set<number>();
    return rows
      .filter((row) => !seen.has(row.time) && seen.add(row.time))
      .map((row): CatalogEvent => {
        const id = idAt(row.time);
        const dev = DEVICES[row.device] as string;
        switch (row.kind) {
          case "offloaded":
            return offloaded(id, dev, S(row.snapshot), row.base === undefined ? undefined : S(row.base));
          case "checkpointed":
            return checkpointed(id, dev, S(row.snapshot), row.base === undefined ? undefined : S(row.base));
          case "onloaded":
            return onloaded(id, dev, S(row.base ?? row.snapshot));
          default:
            return discarded(id, dev, S(row.snapshot));
        }
      });
  });

const withPermutation = (arb: fc.Arbitrary<CatalogEvent[]>) =>
  arb.chain((events) =>
    fc.tuple(
      fc.constant(events),
      fc.shuffledSubarray(events, { minLength: events.length, maxLength: events.length }),
    ),
  );

describe("catalog: fold properties (fast-check)", () => {
  test("a head is only ever named for a complete, unconflicted chain, and it is the one tip", () => {
    fc.assert(
      fc.property(fc.oneof(historyArb.map(simulate), tangledArb), (events) => {
        for (const p of Object.values(foldCatalog(events).projects)) {
          if (p.head === null) continue;
          expect(p.missing).toEqual([]);
          expect(p.conflicts).toEqual([]);
          expect(p.heads).toEqual([p.head]);
          // No kept snapshot is made from the head.
          expect(Object.values(p.snapshots).some((s) => s.base === p.head)).toBe(false);
        }
      }),
      RUNS,
    );
  });

  test("invariant 4: folding any permutation of simulated histories gives the same state", () => {
    fc.assert(
      fc.property(withPermutation(historyArb.map(simulate)), ([events, shuffled]) => {
        expect(foldCatalog(shuffled)).toEqual(foldCatalog(events));
      }),
      RUNS,
    );
  });

  test("invariant 4: folding any permutation of randomly wired events (cycles, forks, unknown bases) gives the same state", () => {
    fc.assert(
      fc.property(withPermutation(tangledArb), ([events, shuffled]) => {
        expect(foldCatalog(shuffled)).toEqual(foldCatalog(events));
      }),
      RUNS,
    );
  });

  test("replication is a union: events seen twice fold the same as once", () => {
    fc.assert(
      fc.property(
        historyArb.map(simulate).chain((events) => fc.tuple(fc.constant(events), fc.subarray(events))),
        ([events, again]) => {
          expect(foldCatalog([...again, ...events, ...again])).toEqual(foldCatalog(events));
        },
      ),
      RUNS,
    );
  });

  test("invariant 5: at most one lease per project, held by a device whose onload is still open", () => {
    fc.assert(
      fc.property(fc.oneof(historyArb.map(simulate), tangledArb), (events) => {
        for (const p of Object.values(foldCatalog(events).projects)) {
          if (p.lease === null) continue;
          const lease = p.lease;
          // A single object by construction; check it names a real onloaded event by that device.
          const opened = events.find((e) => e.id === lease.event);
          expect(opened).toMatchObject({ type: "onloaded", device: lease.device, base: lease.base });
        }
      }),
      RUNS,
    );
  });

  test("conflicted exactly when a kept snapshot (or no base) has two kept children (D41)", () => {
    fc.assert(
      fc.property(fc.oneof(historyArb.map(simulate), tangledArb), (events) => {
        const dropped = new Set(events.flatMap((e) => (e.type === "snapshot-discarded" ? [e.snapshot] : [])));
        const byBase = new Map<string, Set<string>>();
        for (const e of events) {
          if ((e.type !== "offloaded" && e.type !== "checkpointed") || dropped.has(e.snapshot)) continue;
          const key = e.base ?? "";
          byBase.set(key, (byBase.get(key) ?? new Set()).add(e.snapshot));
        }
        const expected = [...byBase.values()].some((snaps) => snaps.size > 1);
        const p = foldCatalog(events).projects[PROJECT];
        if (p !== undefined) expect(p.status === "conflicted").toBe(expected);
      }),
      RUNS,
    );
  });

  test("a sequential history (one working copy at a time) folds to the model's status, head and lease", () => {
    fc.assert(
      fc.property(historyArb, ({ steps, times }) => {
        const id = ids(times);
        const events: CatalogEvent[] = [registered(id(), A)];
        let holder: number | null = null;
        let head: string | undefined;
        let last: "shelved" | "local" = "local";
        for (const { kind, device, pick } of steps) {
          if (kind === "onload" && holder === null && head !== undefined) {
            events.push(onloaded(id(), DEVICES[device] as string, head));
            holder = device;
            last = "local";
          } else if (kind === "offload" && (holder !== null || head === undefined)) {
            const s = id();
            events.push(offloaded(id(), DEVICES[holder ?? device] as string, s, head));
            head = s;
            holder = null;
            last = "shelved";
          } else if (kind === "checkpoint" && holder !== null) {
            const s = id();
            events.push(checkpointed(id(), DEVICES[holder] as string, s, head));
            head = s;
          } else if (kind === "discard" && holder !== null && pick % 2 === 0) {
            events.push(discarded(id(), DEVICES[holder] as string, id()));
          }
        }
        const p = project(foldCatalog(events));
        expect(p.status).toBe(last);
        expect(p.head).toBe(head ?? null);
        expect(p.lease?.device ?? null).toBe(holder === null ? null : (DEVICES[holder] as string));
      }),
      RUNS,
    );
  });
});
