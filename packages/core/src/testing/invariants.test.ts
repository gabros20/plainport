// Invariants 4–6 on a catalog (catalogInvariantViolations): what the crash matrix asserts after every recover.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogEvent } from "../catalog/events.ts";
import { foldCatalog } from "../catalog/fold.ts";
import { ulid } from "../ulid.ts";
import { catalogInvariantViolations, namesIn } from "./invariants.ts";

const device = ulid();
const other = ulid();
const project = ulid();
const root = ulid();
const at = "2026-10-03T12:00:00.000Z";
const restic = (c: string) => c.repeat(64);

const offloaded = (snapshot: string, extra: Partial<CatalogEvent> = {}): CatalogEvent =>
  ({
    v: 1,
    id: snapshot,
    op: snapshot,
    type: "offloaded",
    device,
    at,
    project,
    root,
    path: "web",
    snapshot,
    stored: { ssd: restic("a") },
    stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
    ...extra,
  }) as CatalogEvent;

const onloaded = (base: string, extra: Partial<CatalogEvent> = {}): CatalogEvent => {
  const id = ulid();
  return {
    v: 1,
    id,
    op: id,
    type: "onloaded",
    device,
    at,
    project,
    root,
    path: "web",
    base,
    over: base,
    ...extra,
  } as CatalogEvent;
};

const discarded = (snapshot: string, stored: string): CatalogEvent => ({
  v: 1,
  id: ulid(),
  op: snapshot,
  type: "snapshot-discarded",
  device,
  at,
  project,
  root,
  path: "web",
  snapshot,
  stored: { ssd: stored },
});

const check = (events: CatalogEvent[], before: string[] = [], now: string[] = before) =>
  catalogInvariantViolations({ events, snapshotsBefore: before, snapshotsNow: now });

describe("catalogInvariantViolations", () => {
  test("a plain history of offloads and onloads holds every invariant", () => {
    const first = ulid();
    const second = ulid();
    const events = [
      offloaded(first),
      onloaded(first),
      offloaded(second, { base: first, stored: { ssd: restic("b") } }),
    ];
    expect(check(events, [restic("a"), restic("b")])).toEqual([]);
  });

  test("invariant 5: two onloaded events from one onload operation are two leases", () => {
    const first = ulid();
    const lease = onloaded(first);
    const again = { ...lease, id: ulid() } as CatalogEvent;
    expect(check([offloaded(first), lease, again], [restic("a")])).toEqual([
      `invariant 5: the onload ${lease.op} wrote 2 onloaded events`,
    ]);
  });

  test("invariant 5: an onload from another device holds the one lease", () => {
    const first = ulid();
    expect(check([offloaded(first), onloaded(first, { device: other })], [restic("a")])).toEqual([]);
  });

  test("invariant 4: the same state with its keys in another order is the same state", () => {
    const first = ulid();
    const events = [offloaded(first), offloaded(ulid(), { base: first, stored: { ssd: restic("b") } })];
    const reorder = (list: readonly CatalogEvent[]) => {
      const state = foldCatalog(list);
      // A fold that builds the same maps in event order: key order depends on the order of the events.
      return list[0] === events[0] ? state : { roots: state.roots, projects: state.projects };
    };
    expect(
      catalogInvariantViolations({ events, snapshotsBefore: [], snapshotsNow: [], fold: reorder }),
    ).toEqual([]);
  });

  test("invariant 4: a fold that depends on the order of its events is caught", () => {
    const first = ulid();
    const second = ulid();
    const events = [offloaded(first), offloaded(second, { base: first, stored: { ssd: restic("b") } })];
    const byFirst = (list: readonly CatalogEvent[]) => {
      const state = foldCatalog(list);
      const head = list[0]?.type === "offloaded" ? list[0].snapshot : null;
      for (const p of Object.values(state.projects)) p.head = head;
      return state;
    };
    const found = catalogInvariantViolations({
      events,
      snapshotsBefore: [],
      snapshotsNow: [],
      fold: byFirst,
    });
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((f) => f.startsWith("invariant 4: "))).toBe(true);
  });

  test("invariant 6: a snapshot the repository held before is gone", () => {
    const first = ulid();
    expect(check([offloaded(first)], [restic("a"), restic("c")], [restic("a")])).toEqual([
      `invariant 6: the repository no longer holds ${restic("c")}`,
    ]);
  });

  test("invariant 6: a snapshot that has an offloaded event is never discarded", () => {
    const first = ulid();
    expect(check([offloaded(first), discarded(first, restic("a"))], [restic("a")])).toEqual([
      `invariant 6: ${first} is discarded although an offloaded event names it`,
    ]);
  });

  test("invariant 6: names the checkpointed event that names a discarded snapshot", () => {
    const first = ulid();
    const checkpoint = { ...offloaded(first), type: "checkpointed" } as CatalogEvent;
    expect(check([checkpoint, discarded(first, restic("a"))], [restic("a")])).toEqual([
      `invariant 6: ${first} is discarded although a checkpointed event names it`,
    ]);
  });

  test("invariant 6: a discard naming another snapshot's restic id is caught too", () => {
    const first = ulid();
    const failed = ulid();
    expect(check([offloaded(first), discarded(failed, restic("a"))], [restic("a")])).toEqual([
      `invariant 6: ${failed} is discarded although an offloaded event names it`,
    ]);
  });
});

// An offload's detached delete removes the emptied trash holder whenever it finishes; a check-then-list of the
// holder raced it and threw ENOENT out of invariant 3 on Linux CI (release 0.1.0).
describe("namesIn: listing a holder a detached delete may remove", () => {
  test("a folder that is gone lists nothing; one that is there lists its names; a file still throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "plainport-names-in-"));
    try {
      mkdirSync(join(dir, "holder/op"), { recursive: true });
      writeFileSync(join(dir, "file"), "");
      expect(namesIn(join(dir, "holder"))).toEqual(["op"]);
      rmSync(join(dir, "holder"), { recursive: true });
      expect(namesIn(join(dir, "holder"))).toEqual([]);
      expect(() => namesIn(join(dir, "file"))).toThrow("ENOTDIR");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
