// The catalog sync over remote stores (M2 Task 21): one listing, one batch read for everything the mirror lacks, and
// a deadline past which the read is given up for the mirror's stale state; a write path always reads the store fresh.

import { describe, expect, test } from "bun:test";
import { ok, type Result } from "@plainport/contract";
import type { Scheduler } from "../deadline.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import { type MemoryBlobStore, memoryBlobStore } from "../testing/memory-blob-store.ts";
import { ulid } from "../ulid.ts";
import { storeEventKey } from "./codec.ts";
import type { CatalogEvent } from "./events.ts";
import { catalogReader } from "./head.ts";
import { ensureStoreIdentity } from "./identity.ts";
import { appendEvent, loadCatalog, MIRROR_FILE_KEY, storeEventLog } from "./log.ts";

const idAt = (ms: number) => ulid(ms, (b) => b.fill(0));
const STORE_ID = idAt(900);
const NOW = new Date("2026-10-29T12:00:00.000Z");

const offloaded = (n: number): CatalogEvent => ({
  v: 1,
  id: idAt(1000 + n),
  type: "offloaded",
  device: idAt(3),
  at: NOW.toISOString(),
  op: idAt(500 + n),
  project: idAt(1),
  root: idAt(2),
  path: "web",
  snapshot: idAt(500 + n),
  ...(n === 1 ? {} : { base: idAt(500 + n - 1) }),
  stored: { ssd: "cd".repeat(32) },
  stats: { files: 3, bytes: 30, strippedBytes: 0, ecosystems: ["node"] },
});

/** A memory store that also offers the port's batch read, counting its calls (blob-rclone's one `copy`). */
const batching = (inner: MemoryBlobStore) => {
  const batches: string[][] = [];
  const store: BlobStore & { batches: string[][] } = {
    batches,
    semantics: () => inner.semantics(),
    capabilities: () => inner.capabilities(),
    get: (key) => inner.get(key),
    put: (key, data, options) => inner.put(key, data, options),
    list: (prefix) => inner.list(prefix),
    stat: (key) => inner.stat(key),
    delete: (key) => inner.delete(key),
    getMany: async (keys) => {
      batches.push([...keys]);
      const got = new Map<string, Uint8Array>();
      for (const key of keys) {
        const value = await inner.get(key);
        if (!value.ok) return value;
        if (value.value !== null) got.set(key, value.value);
      }
      return ok(got);
    },
  };
  return store;
};

const seeded = async (events: number) => {
  const inner = memoryBlobStore();
  const id = await ensureStoreIdentity(inner, () => STORE_ID);
  if (!id.ok) throw new Error(id.finding.message);
  for (let n = 1; n <= events; n++) {
    const appended = await appendEvent(storeEventLog(inner), offloaded(n));
    if (!appended.ok) throw new Error(appended.finding.message);
  }
  return inner;
};

/** A scheduler whose timers fire only when the test says so. */
const manualScheduler = () => {
  const timers: (() => void)[] = [];
  const scheduler: Scheduler = {
    setTimer: (fire) => {
      timers.push(fire);
      return timers.length - 1;
    },
    clearTimer: () => {},
  };
  return {
    scheduler,
    fire: () => {
      for (const fire of timers.splice(0)) fire();
    },
  };
};

/** A store whose listing never answers until released. */
const hanging = (inner: BlobStore) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store: BlobStore = {
    ...inner,
    semantics: () => inner.semantics(),
    capabilities: () => inner.capabilities(),
    get: (key) => inner.get(key),
    put: (key, data, options) => inner.put(key, data, options),
    stat: (key) => inner.stat(key),
    delete: (key) => inner.delete(key),
    list: async (prefix): Promise<Result<{ key: string; size: number }[]>> => {
      await gate;
      return inner.list(prefix);
    },
  };
  return { store, release: () => release() };
};

describe("catalog: the sync over a remote store (Task 21)", () => {
  test("one listing and one batch read fetch everything the mirror lacks; nothing is fetched one by one", async () => {
    const inner = await seeded(50);
    const store = batching(inner);
    const mirror = memoryBlobStore();
    inner.calls.get = 0;
    inner.calls.list = 0;
    const first = await loadCatalog({ store, mirror, storeId: STORE_ID, now: NOW });
    expect(first.ok && first.value.copied).toBe(50);
    expect(inner.calls.list).toBe(1);
    expect(store.batches).toHaveLength(1);
    expect(store.batches[0]).toHaveLength(50);
    // The identity file is the one get; the events came in the batch.
    expect(inner.calls.get - 50).toBe(1);
    expect(first.ok && first.value.state.projects[idAt(1)]?.head).toBe(idAt(550));

    // Nothing new: no batch at all. One new event: a batch of one.
    expect((await loadCatalog({ store, mirror, storeId: STORE_ID, now: NOW })).ok).toBe(true);
    expect(store.batches).toHaveLength(1);
    await appendEvent(storeEventLog(inner), offloaded(51));
    const third = await loadCatalog({ store, mirror, storeId: STORE_ID, now: NOW });
    expect(third.ok && third.value.copied).toBe(1);
    expect(store.batches.at(-1)).toEqual([storeEventKey(idAt(1051))]);
  });

  test("a sync past its deadline is given up: the mirror's state comes back stale, and nothing more is written to it", async () => {
    const inner = await seeded(3);
    const mirror = memoryBlobStore();
    expect((await loadCatalog({ store: inner, mirror, storeId: STORE_ID, now: NOW })).ok).toBe(true);
    await appendEvent(storeEventLog(inner), offloaded(4));
    const { store, release } = hanging(inner);
    const timers = manualScheduler();
    const before = new TextDecoder().decode(mirror.data.get(MIRROR_FILE_KEY));
    const loading = loadCatalog({
      store,
      mirror,
      storeId: STORE_ID,
      now: new Date(NOW.getTime() + 60_000),
      deadline: { ms: 30_000, scheduler: timers.scheduler, store: "nas" },
    });
    await Bun.sleep(5);
    timers.fire();
    const read = await loading;
    expect(read.ok && read.value).toMatchObject({
      stale: true,
      source: "mirror",
      syncedAt: NOW.toISOString(),
      unreachable: {
        code: "store.unreachable",
        message: expect.stringContaining("store nas did not answer"),
      },
    });
    expect(read.ok && read.value.state.projects[idAt(1)]?.head).toBe(idAt(503));
    // The abandoned refresh goes on when the store answers, and writes nothing to the mirror.
    mirror.calls.put = 0;
    release();
    await Bun.sleep(20);
    expect(mirror.calls.put).toBe(0);
    expect(new TextDecoder().decode(mirror.data.get(MIRROR_FILE_KEY))).toBe(before);
  });

  test("a write path always reads fresh: a store that does not answer within the deadline refuses, never the mirror", async () => {
    const inner = await seeded(2);
    const mirror = memoryBlobStore();
    expect((await loadCatalog({ store: inner, mirror, storeId: STORE_ID, now: NOW })).ok).toBe(true);
    const { store, release } = hanging(inner);
    const timers = manualScheduler();
    const reading = catalogReader({
      store,
      mirror,
      storeId: STORE_ID,
      storeName: "nas",
      now: () => NOW,
      report: () => {},
      deadlineMs: 120_000,
      scheduler: timers.scheduler,
    })();
    await Bun.sleep(5);
    timers.fire();
    const read = await reading;
    expect(read.ok ? "ok" : [read.exitCode, read.finding.code]).toEqual([9, "store.unreachable"]);
    release();
    // And an unreachable store refuses the same way, whatever its mirror holds.
    inner.failNext("get", "store.unreachable");
    const offline = await catalogReader({
      store: inner,
      mirror,
      storeId: STORE_ID,
      storeName: "nas",
      now: () => NOW,
      report: () => {},
    })();
    expect(offline.ok ? "ok" : offline.finding.code).toBe("store.unreachable");
  });
});
