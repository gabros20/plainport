import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { finding } from "@plainport/contract";
import { resolvePaths } from "../paths.ts";
import { type MemoryBlobStore, memoryBlobStore } from "../testing/memory-blob-store.ts";
import { ulid } from "../ulid.ts";
import {
  appendEvent,
  type CatalogEvent,
  CatalogEventSchema,
  encodeEvent,
  ensureStoreIdentity,
  eventMirrorDir,
  FOLD_VERSION,
  foldCatalog,
  headCheck,
  headUncertain,
  type LoadedCatalog,
  loadCatalog,
  MIRROR_FILE_KEY,
  MIRROR_STATE_KEY,
  mirrorEventLog,
  readEvents,
  STATE_KEY,
  STORE_IDENTITY_KEY,
  storeEventLog,
} from "./index.ts";

const idAt = (ms: number) => ulid(ms, (b) => b);
const DEVICE = idAt(3);
const PROJECT = idAt(1);
const ROOT = idAt(2);

const offloaded = (n: number, snapshot = idAt(500 + n)): Extract<CatalogEvent, { type: "offloaded" }> => ({
  v: 1,
  id: idAt(1000 + n),
  type: "offloaded",
  device: DEVICE,
  at: "2026-10-03T12:00:00.000Z",
  op: snapshot,
  project: PROJECT,
  root: ROOT,
  path: "web",
  snapshot,
  stored: { ssd: "cd".repeat(32) },
  stats: { files: 3, bytes: 30, strippedBytes: 0, ecosystems: ["node"] },
});

const encode = (value: unknown) =>
  new TextEncoder().encode(typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
const decode = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

describe("catalog: event log on a store", () => {
  test("an event is written create-only to meta/v1/events/<id>.json as one line of JSON", async () => {
    const store = memoryBlobStore();
    const event = offloaded(1);
    expect(await appendEvent(storeEventLog(store), event)).toEqual({ ok: true, value: undefined });
    expect([...store.data.keys()]).toEqual([`meta/v1/events/${event.id}.json`]);
    expect(JSON.parse(decode(store.data.get(`meta/v1/events/${event.id}.json`)) as string)).toEqual(event);
  });

  test("appending the same event again is a no-op; a different event under the same id is refused", async () => {
    const store = memoryBlobStore();
    const log = storeEventLog(store);
    const event = offloaded(1);
    expect((await appendEvent(log, event)).ok).toBe(true);
    expect((await appendEvent(log, structuredClone(event))).ok).toBe(true);
    const clash = await appendEvent(log, { ...event, path: "other" });
    expect(clash).toMatchObject({ ok: false, finding: { code: "store.key-exists" } });
    expect(JSON.parse(decode(store.data.get(`meta/v1/events/${event.id}.json`)) as string).path).toBe("web");
  });

  test("a retry completes its own torn write (a file without hard links died mid-write); other bytes are refused", async () => {
    const store = memoryBlobStore();
    const log = storeEventLog(store);
    const event = offloaded(1);
    const key = `meta/v1/events/${event.id}.json`;
    // The bytes appendEvent writes: the event as its schema parses it, in the schema's key order.
    const whole = decode(encodeEvent(CatalogEventSchema.parse(event))) as string;
    store.data.set(key, encode(whole.slice(0, 20)));
    const torn = await readEvents(log);
    expect(torn.ok && torn.value.findings.map((f) => f.code)).toEqual(["catalog.event-skipped"]);
    expect(await appendEvent(log, event)).toEqual({ ok: true, value: undefined });
    expect(decode(store.data.get(key))).toBe(whole);
    // An empty file (the crash came before any byte) is completed too.
    store.data.set(key, encode(""));
    expect((await appendEvent(log, event)).ok).toBe(true);
    expect(decode(store.data.get(key))).toBe(whole);
    // A torn file that is not a prefix of this event is someone else's: never overwritten.
    store.data.set(key, encode('{"v":1,"id":"other'));
    expect(await appendEvent(log, event)).toMatchObject({ ok: false, finding: { code: "store.key-exists" } });
    expect(decode(store.data.get(key))).toBe('{"v":1,"id":"other');
  });

  test("a new onloaded event must say which head it was written over (D43)", async () => {
    const store = memoryBlobStore();
    const onload = {
      v: 1 as const,
      id: idAt(2001),
      type: "onloaded" as const,
      device: DEVICE,
      at: "2026-10-03T12:00:00.000Z",
      op: idAt(2001),
      project: PROJECT,
      root: ROOT,
      path: "web",
      base: idAt(501),
    };
    expect(await appendEvent(storeEventLog(store), onload)).toMatchObject({
      ok: false,
      finding: { code: "contract.invalid" },
    });
    expect((await appendEvent(storeEventLog(store), { ...onload, over: idAt(502) })).ok).toBe(true);
  });

  test("an event that does not match its schema is a bug: contract.invalid, nothing written", async () => {
    const store = memoryBlobStore();
    const result = await appendEvent(storeEventLog(store), { ...offloaded(1), path: "../escape" });
    expect(result).toMatchObject({ ok: false, finding: { code: "contract.invalid" } });
    expect(store.data.size).toBe(0);
  });

  test("a store without create-if-absent still gets the event (ULID names do not collide)", async () => {
    const store = memoryBlobStore({ createIfAbsent: false });
    expect((await appendEvent(storeEventLog(store), offloaded(1))).ok).toBe(true);
    expect(store.data.size).toBe(1);
  });

  test("readEvents returns valid events sorted by id and skips the rest with catalog.event-skipped", async () => {
    const store = memoryBlobStore();
    const log = storeEventLog(store);
    const [two, one] = [offloaded(2), offloaded(1)];
    for (const event of [two, one]) await appendEvent(log, event);
    const unknownType = { ...offloaded(3), type: "lease-broken" };
    const misnamed = offloaded(4);
    const junk: Record<string, Uint8Array> = {
      [`meta/v1/events/${idAt(9001)}.json`]: encode("{not json"),
      [`meta/v1/events/${idAt(9002)}.json`]: encode({ ...offloaded(5), id: idAt(9002), stats: "big" }),
      [`meta/v1/events/${unknownType.id}.json`]: encode(unknownType),
      [`meta/v1/events/${idAt(9003)}.json`]: encode(misnamed),
      "meta/v1/events/README.txt": encode("not an event"),
    };
    for (const [key, bytes] of Object.entries(junk)) store.data.set(key, bytes);

    const result = await readEvents(log);
    if (!result.ok) throw new Error(result.finding.message);
    expect(result.value.events).toEqual([one, two]);
    const skipped = result.value.findings;
    expect(skipped.map((f) => f.code)).toEqual(Array(5).fill("catalog.event-skipped"));
    expect(skipped.every((f) => f.severity === "warn")).toBe(true);
    expect(skipped.flatMap((f) => f.paths)).toEqual(Object.keys(junk).sort());
    expect(skipped.find((f) => f.paths?.[0]?.includes(unknownType.id))?.message).toContain("lease-broken");
  });

  test("a store that cannot be read is a failure, not an empty catalog", async () => {
    const store = memoryBlobStore();
    await appendEvent(storeEventLog(store), offloaded(1));
    store.failNext("list");
    expect(await readEvents(storeEventLog(store))).toMatchObject({
      ok: false,
      finding: { code: "store.unreachable" },
    });
  });
});

const STORE_ID = idAt(900);
const NOW = new Date("2026-10-03T12:00:00.000Z");
const LATER = new Date("2026-10-03T13:00:00.000Z");

/** A store set up as init does it (D45): with its identity file. */
const initStore = async (): Promise<MemoryBlobStore> => {
  const store = memoryBlobStore();
  const id = await ensureStoreIdentity(store, () => STORE_ID);
  if (!id.ok) throw new Error(id.finding.message);
  return store;
};

const load = async (store: MemoryBlobStore, mirror: MemoryBlobStore, now = NOW): Promise<LoadedCatalog> => {
  const result = await loadCatalog({ store, mirror, storeId: STORE_ID, now });
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

describe("catalog: store identity (D45)", () => {
  test("ensureStoreIdentity writes meta/v1/store.json once and returns the same id ever after", async () => {
    const store = memoryBlobStore();
    const first = await ensureStoreIdentity(store, () => STORE_ID);
    expect(first).toEqual({ ok: true, value: { id: STORE_ID, created: true } });
    expect(JSON.parse(decode(store.data.get(STORE_IDENTITY_KEY)) as string)).toEqual({ v: 1, id: STORE_ID });
    const again = await ensureStoreIdentity(store, () => idAt(901));
    expect(again).toEqual({ ok: true, value: { id: STORE_ID, created: false } });
  });

  test("a damaged identity file is store.failed and is never replaced", async () => {
    const store = memoryBlobStore();
    store.data.set(STORE_IDENTITY_KEY, encode("{broken"));
    expect(await ensureStoreIdentity(store, () => STORE_ID)).toMatchObject({
      ok: false,
      finding: { code: "store.failed" },
    });
    expect(decode(store.data.get(STORE_IDENTITY_KEY))).toBe("{broken");
  });

  test("m10: a half-written identity file (a crash at setup on exFAT) is completed by setup while the store holds no events", async () => {
    const whole = `${JSON.stringify({ v: 1, id: STORE_ID })}\n`;
    for (const torn of ["", "{", whole.slice(0, 12), whole.slice(0, 20), whole.slice(0, -3)]) {
      const store = memoryBlobStore();
      store.data.set(STORE_IDENTITY_KEY, encode(torn));
      // A read refuses it, and says what to do: setup never finished, so run it again.
      const read = await loadCatalog({ store, mirror: memoryBlobStore(), storeId: STORE_ID, now: NOW });
      expect(read).toMatchObject({ ok: false, finding: { code: "store.failed" } });
      if (read.ok) throw new Error("unreachable");
      expect(read.finding.fix).toContain("plainport init");
      expect(read.finding.fix).not.toContain("backup");
      expect(decode(store.data.get(STORE_IDENTITY_KEY))).toBe(torn);
      // Setup completes it with a fresh id.
      const fresh = idAt(902);
      expect(await ensureStoreIdentity(store, () => fresh)).toEqual({
        ok: true,
        value: { id: fresh, created: true },
      });
      expect(JSON.parse(decode(store.data.get(STORE_IDENTITY_KEY)) as string)).toEqual({ v: 1, id: fresh });
    }
  });

  test("m10: a half-written identity file on a store that already holds events is never replaced, and the fix names where the id is recorded", async () => {
    const store = memoryBlobStore();
    await appendEvent(storeEventLog(store), offloaded(1));
    const torn = `${JSON.stringify({ v: 1, id: STORE_ID })}`.slice(0, 20);
    store.data.set(STORE_IDENTITY_KEY, encode(torn));
    for (const result of [
      await ensureStoreIdentity(store, () => idAt(902)),
      await loadCatalog({ store, mirror: memoryBlobStore(), storeId: STORE_ID, now: NOW }),
    ]) {
      expect(result).toMatchObject({ ok: false, finding: { code: "store.failed" } });
      if (result.ok) throw new Error("unreachable");
      expect(result.finding.fix).toContain("registry.json");
      expect(result.finding.fix).not.toContain("backup");
    }
    expect(decode(store.data.get(STORE_IDENTITY_KEY))).toBe(torn);
    // Bytes that are no prefix of an identity file are someone else's: never replaced either, whatever the store holds.
    const empty = memoryBlobStore();
    empty.data.set(STORE_IDENTITY_KEY, encode('{"v":2,"id":"'));
    expect(await ensureStoreIdentity(empty, () => idAt(902))).toMatchObject({
      ok: false,
      finding: { code: "store.failed" },
    });
    expect(decode(empty.data.get(STORE_IDENTITY_KEY))).toBe('{"v":2,"id":"');
  });

  test("a store whose identity is not the one this device knows is refused: store.identity-changed", async () => {
    const other = memoryBlobStore();
    await ensureStoreIdentity(other, () => idAt(901));
    await appendEvent(storeEventLog(other), offloaded(1));
    const mirror = memoryBlobStore();
    const result = await loadCatalog({ store: other, mirror, storeId: STORE_ID, now: NOW });
    expect(result).toMatchObject({ ok: false, exitCode: 6, finding: { code: "store.identity-changed" } });
    expect(mirror.data.size).toBe(0);
    // A store with no identity file at all was not set up by plainport init: refused the same way.
    const bare = memoryBlobStore();
    expect(await loadCatalog({ store: bare, mirror, storeId: STORE_ID, now: NOW })).toMatchObject({
      ok: false,
      finding: { code: "store.identity-changed" },
    });
  });

  test("the mirror lives at <cache>/plainport/<store id>/, never under a config name", () => {
    const paths = resolvePaths({ HOME: "/home/u" });
    if (!paths.ok) throw new Error("paths");
    expect(eventMirrorDir(paths.value, STORE_ID)).toBe(join("/home/u/.cache/plainport", STORE_ID));
    const xdg = resolvePaths({ HOME: "/home/u", XDG_CACHE_HOME: "/c" });
    if (!xdg.ok) throw new Error("paths");
    expect(eventMirrorDir(xdg.value, STORE_ID)).toBe(join("/c/plainport", STORE_ID));
    for (const name of ["ssd", "..", "a/b"])
      expect(() => eventMirrorDir(paths.value, name)).toThrow(RangeError);
  });
});

describe("catalog: loadCatalog, the one read path (D43, D45)", () => {
  test("a read never writes to the store: events only the mirror holds stay there, and no state.json is put", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    await appendEvent(storeEventLog(store), offloaded(1));
    await appendEvent(mirrorEventLog(mirror), offloaded(2)); // e.g. a mirror left from another store
    store.calls.put = 0;
    const result = await load(store, mirror);
    expect(store.calls.put).toBe(0);
    expect([...store.data.keys()].sort()).toEqual(
      [`meta/v1/events/${offloaded(1).id}.json`, STORE_IDENTITY_KEY].sort(),
    );
    expect(store.data.has(STATE_KEY)).toBe(false);
    // The mirror's own events still fold: the mirror is a union of what this device has seen.
    expect(Object.keys(result.state.projects[PROJECT]?.snapshots ?? {})).toHaveLength(2);
  });

  test("sync fetches only events the mirror lacks, with one listing of each side", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    for (const n of [1, 2]) await appendEvent(storeEventLog(store), offloaded(n));
    store.calls.get = 0;
    store.calls.list = 0;
    mirror.calls.list = 0;
    const first = await load(store, mirror);
    expect(first.copied).toBe(2);
    expect(store.calls).toMatchObject({ list: 1, get: 3 }); // two events and the identity file
    expect(mirror.calls.list).toBe(1);

    store.calls.get = 0;
    expect((await load(store, mirror)).copied).toBe(0);
    expect(store.calls.get).toBe(1); // the identity file only

    await appendEvent(storeEventLog(store), offloaded(3));
    store.calls.get = 0;
    expect((await load(store, mirror)).copied).toBe(1);
    expect(store.calls.get).toBe(2);
  });

  test("files that cannot be copied are remembered by name and size, not fetched again, and still reported", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    const torn = offloaded(1);
    const whole = encodeEvent(CatalogEventSchema.parse(torn));
    store.data.set(`meta/v1/events/${torn.id}.json`, whole.subarray(0, 30));
    const newer = { ...offloaded(2), type: "lease-broken" };
    store.data.set(`meta/v1/events/${newer.id}.json`, encode(newer));

    const first = await load(store, mirror);
    expect(first.findings.map((f) => f.code)).toEqual(["catalog.event-skipped", "catalog.event-skipped"]);
    store.calls.get = 0;
    const second = await load(store, mirror);
    expect(store.calls.get).toBe(2); // the identity file, and the newer event again (I7); the torn one is remembered
    expect(second.findings.map((f) => f.code)).toEqual(["catalog.event-skipped", "catalog.event-skipped"]);

    store.data.set(`meta/v1/events/${torn.id}.json`, whole); // completed: new size, fetched again
    const third = await load(store, mirror);
    expect(third.copied).toBe(1);
    expect(third.findings).toHaveLength(1);
    expect(third.state.projects[PROJECT]?.snapshots[torn.snapshot]).toBeDefined();
  });

  test("I7: a valid event of a type this version does not know is read again on every sync, never remembered as skipped", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    const newer = { ...offloaded(2), type: "resolved" };
    store.data.set(`meta/v1/events/${newer.id}.json`, encode(newer));
    const first = await load(store, mirror);
    expect(first.findings.map((f) => f.code)).toEqual(["catalog.event-skipped"]);
    const recorded = JSON.parse(decode(mirror.data.get(MIRROR_FILE_KEY)) as string);
    expect(recorded.fold).toBe(FOLD_VERSION); // the reader that wrote the skip list
    expect(recorded.skipped).toEqual({}); // a newer reader may accept the event: nothing to remember
    store.calls.get = 0;
    const second = await load(store, mirror);
    expect(store.calls.get).toBe(2); // the identity file and the event, again
    expect(second.findings.map((f) => f.code)).toEqual(["catalog.event-skipped"]);
  });

  test("I7: after an upgrade, what the older reader skipped is read again: the skip list dies with its reader's version", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    // M1 on this device skipped the event (to it, an unknown type) and remembered it at this size. Then plainport was
    // upgraded to a reader that knows the type: here, the event is one this fold knows.
    const event = offloaded(1);
    await appendEvent(storeEventLog(store), event);
    const size = (store.data.get(`meta/v1/events/${event.id}.json`) as Uint8Array).length;
    mirror.data.set(
      MIRROR_FILE_KEY,
      encode({
        v: 1,
        store: STORE_ID,
        fold: FOLD_VERSION - 1,
        lastSyncedAt: NOW.toISOString(),
        skipped: {
          [event.id]: {
            size,
            finding: finding("catalog.event-skipped", { message: "an older plainport did not know it" }),
          },
        },
      }),
    );
    const result = await load(store, mirror);
    expect(result.copied).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.state.projects[PROJECT]?.snapshots[event.snapshot]).toBeDefined();
    expect(JSON.parse(decode(mirror.data.get(MIRROR_FILE_KEY)) as string)).toMatchObject({
      fold: FOLD_VERSION,
      skipped: {},
    });
  });

  test("I7: a file that is not JSON is remembered by size, with the version that found it so", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    store.data.set(`meta/v1/events/${idAt(42)}.json`, encode("{torn"));
    await load(store, mirror);
    expect(JSON.parse(decode(mirror.data.get(MIRROR_FILE_KEY)) as string)).toMatchObject({
      fold: FOLD_VERSION,
      skipped: { [idAt(42)]: { size: 5 } },
    });
    store.calls.get = 0;
    expect((await load(store, mirror)).findings.map((f) => f.code)).toEqual(["catalog.event-skipped"]);
    expect(store.calls.get).toBe(1); // the identity file only
  });

  test("an event the store encodes differently is copied byte for byte, so it is not fetched again", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    const event = offloaded(1);
    // Same event, another key order and spacing (another writer's encoding).
    const { stats, ...rest } = event;
    const reordered = encode(`${JSON.stringify({ stats, ...rest }, null, 1)}\n`);
    store.data.set(`meta/v1/events/${event.id}.json`, reordered);
    expect((await load(store, mirror)).copied).toBe(1);
    expect(mirror.data.get(`events/${event.id}.json`)).toEqual(reordered);
    store.calls.get = 0;
    expect((await load(store, mirror)).copied).toBe(0);
    expect(store.calls.get).toBe(1);
  });

  test("a torn copy in the mirror (different size) is fetched again and completed", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    const event = offloaded(1);
    await appendEvent(storeEventLog(store), event);
    const whole = store.data.get(`meta/v1/events/${event.id}.json`) as Uint8Array;
    mirror.data.set(`events/${event.id}.json`, whole.subarray(0, 10));
    expect((await load(store, mirror)).copied).toBe(1);
    expect(mirror.data.get(`events/${event.id}.json`)).toEqual(whole);
  });

  test("online: folds and caches beside the mirror; reuses the cache while nothing changed", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    await appendEvent(storeEventLog(store), offloaded(1));
    const first = await load(store, mirror);
    expect(first).toMatchObject({
      stale: false,
      source: "store",
      cached: false,
      syncedAt: NOW.toISOString(),
    });
    expect(first.state).toEqual(foldCatalog([offloaded(1)]));
    expect(JSON.parse(decode(mirror.data.get(MIRROR_STATE_KEY)) as string)).toMatchObject({
      v: 1,
      fold: FOLD_VERSION,
      count: 1,
    });
    expect(JSON.parse(decode(mirror.data.get(MIRROR_FILE_KEY)) as string)).toMatchObject({
      v: 1,
      store: STORE_ID,
      lastSyncedAt: NOW.toISOString(),
    });
    const second = await load(store, mirror, LATER);
    expect(second).toMatchObject({ cached: true, state: first.state, syncedAt: LATER.toISOString() });
  });

  test("a new event makes the cache stale: rebuilt from the events and rewritten", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    await appendEvent(storeEventLog(store), offloaded(1));
    await load(store, mirror);
    await appendEvent(storeEventLog(store), offloaded(2, idAt(777)));
    const result = await load(store, mirror);
    expect(result.cached).toBe(false);
    expect(result.state).toEqual(foldCatalog([offloaded(1), offloaded(2, idAt(777))]));
  });

  test("I3: a cache built by another fold version is rebuilt, never served", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    await appendEvent(storeEventLog(store), offloaded(1));
    await load(store, mirror);
    const cache = JSON.parse(decode(mirror.data.get(MIRROR_STATE_KEY)) as string);
    mirror.data.set(
      MIRROR_STATE_KEY,
      encode({ ...cache, fold: FOLD_VERSION + 1, state: { projects: {}, roots: {} } }),
    );
    expect(await load(store, mirror)).toMatchObject({ cached: false, state: foldCatalog([offloaded(1)]) });
  });

  test("a damaged or foreign cache is ignored and rebuilt", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    await appendEvent(storeEventLog(store), offloaded(1));
    const expected = foldCatalog([offloaded(1)]);
    for (const bad of [
      "{oops",
      JSON.stringify({ v: 9 }),
      JSON.stringify({ v: 1, digest: "x", count: 1, state: {} }),
    ]) {
      mirror.data.set(MIRROR_STATE_KEY, encode(bad));
      expect(await load(store, mirror)).toMatchObject({ cached: false, state: expected });
    }
  });

  test("I5: when the store is unreachable, the mirror's state comes back marked stale, with its last sync time", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    await appendEvent(storeEventLog(store), offloaded(1));
    const online = await load(store, mirror);
    store.failNext("get");
    const offline = await load(store, mirror, LATER);
    expect(offline).toMatchObject({
      stale: true,
      source: "mirror",
      state: online.state,
      syncedAt: NOW.toISOString(),
    });
    expect(offline.unreachable?.code).toBe("store.unreachable");
  });

  test("never synced and unreachable: stale with no sync time, so 'never seen' differs from 'out of date'", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    store.failNext("get");
    const result = await load(store, mirror);
    expect(result).toMatchObject({ stale: true, source: "mirror", state: { projects: {}, roots: {} } });
    expect(result.syncedAt).toBeUndefined();
  });

  test("a broken mirror never fails a read while the store is reachable: the store is read directly", async () => {
    const store = await initStore();
    await appendEvent(storeEventLog(store), offloaded(1));
    for (const method of ["list", "put", "get"] as const) {
      const mirror = memoryBlobStore();
      mirror.failNext(method, "store.failed");
      const result = await load(store, mirror);
      expect(result).toMatchObject({ stale: false, source: "store", state: foldCatalog([offloaded(1)]) });
      expect(result.mirrorFailure?.code).toBe("store.failed");
    }
    // A mirror recorded for another store is not used either.
    const foreign = memoryBlobStore();
    foreign.data.set(
      MIRROR_FILE_KEY,
      encode({ v: 1, store: idAt(901), fold: FOLD_VERSION, lastSyncedAt: NOW.toISOString(), skipped: {} }),
    );
    await appendEvent(mirrorEventLog(foreign), offloaded(5));
    const result = await load(store, foreign);
    expect(result.state).toEqual(foldCatalog([offloaded(1)]));
    expect(result.mirrorFailure?.code).toBe("store.identity-changed");
  });

  test("a store that fails otherwise is a failure", async () => {
    const store = await initStore();
    store.failNext("list", "store.failed");
    expect(
      await loadCatalog({ store, mirror: memoryBlobStore(), storeId: STORE_ID, now: NOW }),
    ).toMatchObject({
      ok: false,
      finding: { code: "store.failed" },
    });
  });

  test("skipped mirror events are reported with the state, from the cache too", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    mirror.data.set(`events/${idAt(42)}.json`, encode("{bad"));
    const first = await load(store, mirror);
    expect(first.findings.map((f) => f.code)).toEqual(["catalog.event-skipped"]);
    const again = await load(store, mirror);
    expect(again).toMatchObject({ cached: true });
    expect(again.findings.map((f) => f.code)).toEqual(["catalog.event-skipped"]);
  });

  test("I1: an event completed under the same name (a torn write) refolds", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    const event = offloaded(1);
    await appendEvent(storeEventLog(store), offloaded(0));
    const key = `meta/v1/events/${event.id}.json`;
    const whole = encodeEvent(CatalogEventSchema.parse(event));
    store.data.set(key, whole.subarray(0, 25));
    const torn = await load(store, mirror);
    expect(torn.state.projects[PROJECT]?.snapshots[event.snapshot]).toBeUndefined();
    store.data.set(key, whole);
    const completed = await load(store, mirror);
    expect(completed.cached).toBe(false);
    expect(completed.findings).toEqual([]);
    expect(completed.state.projects[PROJECT]?.snapshots[event.snapshot]).toBeDefined();
  });
});

describe("catalog: a fold that left out events is uncertain (D86)", () => {
  const known = idAt(502);
  const ids = (n: number) => offloaded(n).id;

  for (const [kind, bytes] of [
    ["malformed", () => '{"v":1,"id":"'],
    ["unsupported", (id: string) => ({ v: 1, id, type: "merged", at: "2026-10-03T12:00:00.000Z" })],
  ] as const) {
    test(`a ${kind} newest event, with no cache and an empty mirror: uncertain names it, from the cache too`, async () => {
      const store = await initStore();
      const mirror = memoryBlobStore();
      await appendEvent(storeEventLog(store), offloaded(1));
      store.data.set(`meta/v1/events/${ids(2)}.json`, encode(bytes(ids(2))));
      const first = await load(store, mirror);
      expect(first.uncertain).toEqual([ids(2)]);
      expect(first.state.projects[PROJECT]?.head).toBe(offloaded(1).snapshot);
      const again = await load(store, mirror);
      expect(again.uncertain).toEqual([ids(2)]);
      // The head the fold shows is older than the snapshot this device knows: head-dependent defaults refuse.
      const doubt = headUncertain(
        { ...again.state, uncertain: again.uncertain },
        PROJECT,
        [known],
        "work:web",
        {
          what: "nothing was restored",
          instead: "name a snapshot",
        },
      );
      expect(doubt).toMatchObject({ code: "catalog.head-uncertain", severity: "block" });
      expect(
        headCheck({ ...again.state, uncertain: again.uncertain }, PROJECT, known, "work:web"),
      ).toMatchObject({
        kind: "incomplete",
        finding: { code: "catalog.head-uncertain" },
      });
    });
  }

  test("a known snapshot a readable event names, or a file not named as an event, leaves the head certain", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    await appendEvent(storeEventLog(store), offloaded(1));
    await appendEvent(storeEventLog(store), { ...offloaded(2), base: offloaded(1).snapshot });
    store.data.set(`meta/v1/events/${ids(3)}.json`, encode("{bad"));
    const read = await load(store, mirror);
    expect(read.uncertain).toEqual([ids(3)]);
    const state = { ...read.state, uncertain: read.uncertain };
    const said = { what: "nothing was restored", instead: "name a snapshot" };
    expect(headUncertain(state, PROJECT, [known, offloaded(1).snapshot], "work:web", said)).toBeUndefined();
    expect(headUncertain(state, PROJECT, [undefined], "work:web", said)).toBeUndefined();
    store.data.delete(`meta/v1/events/${ids(3)}.json`);
    mirror.data.set("events/notes.txt", encode("not an event"));
    const stray = await load(store, mirror);
    expect(stray.findings.map((f) => f.code)).toEqual(["catalog.event-skipped"]);
    expect(stray.uncertain).toEqual([]);
  });
});
