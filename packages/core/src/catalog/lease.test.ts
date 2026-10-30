// leaseAhead (M2 Task 22, Q17): the lease another device holds that an offload of this copy warns of. Fold rules →
// Lease in DESIGN: an onload sits after the head it was written over and before anything made from it.

import { describe, expect, test } from "bun:test";
import { ulid } from "../ulid.ts";
import { leaseAhead } from "./head.ts";
import { type CatalogEvent, foldCatalog } from "./index.ts";

const zero = (b: Uint8Array) => b;
const idAt = (ms: number) => ulid(ms, zero);
const PROJECT = idAt(1);
const ROOT = idAt(2);
const A = idAt(3);
const B = idAt(4);
const RESTIC = "ab".repeat(32);
const stats = { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] };
const S = (n: number) => idAt(1_000_000 + n);
const E = (n: number) => idAt(2_000_000 + n);

const common = (id: string, device: string) => ({
  v: 1 as const,
  id,
  device,
  at: "2026-10-30T12:00:00.000Z",
  op: id,
  project: PROJECT,
  root: ROOT,
  path: "web",
});
const offloaded = (id: string, device: string, snapshot: string, from?: string): CatalogEvent => ({
  ...common(id, device),
  type: "offloaded",
  ...(from === undefined ? {} : { base: from }),
  snapshot,
  stored: { ssd: RESTIC },
  stats,
});
const onloaded = (id: string, device: string, from: string, over: string): CatalogEvent => ({
  ...common(id, device),
  type: "onloaded",
  base: from,
  over,
});

const projectOf = (events: CatalogEvent[]) => foldCatalog(events).projects[PROJECT];

describe("leaseAhead: the lease an offload of this copy warns of (Q17)", () => {
  test("no lease, or the lease is this device's own: nothing to warn of", () => {
    expect(leaseAhead(projectOf([offloaded(E(1), A, S(1))]), B, S(1), S(1))).toBeUndefined();
    const mine = projectOf([offloaded(E(1), A, S(1)), onloaded(E(2), B, S(1), S(1))]);
    expect(leaseAhead(mine, B, S(1), S(1))).toBeUndefined();
    expect(leaseAhead(undefined, B, undefined, undefined)).toBeUndefined();
  });

  test("another device holds the lease level with this copy (both onloaded one head): this copy is the non-holding one", () => {
    const p = projectOf([
      offloaded(E(1), A, S(1)),
      onloaded(E(2), A, S(1), S(1)),
      onloaded(E(3), B, S(1), S(1)),
    ]);
    expect(p?.lease?.device).toBe(A);
    expect(leaseAhead(p, B, S(1), S(1))).toMatchObject({ device: A, event: E(2) });
  });

  test("a holder further along the chain than this copy's base is a lease to warn of", () => {
    // B's copy came from S1; A onloaded S2, made from S1 since.
    const p = projectOf([
      offloaded(E(1), A, S(1)),
      onloaded(E(2), B, S(1), S(1)),
      onloaded(E(3), A, S(1), S(1)),
      offloaded(E(4), A, S(2), S(1)),
      onloaded(E(5), A, S(2), S(2)),
    ]);
    expect(p?.lease?.device).toBe(A);
    expect(leaseAhead(p, B, S(1), S(2))).toMatchObject({ device: A, event: E(5) });
  });

  test("a holder behind this copy is no lease to warn of: its own offload forks, this one is a step forward", () => {
    // A and B onloaded S1; B committed S2 from it and kept its folder (diverged-after-commit, D51), so its copy's base is
    // S2 and its onload is closed; A's onload, written over S1, stays open behind it.
    const p = projectOf([
      offloaded(E(1), A, S(1)),
      onloaded(E(2), A, S(1), S(1)),
      onloaded(E(3), B, S(1), S(1)),
      offloaded(E(4), B, S(2), S(1)),
    ]);
    expect(p?.lease?.device).toBe(A);
    expect(leaseAhead(p, B, S(2), S(1))).toBeUndefined();
  });

  test("an older snapshot onloaded over a newer head sits after that head (D43): judged by over, not the snapshot restored", () => {
    const p = projectOf([
      offloaded(E(1), A, S(1)),
      offloaded(E(2), A, S(2), S(1)),
      onloaded(E(3), A, S(1), S(2)),
      onloaded(E(4), B, S(2), S(2)),
    ]);
    expect(p?.lease).toMatchObject({ device: A, base: S(1) });
    // By the snapshot restored (S1, an ancestor of B's base) A would look behind; by over (S2) it is level.
    expect(leaseAhead(p, B, S(2), S(2))).toMatchObject({ device: A, event: E(3) });
    // Not knowing where the onload sits (its event unreadable), the lease is warned of.
    expect(leaseAhead(p, B, S(2), undefined)).toMatchObject({ device: A, event: E(3) });
  });

  test("a copy with no base (never offloaded here) hears of any other holder", () => {
    const p = projectOf([offloaded(E(1), A, S(1)), onloaded(E(2), A, S(1), S(1))]);
    expect(leaseAhead(p, B, undefined, S(1))).toMatchObject({ device: A });
  });
});
