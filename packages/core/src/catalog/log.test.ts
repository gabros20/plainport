import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolvePaths } from "../paths.ts";
import { type MemoryBlobStore, memoryBlobStore } from "../testing/memory-blob-store.ts";
import { ulid } from "../ulid.ts";
import {
  appendEvent,
  type CatalogEvent,
  CatalogEventSchema,
  encodeEvent,
  eventMirrorDir,
  FOLD_VERSION,
  foldCatalog,
  loadCatalog,
  MIRROR_STATE_KEY,
  mirrorEventLog,
  readEvents,
  STATE_KEY,
  storeEventLog,
  syncMirror,
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

describe("catalog: local event mirror", () => {
  test("the mirror lives at ~/.cache/plainport/<store>/ with events under events/", () => {
    const paths = resolvePaths({ HOME: "/home/u" });
    if (!paths.ok) throw new Error("paths");
    expect(eventMirrorDir(paths.value, "ssd")).toBe("/home/u/.cache/plainport/ssd");
    const xdg = resolvePaths({ HOME: "/home/u", XDG_CACHE_HOME: "/c" });
    if (!xdg.ok) throw new Error("paths");
    expect(eventMirrorDir(xdg.value, "ssd")).toBe("/c/plainport/ssd");
    // A store name is config text: it never reaches outside the cache folder.
    expect(eventMirrorDir(paths.value, "a/b")).toBe(join("/home/u/.cache/plainport", "a%2Fb"));
    expect(eventMirrorDir(paths.value, "..")).toBe(join("/home/u/.cache/plainport", "%2E%2E"));
    expect(eventMirrorDir(paths.value, ".")).toBe(join("/home/u/.cache/plainport", "%2E"));
  });

  test("sync fetches only the events the mirror lacks and uploads only what the store lacks, one listing each", async () => {
    const remote = memoryBlobStore();
    const mirror = memoryBlobStore();
    for (const n of [1, 2]) await appendEvent(storeEventLog(remote), offloaded(n));
    const localOnly = offloaded(3);
    await appendEvent(mirrorEventLog(mirror), localOnly);
    remote.calls.get = 0;
    remote.calls.list = 0;
    mirror.calls.list = 0;

    const first = await syncMirror(storeEventLog(remote), mirrorEventLog(mirror));
    if (!first.ok) throw new Error(first.finding.message);
    expect(first.value).toMatchObject({ copied: 2, uploaded: 1, findings: [] });
    expect(remote.calls).toMatchObject({ list: 1, get: 2 });
    expect(mirror.calls.list).toBe(1);
    const keys = [1, 2, 3].map((n) => offloaded(n).id);
    expect([...mirror.data.keys()].sort()).toEqual(keys.map((id) => `events/${id}.json`).sort());
    expect([...remote.data.keys()].sort()).toEqual(keys.map((id) => `meta/v1/events/${id}.json`).sort());

    remote.calls.get = 0;
    const second = await syncMirror(storeEventLog(remote), mirrorEventLog(mirror));
    expect(second.ok && second.value).toMatchObject({ copied: 0, uploaded: 0 });
    expect(remote.calls.get).toBe(0);

    await appendEvent(storeEventLog(remote), offloaded(4));
    remote.calls.get = 0;
    const third = await syncMirror(storeEventLog(remote), mirrorEventLog(mirror));
    expect(third.ok && third.value.copied).toBe(1);
    expect(remote.calls.get).toBe(1);
  });

  test("an event the mirror holds torn (different size) is fetched again and completed", async () => {
    const remote = memoryBlobStore();
    const mirror = memoryBlobStore();
    const event = offloaded(1);
    await appendEvent(storeEventLog(remote), event);
    const whole = remote.data.get(`meta/v1/events/${event.id}.json`) as Uint8Array;
    mirror.data.set(`events/${event.id}.json`, whole.subarray(0, 10));
    const synced = await syncMirror(storeEventLog(remote), mirrorEventLog(mirror));
    expect(synced.ok && synced.value.copied).toBe(1);
    expect(mirror.data.get(`events/${event.id}.json`)).toEqual(whole);
  });

  test("an unreachable store fails the sync and leaves the mirror readable offline", async () => {
    const remote = memoryBlobStore();
    const mirror = memoryBlobStore();
    await appendEvent(storeEventLog(remote), offloaded(1));
    await syncMirror(storeEventLog(remote), mirrorEventLog(mirror));
    remote.failNext("list");
    expect(await syncMirror(storeEventLog(remote), mirrorEventLog(mirror))).toMatchObject({
      ok: false,
      finding: { code: "store.unreachable" },
    });
    const offline = await readEvents(mirrorEventLog(mirror));
    expect(offline.ok && offline.value.events.map((e) => e.id)).toEqual([offloaded(1).id]);
  });
});

describe("catalog: loadCatalog, the one read path (D43)", () => {
  const load = async (remote: MemoryBlobStore, mirror: MemoryBlobStore) => {
    const result = await loadCatalog({ store: remote, mirror });
    if (!result.ok) throw new Error(result.finding.message);
    return result.value;
  };

  test("online: syncs, folds, caches beside the mirror and on the store; reuses the cache while nothing changed", async () => {
    const remote = memoryBlobStore();
    const mirror = memoryBlobStore();
    await appendEvent(storeEventLog(remote), offloaded(1));

    const first = await load(remote, mirror);
    expect(first).toMatchObject({ stale: false, source: "store", cached: false });
    expect(first.state).toEqual(foldCatalog([offloaded(1)]));
    expect(STATE_KEY).toBe("meta/v1/state.json");
    for (const cache of [remote.data.get(STATE_KEY), mirror.data.get(MIRROR_STATE_KEY)]) {
      expect(JSON.parse(decode(cache) as string)).toMatchObject({ v: 1, fold: FOLD_VERSION, count: 1 });
    }

    const second = await load(remote, mirror);
    expect(second).toMatchObject({ stale: false, cached: true, state: first.state });
  });

  test("a new event anywhere makes the cache stale: rebuilt from the events and rewritten", async () => {
    const remote = memoryBlobStore();
    const mirror = memoryBlobStore();
    await appendEvent(storeEventLog(remote), offloaded(1));
    await load(remote, mirror);
    await appendEvent(storeEventLog(remote), offloaded(2, idAt(777)));
    const result = await load(remote, mirror);
    expect(result.cached).toBe(false);
    expect(result.state).toEqual(foldCatalog([offloaded(1), offloaded(2, idAt(777))]));
  });

  test("I1: an event completed under the same name (a torn write on a store without hard links) refolds", async () => {
    const remote = memoryBlobStore();
    const mirror = memoryBlobStore();
    const event = offloaded(1);
    await appendEvent(storeEventLog(remote), offloaded(0));
    const key = `meta/v1/events/${event.id}.json`;
    const whole = encodeEvent(CatalogEventSchema.parse(event));
    remote.data.set(key, whole.subarray(0, 25));

    const torn = await load(remote, mirror);
    expect(torn.findings.map((f) => f.code)).toEqual(["catalog.event-skipped"]);
    expect(torn.state.projects[PROJECT]?.snapshots[event.snapshot]).toBeUndefined();

    remote.data.set(key, whole); // the retry completed it: same name, new size
    const completed = await load(remote, mirror);
    expect(completed.cached).toBe(false);
    expect(completed.findings).toEqual([]);
    expect(completed.state.projects[PROJECT]?.snapshots[event.snapshot]).toBeDefined();
  });

  test("I3: a cache built by another fold version is rebuilt, never served", async () => {
    const remote = memoryBlobStore();
    const mirror = memoryBlobStore();
    await appendEvent(storeEventLog(remote), offloaded(1));
    await load(remote, mirror);
    const cache = JSON.parse(decode(mirror.data.get(MIRROR_STATE_KEY)) as string);
    const forged = { ...cache, fold: FOLD_VERSION + 1, state: { projects: {}, roots: {} } };
    mirror.data.set(MIRROR_STATE_KEY, encode(forged));
    const result = await load(remote, mirror);
    expect(result).toMatchObject({ cached: false, state: foldCatalog([offloaded(1)]) });
  });

  test("a damaged or foreign cache is ignored and rebuilt", async () => {
    const remote = memoryBlobStore();
    const mirror = memoryBlobStore();
    await appendEvent(storeEventLog(remote), offloaded(1));
    const expected = foldCatalog([offloaded(1)]);
    for (const bad of [
      "{oops",
      JSON.stringify({ v: 9 }),
      JSON.stringify({ v: 1, digest: "x", count: 1, state: {} }),
    ]) {
      mirror.data.set(MIRROR_STATE_KEY, encode(bad));
      expect(await load(remote, mirror)).toMatchObject({ cached: false, state: expected });
    }
  });

  test("the caches are optional: failed cache writes still return the folded state", async () => {
    const remote = memoryBlobStore();
    const mirror = memoryBlobStore({ refusePutsUnder: "state.json" });
    await appendEvent(storeEventLog(remote), offloaded(1));
    expect((await load(remote, mirror)).state).toEqual(foldCatalog([offloaded(1)]));
    expect(mirror.data.has(MIRROR_STATE_KEY)).toBe(false);
  });

  test("I5: when the store is unreachable, the mirror's state comes back marked stale", async () => {
    const remote = memoryBlobStore();
    const mirror = memoryBlobStore();
    await appendEvent(storeEventLog(remote), offloaded(1));
    const online = await load(remote, mirror);
    remote.failNext("list");
    const offline = await load(remote, mirror);
    expect(offline).toMatchObject({ stale: true, source: "mirror", state: online.state });
    expect(offline.unreachable?.code).toBe("store.unreachable");
  });

  test("a store that fails otherwise is a failure, and a mirror that cannot be listed is too", async () => {
    const remote = memoryBlobStore();
    const mirror = memoryBlobStore();
    remote.failNext("list", "store.failed");
    expect(await loadCatalog({ store: remote, mirror })).toMatchObject({
      ok: false,
      finding: { code: "store.failed" },
    });
    mirror.failNext("list");
    expect(await loadCatalog({ store: remote, mirror })).toMatchObject({ ok: false });
  });

  test("skipped events are reported with the state, from the cache too", async () => {
    const remote = memoryBlobStore();
    const mirror = memoryBlobStore();
    mirror.data.set(`events/${idAt(42)}.json`, encode("{bad"));
    const first = await load(remote, mirror);
    expect(first.findings.map((f) => f.code)).toEqual(["catalog.event-skipped"]);
    const again = await load(remote, mirror);
    expect(again).toMatchObject({ cached: true });
    expect(again.findings.map((f) => f.code)).toEqual(["catalog.event-skipped"]);
  });
});
