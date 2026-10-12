import { describe, expect, test } from "bun:test";
import type { BlobStore } from "../ports/blob-store.ts";
import { type MemoryBlobStore, memoryBlobStore } from "../testing/memory-blob-store.ts";
import { ulid } from "../ulid.ts";
import {
  appendEvent,
  type CatalogEvent,
  encodeEvent,
  encodeStoreIdentityV2,
  ensureStoreIdentity,
  loadCatalog,
  readEvents,
  readStoreDescriptor,
  readUsableStore,
  STORE_EVENTS_PREFIX,
  STORE_IDENTITY_KEY,
  STORED_MULTIPLE,
  storedHere,
  storedKey,
  storeEventLog,
} from "./index.ts";

const idAt = (ms: number) => ulid(ms, (b) => b);
const DEVICE = idAt(3);
const PROJECT = idAt(1);
const ROOT = idAt(2);
const NOW = new Date("2026-10-12T12:00:00.000Z");

const offloaded = (
  n: number,
  stored: Record<string, string>,
): Extract<CatalogEvent, { type: "offloaded" }> => ({
  v: 1,
  id: idAt(1000 + n),
  type: "offloaded",
  device: DEVICE,
  at: "2026-10-12T12:00:00.000Z",
  op: idAt(500 + n),
  project: PROJECT,
  root: ROOT,
  path: "web",
  snapshot: idAt(500 + n),
  stored,
  stats: { files: 3, bytes: 30, strippedBytes: 0, ecosystems: ["node"] },
});

/** Writes an event file as some other writer left it, past appendEvent's checks. */
const put = (store: MemoryBlobStore, event: CatalogEvent) =>
  store.data.set(`${STORE_EVENTS_PREFIX}${event.id}.json`, encodeEvent(event));

const value = <T>(result: { ok: true; value: T } | { ok: false; finding: { message: string } }): T => {
  if (!result.ok) throw new Error(result.finding.message);
  return result.value;
};

describe("stored: the writers' key (Q11)", () => {
  test("[stored] one entry keyed by the store's id on format 2 and by this device's alias on format 1", () => {
    const store = { name: "archive", id: idAt(9) };
    expect(storedKey(store, 2)).toBe(idAt(9));
    expect(storedKey(store, 1)).toBe("archive");
  });

  test("[stored] a reader never interprets the key: one entry is the location, any other count is none", () => {
    const restic = "ab".repeat(32);
    for (const key of ["archive", "nas", idAt(9), ulid(), "local"])
      expect(storedHere({ [key]: restic })).toBe(restic);
    expect(storedHere({})).toBeUndefined();
    expect(storedHere({ a: restic, b: restic })).toBeUndefined();
  });
});

describe("stored: events read from a store (Q11)", () => {
  test("[stored] an event with zero or two stored entries is skipped (stored-multiple) and makes the fold uncertain", async () => {
    const store = memoryBlobStore();
    value(await ensureStoreIdentity(store, () => idAt(900)));
    const one = offloaded(1, { ssd: "cd".repeat(32) });
    const two = offloaded(2, { ssd: "cd".repeat(32), b2: "ef".repeat(32) });
    const none = offloaded(3, {});
    for (const e of [one, two, none]) put(store, e);
    const read = value(await readEvents(storeEventLog(store)));
    expect(read.events.map((e) => e.id)).toEqual([one.id]);
    const messages = read.findings.map((f) => `${f.code} ${f.message}`);
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.startsWith("catalog.event-skipped"))).toBe(true);
    // Two entries: unsupported until M3 defines multi-store locations. None fails the offloaded schema already.
    expect(messages.find((m) => m.includes(two.id))).toContain(STORED_MULTIPLE);
    expect(messages.find((m) => m.includes(none.id))).toBeDefined();
    const loaded = value(
      await loadCatalog({ store, mirror: memoryBlobStore(), storeId: idAt(900), now: NOW }),
    );
    expect(loaded.uncertain).toEqual([two.id, none.id].sort());
    expect(Object.keys(loaded.state.projects[PROJECT]?.snapshots ?? {})).toEqual([one.snapshot]);
  });

  test("[stored] appendEvent refuses an event with zero or two stored entries, and writes nothing", async () => {
    const store = memoryBlobStore();
    const counts: Record<string, string>[] = [{}, { a: "cd".repeat(32), b: "ef".repeat(32) }];
    for (const stored of counts) {
      const refused = await appendEvent(storeEventLog(store), offloaded(4, stored));
      expect(refused.ok ? "ok" : refused.finding.code).toBe("contract.invalid");
    }
    expect(store.data.size).toBe(0);
  });

  test("[stored] the catalog read gives the store's format, which keys what is written on top of it", async () => {
    const store = memoryBlobStore();
    value(await ensureStoreIdentity(store, () => idAt(900)));
    const loaded = value(
      await loadCatalog({ store, mirror: memoryBlobStore(), storeId: idAt(900), now: NOW }),
    );
    expect(loaded.format).toBe(1);
    // A format-2 store is told apart by its descriptor; the M1 read paths refuse it until its repository is wired.
    const two = memoryBlobStore();
    two.data.set(STORE_IDENTITY_KEY, encodeStoreIdentityV2({ id: idAt(901), repo: "repo", seal: "none" }));
    expect(value(await readStoreDescriptor(two))?.format).toBe(2);
    const usable = await readUsableStore(two);
    expect(usable.ok ? "ok" : usable.finding.code).toBe("store.unsupported");
  });

  test("[stored] local and sftp access to the same store (D68) give one id, and one location", async () => {
    const disk = memoryBlobStore();
    value(await ensureStoreIdentity(disk, () => idAt(900)));
    // The same store reached another way (sftp to the same disk): another BlobStore over the same keys.
    const viaSftp: BlobStore = {
      capabilities: () => disk.capabilities(),
      semantics: () => disk.semantics(),
      get: (key) => disk.get(key),
      put: (key, bytes, options) => disk.put(key, bytes, options),
      list: (prefix) => disk.list(prefix),
      stat: (key) => disk.stat(key),
      delete: (key) => disk.delete(key),
    };
    const event = offloaded(5, { disk: "cd".repeat(32) });
    value(await appendEvent(storeEventLog(disk), event));
    const viaDisk = value(await readUsableStore(disk));
    const viaRemote = value(await readUsableStore(viaSftp));
    expect(viaRemote?.id).toBe(viaDisk?.id as string);
    const mirror = memoryBlobStore();
    for (const blob of [disk, viaSftp]) {
      const loaded = value(await loadCatalog({ store: blob, mirror, storeId: idAt(900), now: NOW }));
      const made = loaded.state.projects[PROJECT]?.snapshots[event.snapshot];
      expect(made === undefined ? undefined : storedHere(made.stored)).toBe("cd".repeat(32));
    }
  });

  test("[stored] a legacy M1 event and one keyed by the store's id both resolve to the store read", async () => {
    const store = memoryBlobStore();
    value(await ensureStoreIdentity(store, () => idAt(900)));
    const legacy = offloaded(6, { local: "aa".repeat(32) });
    const byId = { ...offloaded(7, { [idAt(900)]: "bb".repeat(32) }), base: legacy.snapshot };
    // An M1 alias shaped like a ULID that is not the store's id is just a key.
    const shaped = { ...offloaded(8, { [ulid()]: "cc".repeat(32) }), base: byId.snapshot };
    for (const e of [legacy, byId, shaped]) put(store, e);
    const loaded = value(
      await loadCatalog({ store, mirror: memoryBlobStore(), storeId: idAt(900), now: NOW }),
    );
    const snapshots = loaded.state.projects[PROJECT]?.snapshots ?? {};
    expect([legacy, byId, shaped].map((e) => storedHere(snapshots[e.snapshot]?.stored ?? {}))).toEqual([
      "aa".repeat(32),
      "bb".repeat(32),
      "cc".repeat(32),
    ]);
    expect(loaded.uncertain).toEqual([]);
  });
});
