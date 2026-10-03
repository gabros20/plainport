import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolvePaths } from "../paths.ts";
import { memoryBlobStore } from "../testing/memory-blob-store.ts";
import { ulid } from "../ulid.ts";
import {
  appendEvent,
  type CatalogEvent,
  eventMirrorDir,
  foldCatalog,
  loadCatalogState,
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

  test("sync copies the store's new events into the mirror and returns the union", async () => {
    const remote = memoryBlobStore();
    const mirror = memoryBlobStore();
    for (const n of [1, 2]) await appendEvent(storeEventLog(remote), offloaded(n));
    const localOnly = offloaded(3);
    await appendEvent(mirrorEventLog(mirror), localOnly);

    const first = await syncMirror(storeEventLog(remote), mirrorEventLog(mirror));
    if (!first.ok) throw new Error(first.finding.message);
    expect(first.value.copied).toBe(2);
    expect(first.value.events.map((e) => e.id)).toEqual([offloaded(1).id, offloaded(2).id, localOnly.id]);
    expect([...mirror.data.keys()].sort()).toEqual(
      [1, 2, 3].map((n) => `events/${offloaded(n).id}.json`).sort(),
    );

    const second = await syncMirror(storeEventLog(remote), mirrorEventLog(mirror));
    expect(second.ok && second.value.copied).toBe(0);
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

describe("catalog: state.json cache", () => {
  test("built from the events, written to meta/v1/state.json, reused while the events are unchanged", async () => {
    const store = memoryBlobStore();
    const log = storeEventLog(store);
    await appendEvent(log, offloaded(1));

    const first = await loadCatalogState(store);
    if (!first.ok) throw new Error(first.finding.message);
    expect(first.value.cached).toBe(false);
    expect(first.value.state).toEqual(foldCatalog([offloaded(1)]));
    expect(STATE_KEY).toBe("meta/v1/state.json");
    const cache = JSON.parse(decode(store.data.get(STATE_KEY)) as string);
    expect(cache).toMatchObject({ v: 1, count: 1 });

    const second = await loadCatalogState(store);
    expect(second.ok && second.value.cached).toBe(true);
    expect(second.ok && second.value.state).toEqual(first.value.state);
  });

  test("a new event makes the cache stale: the state is rebuilt from events and the cache rewritten", async () => {
    const store = memoryBlobStore();
    const log = storeEventLog(store);
    await appendEvent(log, offloaded(1));
    await loadCatalogState(store);
    await appendEvent(log, offloaded(2, idAt(777)));

    const result = await loadCatalogState(store);
    if (!result.ok) throw new Error(result.finding.message);
    expect(result.value.cached).toBe(false);
    expect(result.value.state).toEqual(foldCatalog([offloaded(1), offloaded(2, idAt(777))]));
    expect(JSON.parse(decode(store.data.get(STATE_KEY)) as string).count).toBe(2);
  });

  test("a damaged or foreign state.json is ignored and rebuilt, never trusted", async () => {
    const store = memoryBlobStore();
    await appendEvent(storeEventLog(store), offloaded(1));
    const expected = foldCatalog([offloaded(1)]);
    for (const bad of [
      "{oops",
      JSON.stringify({ v: 9 }),
      JSON.stringify({ v: 1, digest: "x", count: 1, state: {} }),
    ]) {
      store.data.set(STATE_KEY, encode(bad));
      const result = await loadCatalogState(store);
      expect(result.ok && result.value).toMatchObject({ cached: false, state: expected });
    }
  });

  test("the cache is optional: a failed cache write still returns the folded state", async () => {
    const store = memoryBlobStore();
    await appendEvent(storeEventLog(store), offloaded(1));
    store.failNext("put");
    const result = await loadCatalogState(store);
    expect(result.ok && result.value.state).toEqual(foldCatalog([offloaded(1)]));
    expect(store.data.has(STATE_KEY)).toBe(false);
  });

  test("skipped events are reported with the state", async () => {
    const store = memoryBlobStore();
    store.data.set(`meta/v1/events/${idAt(42)}.json`, encode("{bad"));
    const result = await loadCatalogState(store);
    expect(result.ok && result.value.findings.map((f) => f.code)).toEqual(["catalog.event-skipped"]);
  });
});
