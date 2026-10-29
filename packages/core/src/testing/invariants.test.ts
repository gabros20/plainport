// The invariants' own tests (M2 Task 14): each catches a seeded violation. Invariants 1–3 on one device
// (invariantViolations), 4–6 on a catalog (catalogInvariantViolations): what the saga tests, the crash matrix and the
// race schedules assert.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogEvent } from "../catalog/events.ts";
import { foldCatalog } from "../catalog/fold.ts";
import { appendEvent, storeEventLog } from "../catalog/log.ts";
import { ulid } from "../ulid.ts";
import { fakeEngine } from "./fake-engine.ts";
import {
  captureTree,
  catalogInvariantViolations,
  type InvariantSubject,
  invariantViolations,
  namesIn,
  type RecordedCall,
  recordingBlobStore,
} from "./invariants.ts";
import { memoryBlobStore } from "./memory-blob-store.ts";
import { makeSandbox, type Sandbox } from "./sandbox.ts";

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

describe("catalogInvariantViolations: M2's per-device and recorded checks", () => {
  test("invariant 5 (Q17): a strict onload by a device that observed another's lease is caught", () => {
    const first = ulid();
    const theirs = onloaded(first, { device: other });
    const mine = onloaded(first);
    const events = [offloaded(first), theirs, mine];
    expect(
      catalogInvariantViolations({
        events,
        snapshotsBefore: [restic("a")],
        snapshotsNow: [restic("a")],
        strictOnloads: [{ device, before: [first, theirs.id] }],
      }),
    ).toEqual([
      `invariant 5: ${device} onloaded ${project} under strict leases although it observed ${other} holding it`,
    ]);
  });

  test("invariant 5 (Q17): two simultaneous strict onloads, neither seeing the other, hold it", () => {
    const first = ulid();
    const events = [offloaded(first), onloaded(first, { device: other }), onloaded(first)];
    expect(
      catalogInvariantViolations({
        events,
        snapshotsBefore: [restic("a")],
        snapshotsNow: [restic("a")],
        strictOnloads: [
          { device, before: [first] },
          { device: other, before: [first] },
        ],
      }),
    ).toEqual([]);
  });

  test("invariant 6: an event gone from the store, or rewritten, is caught", () => {
    const first = ulid();
    const second = ulid();
    const kept = offloaded(first);
    const gone = offloaded(second, { base: first, stored: { ssd: restic("b") } });
    const rewritten = { ...kept, path: "elsewhere" } as CatalogEvent;
    expect(
      catalogInvariantViolations({
        events: [rewritten],
        snapshotsBefore: [restic("a")],
        snapshotsNow: [restic("a")],
        eventsBefore: [kept, gone],
      }),
    ).toEqual([
      `invariant 6: the event ${first} was rewritten`,
      `invariant 6: the event ${second} is gone from the store`,
    ]);
  });

  test("invariant 6: a recorded restic forget or prune, or a store delete of an event or a snapshot, is caught", async () => {
    const log: RecordedCall[] = [];
    const store = recordingBlobStore(memoryBlobStore(), log);
    await store.put("meta/v1/state.json", new Uint8Array());
    await store.delete("meta/v1/state.json");
    await store.delete(`meta/v1/events/${ulid()}.json`);
    await store.delete(`repo/snapshots/${restic("c")}`);
    log.push({ tool: "restic", args: ["--repo", "/s", "snapshots", "--json"] });
    log.push({ tool: "restic", args: ["--repo", "/s", "forget", "--prune", restic("a")] });
    const found = catalogInvariantViolations({
      events: [],
      snapshotsBefore: [],
      snapshotsNow: [],
      recorded: log,
    });
    expect(found).toEqual([
      `invariant 6: the store's ${(log[2] as { key: string }).key} was deleted`,
      `invariant 6: the store's repo/snapshots/${restic("c")} was deleted`,
      `invariant 6: restic forget ran: --repo /s forget --prune ${restic("a")}`,
    ]);
    expect(log.slice(0, 2)).toEqual([
      { tool: "store", method: "put", key: "meta/v1/state.json" },
      { tool: "store", method: "delete", key: "meta/v1/state.json" },
    ]);
  });
});

// Invariants 1–3 on one device: a project offloaded by this device (dev A) and forked later by another (dev B).
describe("invariantViolations: per device", () => {
  let box: Sandbox;
  const rootKey = "work";
  const a = ulid();
  const b = ulid();

  beforeEach(() => {
    box = makeSandbox("plainport-invariants-");
  });
  afterEach(() => box.cleanup());

  /** A project folder snapshotted by a fake engine; the offloaded event from `by`, and the folder as captured. */
  const world = async () => {
    const root = box.dir(rootKey);
    const dir = box.dir(`${rootKey}/web`);
    box.file(`${rootKey}/web/src/main.ts`, "export const main = 1;\n");
    const blob = memoryBlobStore();
    const engine = fakeEngine(undefined, {}, { password: "pw" });
    await engine.init();
    const snap = await engine.snapshot({ dir, excludes: [], tags: ["plainport"] }, { op: ulid() });
    if (!snap.ok) throw new Error("the fake snapshot failed");
    const released = captureTree(dir);
    const projectId = ulid();
    const rootId = ulid();
    const event = (by: string, snapshot: string, extra: Partial<CatalogEvent> = {}): CatalogEvent =>
      ({
        v: 1,
        id: snapshot,
        op: snapshot,
        type: "offloaded",
        device: by,
        at,
        project: projectId,
        root: rootId,
        path: "web",
        snapshot,
        stored: { ssd: snap.value.id },
        stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
        ...extra,
      }) as CatalogEvent;
    const append = async (e: CatalogEvent) => {
      const done = await appendEvent(storeEventLog(blob), e);
      if (!done.ok) throw new Error(done.finding.message);
    };
    const stub = (snapshot: string) =>
      writeFileSync(
        `${dir}.plainport`,
        `${JSON.stringify({
          plainport: 1,
          project: projectId,
          root: rootKey,
          rootId,
          path: "web",
          store: "ssd",
          snapshot,
          offloadedAt: at,
          bytes: 1,
          restore: "plainport onload work:web",
        })}\n`,
      );
    const subject = (device: string, extra: Partial<InvariantSubject> = {}): InvariantSubject => ({
      paths: box.paths,
      device,
      project: { id: projectId, dir },
      roots: [root],
      store: { name: "ssd", blob, engine },
      released,
      now: new Date(),
      settleMs: 0,
      ...extra,
    });
    return { root, rootId, projectId, dir, event, append, stub, subject };
  };

  test("A shelved it and B forked it later: A's stub stays right although the catalog is conflicted", async () => {
    const w = await world();
    const base = ulid();
    await w.append(w.event(a, base));
    // A and B both worked on the base; A committed first, B's offload forked it.
    const mine = ulid();
    await w.append(w.event(a, mine, { base }));
    await w.append(w.event(b, ulid(), { base }));
    rmSync(w.dir, { recursive: true });
    w.stub(mine);
    expect(await invariantViolations(w.subject(a))).toEqual([]);
    // B's view of its own (other) folder: its last operation was its fork, its folder is still there.
    mkdirSync(w.dir);
    rmSync(`${w.dir}.plainport`);
    expect(await invariantViolations(w.subject(b))).toEqual([]);
  });

  test("invariant 2: a stub missing after this device's own offload shelved the project is caught", async () => {
    const w = await world();
    const mine = ulid();
    await w.append(w.event(a, mine));
    rmSync(w.dir, { recursive: true });
    const found = await invariantViolations(w.subject(a));
    expect(found.filter((p) => p.startsWith("invariant 2"))).toEqual([
      `invariant 2: the stub is missing, but this device's last operation on the project was an offload (${mine}) and its folder is gone`,
    ]);
  });

  test("invariant 2: a device that never shelved the project needs no stub where another device shelved it", async () => {
    const w = await world();
    await w.append(w.event(a, ulid()));
    rmSync(w.dir, { recursive: true });
    expect((await invariantViolations(w.subject(b))).filter((p) => p.startsWith("invariant 2"))).toEqual([]);
  });

  test("invariant 2: a stub beside the folder of a device whose last operation was an onload is caught", async () => {
    const w = await world();
    const first = ulid();
    await w.append(w.event(a, first));
    const back = ulid();
    await w.append({
      v: 1,
      id: back,
      op: back,
      type: "onloaded",
      device: a,
      at,
      project: w.projectId,
      root: w.rootId,
      path: "web",
      base: first,
      over: first,
    } as CatalogEvent);
    w.stub(first);
    expect(await invariantViolations(w.subject(a))).toEqual([
      `invariant 2: the stub exists, but this device's last operation on the project was an onload (${back}) and its folder is present`,
    ]);
  });

  test("invariant 2: a stub naming another snapshot than this device's last offload is caught", async () => {
    const w = await world();
    const mine = ulid();
    await w.append(w.event(a, mine));
    rmSync(w.dir, { recursive: true });
    const wrong = ulid();
    w.stub(wrong);
    expect((await invariantViolations(w.subject(a))).filter((p) => p.startsWith("invariant 2"))).toEqual([
      `invariant 2: the stub names ${wrong}, this device's last offload made ${mine}`,
    ]);
  });

  test("invariant 1: a folder gone with no offloaded event from this device is caught", async () => {
    const w = await world();
    const theirs = ulid();
    await w.append(w.event(b, theirs));
    rmSync(w.dir, { recursive: true });
    w.stub(theirs);
    const found = await invariantViolations(w.subject(a));
    expect(found).toContain(
      `invariant 1: ${w.dir} is gone, but its snapshot ${theirs} has no offloaded event in the store`,
    );
  });

  test("invariant 1: a snapshot that does not match the folder as released is caught", async () => {
    const w = await world();
    const mine = ulid();
    await w.append(w.event(a, mine));
    const released = captureTree(w.dir);
    released.set("src/lost.ts", { type: "file", size: 4, mode: 0o644 });
    rmSync(w.dir, { recursive: true });
    w.stub(mine);
    expect(await invariantViolations(w.subject(a, { released }))).toEqual([
      `invariant 1: ${w.dir} is gone, but its snapshot does not match the folder as released: src/lost.ts`,
    ]);
  });

  test("invariant 3: a trash folder no open journal accounts for is caught", async () => {
    const w = await world();
    const left = join(w.root, ".plainport-trash", ulid());
    mkdirSync(left, { recursive: true });
    expect(await invariantViolations(w.subject(a))).toEqual([
      `invariant 3: ${left} remains from a finished operation`,
    ]);
  });
});
