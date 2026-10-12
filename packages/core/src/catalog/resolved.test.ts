import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { ulid } from "../ulid.ts";
import {
  type CatalogEvent,
  type CatalogProject,
  foldCatalog,
  type Resolution,
  resolutionFor,
} from "./index.ts";

// Task 12: the causal resolution model (Q18). One row per history, each with the exact outcome; then the production
// rule's output is folded back in and must be valid; then permutation invariance over histories built from the rows.

const RUNS = { numRuns: 1000 };

const zero = (b: Uint8Array) => b;
const idAt = (ms: number) => ulid(ms, zero);
const PROJECT = idAt(1);
const OTHER = idAt(6);
const ROOT = idAt(2);
const [A, B] = [idAt(3), idAt(4)];
const RESTIC = "ab".repeat(32);
const stats = { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] };

// S(n) is a snapshot, E(n) an event; their order says nothing about history.
const S = (n: number) => idAt(1_000_000 + n);
const E = (n: number) => idAt(2_000_000 + n);

const common = (id: string, device: string, project = PROJECT) => ({
  v: 1 as const,
  id,
  device,
  at: "2026-10-03T12:00:00.000Z",
  op: id,
  project,
  root: ROOT,
  path: project === PROJECT ? "clients/acme/web" : "clients/acme/api",
});
const offloaded = (id: string, snapshot: string, from?: string, project = PROJECT): CatalogEvent => ({
  ...common(id, A, project),
  type: "offloaded",
  ...(from === undefined ? {} : { base: from }),
  snapshot,
  stored: { ssd: RESTIC },
  stats,
});
const checkpointed = (id: string, snapshot: string, from: string): CatalogEvent => ({
  ...common(id, B),
  type: "checkpointed",
  base: from,
  snapshot,
  stored: { ssd: RESTIC },
  stats,
});
const resolved = (
  id: string,
  keep: string,
  over: string[],
  supersedes: string[] = [],
  project = PROJECT,
): CatalogEvent => ({ ...common(id, A, project), type: "resolved", keep, over, supersedes });

const project = (events: readonly CatalogEvent[], id = PROJECT): CatalogProject => {
  const p = foldCatalog(events).projects[id];
  if (p === undefined) throw new Error("project missing from the fold");
  return p;
};

/** The outcome a row states. */
const outcome = (p: CatalogProject) => ({
  status: p.status,
  head: p.head,
  heads: p.heads,
  conflicts: p.conflicts,
});

// The shared starting points.
const root = offloaded(E(1), S(0));
/** S0 → S1, S2: a plain fork. */
const fork = [root, offloaded(E(2), S(1), S(0)), offloaded(E(3), S(2), S(0))];
/** S0 → S1, S2, S3. */
const fork3 = [...fork, offloaded(E(4), S(3), S(0))];
/** S0 → S1, S2, S3, S4. */
const fork4 = [...fork3, offloaded(E(5), S(4), S(0))];
/** S0 → S1, S2; S1 → S11, S12. */
const nested = [...fork, offloaded(E(6), S(11), S(1)), offloaded(E(7), S(12), S(1))];
/** Another project, with a snapshot and a resolution of its own. */
const elsewhere = [
  offloaded(E(80), S(90), undefined, OTHER),
  offloaded(E(81), S(91), undefined, OTHER),
  resolved(E(82), S(90), [S(91)], [], OTHER),
];

type Outcome = ReturnType<typeof outcome>;

const unresolved: Outcome = {
  status: "conflicted",
  head: null,
  heads: [S(1), S(2)],
  conflicts: [[S(1), S(2)]],
};
const settledOn = (head: string): Outcome => ({ status: "shelved", head, heads: [head], conflicts: [] });

interface Row {
  name: string;
  events: CatalogEvent[];
  expect: Outcome;
  /** The resolutions skipped as invalid. */
  invalid?: string[];
  missing?: string[];
  /** A writer acting on this read keeps this snapshot (the production rule). */
  act?: string;
}

const rows: Row[] = [
  { name: "a plain fork, unresolved (M1's rule)", events: fork, expect: unresolved, act: S(1) },
  {
    name: "a plain fork resolved",
    events: [...fork, resolved(E(20), S(1), [S(2)])],
    expect: settledOn(S(1)),
  },
  {
    name: "the kept line continued after the resolution: settled, the head moves",
    events: [...fork, resolved(E(20), S(1), [S(2)]), offloaded(E(21), S(5), S(1))],
    expect: settledOn(S(5)),
  },
  {
    name: "competing resolutions, keep S1 and keep S2: conflicted",
    events: [...fork, resolved(E(20), S(1), [S(2)]), resolved(E(21), S(2), [S(1)])],
    expect: unresolved,
    act: S(2),
  },
  {
    name: "competing resolutions, then one superseding both: settled",
    events: [
      ...fork,
      resolved(E(20), S(1), [S(2)]),
      resolved(E(21), S(2), [S(1)]),
      resolved(E(22), S(2), [S(1)], [E(20), E(21)]),
    ],
    expect: settledOn(S(2)),
  },
  {
    name: "two resolutions agreeing on keep with different over sets: combined",
    events: [...fork3, resolved(E(20), S(1), [S(2)]), resolved(E(21), S(1), [S(3)])],
    expect: settledOn(S(1)),
  },
  {
    name: "partial overlap, the same keep: combined",
    events: [...fork4, resolved(E(20), S(1), [S(2), S(3)]), resolved(E(21), S(1), [S(3), S(4)])],
    expect: settledOn(S(1)),
  },
  {
    name: "partial overlap, one keeps what the other rejects: conflicted",
    events: [...fork3, resolved(E(20), S(1), [S(2), S(3)]), resolved(E(21), S(3), [S(2)])],
    expect: { status: "conflicted", head: null, heads: [S(1), S(3)], conflicts: [[S(1), S(3)]] },
    act: S(3),
  },
  {
    name: "a resolution that names only some live tips leaves the rest conflicted",
    events: [...fork3, resolved(E(20), S(1), [S(2)])],
    expect: { status: "conflicted", head: null, heads: [S(1), S(3)], conflicts: [[S(1), S(3)]] },
    act: S(1),
  },
  {
    name: "a delayed descendant of a rejected tip, made before the resolution, delivered after: conflicted",
    // E(9) sorts before the resolution: ids carry no order, only the set matters.
    events: [...fork, offloaded(E(9), S(6), S(2)), resolved(E(20), S(1), [S(2)])],
    expect: { status: "conflicted", head: null, heads: [S(1), S(6)], conflicts: [[S(1), S(2)]] },
    act: S(1),
  },
  {
    name: "a descendant made after the resolution, from the rejected tip: conflicted",
    events: [...fork, resolved(E(20), S(1), [S(2)]), checkpointed(E(21), S(6), S(2))],
    expect: { status: "conflicted", head: null, heads: [S(1), S(6)], conflicts: [[S(1), S(2)]] },
    act: S(6),
  },
  {
    name: "a nested fork, unresolved",
    events: nested,
    expect: {
      status: "conflicted",
      head: null,
      heads: [S(2), S(11), S(12)],
      conflicts: [
        [S(1), S(2)],
        [S(11), S(12)],
      ],
    },
    act: S(11),
  },
  {
    name: "a nested fork, the inner fork resolved: the outer stays conflicted",
    events: [...nested, resolved(E(20), S(11), [S(12)])],
    expect: { status: "conflicted", head: null, heads: [S(2), S(11)], conflicts: [[S(1), S(2)]] },
    act: S(2),
  },
  {
    name: "a nested fork, both forks resolved by disjoint resolutions: combined",
    events: [...nested, resolved(E(20), S(11), [S(12)]), resolved(E(21), S(11), [S(2)])],
    expect: settledOn(S(11)),
  },
  {
    name: "a nested fork resolved at once",
    events: [...nested, resolved(E(20), S(11), [S(2), S(12)])],
    expect: settledOn(S(11)),
  },
  // Invalid: each skipped, tainting, and the fork stays as it was.
  {
    name: "invalid: keep ∈ over",
    events: [...fork, resolved(E(20), S(1), [S(1), S(2)])],
    expect: unresolved,
    invalid: [E(20)],
  },
  {
    name: "invalid: empty over",
    events: [...fork, resolved(E(20), S(1), [])],
    expect: unresolved,
    invalid: [E(20)],
  },
  {
    name: "invalid: supersedes names another project's resolution",
    events: [...fork, ...elsewhere, resolved(E(20), S(1), [S(2)], [E(82)])],
    expect: unresolved,
    invalid: [E(20)],
  },
  {
    name: "invalid: supersedes names an offloaded event",
    events: [...fork, resolved(E(20), S(1), [S(2)], [E(2)])],
    expect: unresolved,
    invalid: [E(20)],
  },
  {
    name: "invalid: supersedes names a snapshot",
    events: [...fork, resolved(E(20), S(1), [S(2)], [S(2)])],
    expect: unresolved,
    invalid: [E(20)],
  },
  {
    name: "invalid: self-supersession",
    events: [...fork, resolved(E(20), S(1), [S(2)], [E(20)])],
    expect: unresolved,
    invalid: [E(20)],
  },
  {
    name: "invalid: a two-cycle of supersedes",
    events: [...fork, resolved(E(20), S(1), [S(2)], [E(21)]), resolved(E(21), S(1), [S(2)], [E(20)])],
    expect: unresolved,
    invalid: [E(20), E(21)],
  },
  {
    name: "invalid: a three-cycle, and a resolution superseding into it stays valid",
    events: [
      ...fork,
      resolved(E(20), S(2), [S(1)], [E(22)]),
      resolved(E(21), S(2), [S(1)], [E(20)]),
      resolved(E(22), S(2), [S(1)], [E(21)]),
      resolved(E(23), S(1), [S(2)], [E(20)]),
    ],
    expect: settledOn(S(1)),
    invalid: [E(20), E(21), E(22)],
  },
  {
    name: "invalid: keep is another project's snapshot",
    events: [...fork, ...elsewhere, resolved(E(20), S(90), [S(1), S(2)])],
    expect: unresolved,
    invalid: [E(20)],
  },
  {
    name: "invalid: over names another project's snapshot",
    events: [...fork, ...elsewhere, resolved(E(20), S(1), [S(2), S(91)])],
    expect: unresolved,
    invalid: [E(20)],
  },
  {
    name: "invalid: keep names an event, not a snapshot",
    events: [...fork, resolved(E(20), E(2), [S(2)])],
    expect: unresolved,
    invalid: [E(20)],
  },
  {
    name: "an invalid resolution that supersedes a valid one does not retire it",
    events: [...fork, resolved(E(20), S(1), [S(2)]), resolved(E(21), S(2), [S(2)], [E(20)])],
    expect: settledOn(S(1)),
    invalid: [E(21)],
  },
  // Incomplete: well formed, naming what the catalog does not hold yet.
  {
    name: "incomplete: an unknown over snapshot leaves the head incomplete",
    events: [...fork, resolved(E(20), S(1), [S(2), S(7)])],
    expect: unresolved,
    missing: [S(7)],
  },
  {
    name: "incomplete: the unknown over snapshot delivered",
    events: [...fork, resolved(E(20), S(1), [S(2), S(7)]), offloaded(E(8), S(7), S(0))],
    expect: settledOn(S(1)),
  },
  {
    name: "incomplete: an unknown supersedes target leaves the head incomplete",
    events: [...fork, resolved(E(21), S(1), [S(2)], [E(30)])],
    expect: unresolved,
    missing: [E(30)],
  },
  {
    name: "incomplete: the unknown supersedes target delivered",
    events: [...fork, resolved(E(21), S(1), [S(2)], [E(30)]), resolved(E(30), S(2), [S(1)])],
    expect: settledOn(S(1)),
  },
];

describe("resolved: the causal resolution model, one row per history", () => {
  for (const row of rows) {
    test(row.name, () => {
      const p = project(row.events);
      expect(outcome(p)).toEqual(row.expect);
      expect(p.invalid).toEqual(row.invalid ?? []);
      expect(p.missing).toEqual(row.missing ?? []);
    });
  }

  test("incompleteness keeps the head null even when the rest would settle", () => {
    const p = project([...fork, resolved(E(20), S(1), [S(2)]), resolved(E(21), S(1), [S(2)], [E(30)])]);
    expect(p.head).toBeNull();
    expect(p.missing).toEqual([E(30)]);
  });

  test("a resolution in another project never touches this one", () => {
    expect(outcome(project([...fork, ...elsewhere]))).toEqual(unresolved);
    expect(outcome(project([...fork, ...elsewhere], OTHER))).toEqual({
      status: "shelved",
      head: S(90),
      heads: [S(90)],
      conflicts: [],
    });
  });

  test("status and the lease follow the kept line, not a deeper rejected one", () => {
    // S2's line is deeper (S2 → S21); S1's device onloads after the resolution keeps S1.
    const events: CatalogEvent[] = [
      ...fork,
      checkpointed(E(10), S(21), S(2)),
      offloaded(E(11), S(22), S(21)),
      resolved(E(20), S(1), [S(22)]),
      { ...common(E(21), B), type: "onloaded", base: S(1), over: S(1) },
    ];
    const p = project(events);
    expect(outcome(p)).toEqual({ status: "local", head: S(1), heads: [S(1)], conflicts: [] });
    expect(p.lease).toMatchObject({ device: B, event: E(21), base: S(1) });
  });

  test("the fold exposes the active resolutions and the rejected snapshots", () => {
    const p = project([
      ...fork3,
      resolved(E(20), S(1), [S(2)]),
      resolved(E(21), S(1), [S(3)]),
      resolved(E(22), S(1), [S(2), S(3)], [E(20)]),
    ]);
    expect(p.resolutions).toEqual([E(21), E(22)]);
    expect(p.rejected).toEqual([S(2), S(3)]);
  });
});

/** The production rule's output written as the next event. */
const write = (events: CatalogEvent[], keep: string, id: string): CatalogEvent[] => {
  const made = resolutionFor(project(events), keep);
  if (!made.ok) throw new Error(`resolutionFor refused: ${made.reason}`);
  return [...events, resolved(id, made.value.keep, made.value.over, made.value.supersedes)];
};

describe("resolved: the production rule (resolutionFor)", () => {
  for (const row of rows.filter((r) => r.act !== undefined)) {
    test(`writes a valid, active resolution that settles: ${row.name}`, () => {
      const after = write(row.events, row.act as string, E(99));
      const p = project(after);
      expect(p.invalid).toEqual(row.invalid ?? []);
      expect(p.resolutions).toEqual([E(99)]);
      expect(outcome(p)).toEqual(settledOn(row.act as string));
    });
  }

  test("competing production: two writers on one read stay conflicted, a third read settles it", () => {
    const one = resolutionFor(project(fork), S(1));
    const two = resolutionFor(project(fork), S(2));
    if (!one.ok || !two.ok) throw new Error("refused");
    const both = [
      ...fork,
      resolved(E(40), one.value.keep, one.value.over, one.value.supersedes),
      resolved(E(41), two.value.keep, two.value.over, two.value.supersedes),
    ];
    expect(outcome(project(both))).toEqual(unresolved);
    const settled = project(write(both, S(2), E(42)));
    expect(settled.resolutions).toEqual([E(42)]);
    expect(outcome(settled)).toEqual(settledOn(S(2)));
  });

  test("the exact fields: over is the live tips minus keep, supersedes every active resolution", () => {
    const events = [...fork3, resolved(E(20), S(1), [S(2)]), resolved(E(21), S(3), [S(2)])];
    expect(resolutionFor(project(events), S(3))).toEqual({
      ok: true,
      value: { keep: S(3), over: [S(1)], supersedes: [E(20), E(21)] } satisfies Resolution,
    });
  });

  test("refuses a keep that is not a live tip, a settled project and an incomplete read", () => {
    const resolvedFork = [...fork, resolved(E(20), S(1), [S(2)])];
    expect(resolutionFor(project(fork), S(0))).toEqual({ ok: false, reason: "not-a-live-tip" });
    expect(
      resolutionFor(project([...fork, resolved(E(20), S(1), [S(2)]), checkpointed(E(21), S(6), S(2))]), S(2)),
    ).toEqual({
      ok: false,
      reason: "not-a-live-tip",
    });
    expect(resolutionFor(project(resolvedFork), S(1))).toEqual({ ok: false, reason: "nothing-to-resolve" });
    expect(resolutionFor(project([...fork, resolved(E(20), S(1), [S(2), S(7)])]), S(1))).toEqual({
      ok: false,
      reason: "incomplete",
    });
  });
});

// Histories built from the rows: a row's events, plus production-rule resolutions written on random partial reads
// (a writer reads a subset), then folded in every order.
const historyArb = fc
  .record({
    row: fc.integer({ min: 0, max: rows.length - 1 }),
    writers: fc.array(fc.record({ seen: fc.nat(), pick: fc.nat() }), { maxLength: 4 }),
  })
  .map(({ row, writers }) => {
    let events = [...(rows[row] as Row).events];
    writers.forEach((w, i) => {
      // A writer read a prefix of the events in some order: what it saw is a subset of what exists.
      const read = events.slice(0, 1 + (w.seen % events.length));
      const p = foldCatalog(read).projects[PROJECT];
      if (p === undefined || p.heads.length === 0) return;
      const keep = p.heads[w.pick % p.heads.length] as string;
      const made = resolutionFor(p, keep);
      if (made.ok)
        events = [...events, resolved(E(60 + i), made.value.keep, made.value.over, made.value.supersedes)];
    });
    return events;
  });

describe("resolved: fold properties (fast-check)", () => {
  test("folding any permutation of a history with resolutions gives the same state", () => {
    fc.assert(
      fc.property(
        historyArb.chain((events) =>
          fc.tuple(
            fc.constant(events),
            fc.shuffledSubarray(events, { minLength: events.length, maxLength: events.length }),
          ),
        ),
        ([events, shuffled]) => {
          expect(foldCatalog(shuffled)).toEqual(foldCatalog(events));
          expect(foldCatalog([...shuffled, ...events])).toEqual(foldCatalog(events));
        },
      ),
      RUNS,
    );
  });

  test("the histories include production writes, superseding ones among them", () => {
    const sample = fc.sample(historyArb, { numRuns: 300, seed: 12 });
    const writes = sample.flatMap((events) =>
      events.filter((e) => e.type === "resolved" && e.id >= E(60) && e.id < E(70)),
    );
    expect(writes.length).toBeGreaterThan(50);
    expect(writes.some((e) => e.type === "resolved" && e.supersedes.length > 0)).toBe(true);
  });

  test("a resolution the production rule writes is never judged invalid", () => {
    fc.assert(
      fc.property(historyArb, (events) => {
        const p = foldCatalog(events).projects[PROJECT];
        const written = new Set(
          events.filter((e) => e.type === "resolved" && e.id >= E(60) && e.id < E(70)).map((e) => e.id),
        );
        for (const id of p?.invalid ?? []) expect(written.has(id)).toBe(false);
      }),
      RUNS,
    );
  });
});
