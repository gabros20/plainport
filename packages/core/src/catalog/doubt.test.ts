// Doubt without the clock (M2 Task 21, astra's Important 6): an event the read left out makes head-dependent decisions
// uncertain whatever its ULID's time says, since a writer's clock may run slow. An event whose project cannot be told
// (or, on a sealed store, authenticated) taints every head on the store; one whose project is known taints that
// project only; either clears once the event reads.

import { describe, expect, test } from "bun:test";
import { memoryBlobStore } from "../testing/memory-blob-store.ts";
import { ulid } from "../ulid.ts";
import { type CatalogPolicy, encode, encodePlain, storeEventKey } from "./codec.ts";
import { type CatalogEvent, CatalogEventSchema } from "./events.ts";
import { headCheck, headUncertain } from "./head.ts";
import { ensureStoreIdentity } from "./identity.ts";
import { appendEvent, type LoadedCatalog, loadCatalog, MIRROR_FILE_KEY, storeEventLog } from "./log.ts";

const idAt = (ms: number, fill = 0) => ulid(ms, (b) => b.fill(fill));
const STORE_ID = idAt(900);
const PROJECT = idAt(1);
const OTHER = idAt(4);
const ROOT = idAt(2);
const DEVICE = idAt(3);
const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);
const SEALED: CatalogPolicy = { seal: "sealed", storeId: STORE_ID, key: KEY };
const NOW = new Date("2026-10-29T12:00:00.000Z");
/** The readable head's event time: A's clock. */
const HEAD_MS = 1_800_000_000_000;

const offloaded = (
  id: string,
  snapshot: string,
  more: { project?: string; base?: string } = {},
): Extract<CatalogEvent, { type: "offloaded" }> => ({
  v: 1,
  id,
  type: "offloaded",
  device: DEVICE,
  at: "2026-10-29T12:00:00.000Z",
  op: snapshot,
  project: more.project ?? PROJECT,
  root: ROOT,
  path: more.project === undefined ? "web" : "api",
  snapshot,
  ...(more.base === undefined ? {} : { base: more.base }),
  stored: { ssd: "cd".repeat(32) },
  stats: { files: 3, bytes: 30, strippedBytes: 0, ecosystems: ["node"] },
});

const bytes = (text: string) => new TextEncoder().encode(text);
const said = {
  what: "nothing was restored",
  instead: (newest?: string) => (newest === undefined ? "name a snapshot" : `restore ${newest}`),
};

const world = async (policy?: CatalogPolicy) => {
  const store = memoryBlobStore();
  const id = await ensureStoreIdentity(store, () => STORE_ID);
  if (!id.ok) throw new Error(id.finding.message);
  const mirror = memoryBlobStore();
  const log = storeEventLog(store, policy);
  const append = async (event: CatalogEvent) => {
    const appended = await appendEvent(log, event);
    if (!appended.ok) throw new Error(appended.finding.message);
  };
  const load = async (): Promise<LoadedCatalog> => {
    const read = await loadCatalog({
      store,
      mirror,
      storeId: STORE_ID,
      now: NOW,
      ...(policy === undefined ? {} : { policy }),
    });
    if (!read.ok) throw new Error(`${read.finding.code}: ${read.finding.message}`);
    return read.value;
  };
  return { store, mirror, append, load };
};

/** The read as head.ts takes it. */
const asRead = (read: LoadedCatalog) => ({
  ...read.state,
  uncertain: read.uncertain,
  tainted: read.tainted,
  doubt: read.doubt,
});

describe("catalog: doubt without the clock (Task 21)", () => {
  // A wrote S1 with a fast clock; B later made S2 from S1 with a slow one, and S2's event cannot be read. Whatever
  // order the ULIDs sort in, the readable S1 is never taken for the newest head.
  const s1 = idAt(HEAD_MS - 1000);
  const head = idAt(HEAD_MS, 0x80);
  for (const [name, damaged] of [
    [
      "negative clock skew: the damaged event's ULID time is a minute before the head's",
      idAt(HEAD_MS - 60_000),
    ],
    ["equal timestamps: the damaged event's ULID has the head's time and sorts before it", idAt(HEAD_MS, 0)],
    ["a damaged event that sorts before every readable event", idAt(10)],
  ] as const) {
    test(`${name}: each head-dependent decision refuses`, async () => {
      const { store, append, load } = await world();
      await append(offloaded(head, s1));
      await append(offloaded(idAt(HEAD_MS + 5), idAt(HEAD_MS + 4), { project: OTHER }));
      store.data.set(storeEventKey(damaged), bytes('{"v":1,"id":"'));
      for (const read of [await load(), await load()]) {
        expect(read.state.projects[PROJECT]?.head).toBe(s1);
        expect(read.doubt).toEqual({ store: [damaged], projects: {} });
        // A fresh device that knows no snapshot of the project: the default onload refuses.
        const fresh = headUncertain(asRead(read), PROJECT, [], "work:web", said);
        expect(fresh?.newest).toBeUndefined();
        expect(fresh?.finding).toMatchObject({
          code: "catalog.head-uncertain",
          severity: "block",
          message: expect.stringContaining(damaged),
          fix: expect.stringContaining("name a snapshot"),
        });
        // A copy made from the readable head: its offload refuses too, never a commit on top of S1.
        expect(headCheck(asRead(read), PROJECT, s1, "work:web")).toMatchObject({
          kind: "incomplete",
          finding: { code: "catalog.head-uncertain" },
        });
        // The project cannot be told: every project on the store is uncertain.
        expect(headUncertain(asRead(read), OTHER, [idAt(HEAD_MS + 4)], "work:api", said)).toBeDefined();
      }
    });
  }

  test("an unreadable sealed event of unknown project taints the store", async () => {
    const { store, append, load } = await world(SEALED);
    await append(offloaded(head, s1));
    await append(offloaded(idAt(HEAD_MS + 5), idAt(HEAD_MS + 4), { project: OTHER }));
    // Sealed under another key: it does not open, so nothing it says can be authenticated.
    const foreign = idAt(HEAD_MS + 9);
    const sealed = encode(offloaded(foreign, idAt(HEAD_MS + 8)), { ...SEALED, key: OTHER_KEY });
    if (!sealed.ok) throw new Error(sealed.finding.message);
    store.data.set(storeEventKey(foreign), sealed.value);
    // Plaintext on a sealed store names a project, which nobody with the seal key vouches for.
    const plaintext = idAt(HEAD_MS + 11);
    store.data.set(storeEventKey(plaintext), encodePlain(offloaded(plaintext, idAt(HEAD_MS + 10))));
    for (const read of [await load(), await load()]) {
      expect(read.doubt).toEqual({ store: [foreign, plaintext], projects: {} });
      expect(headUncertain(asRead(read), PROJECT, [s1], "work:web", said)).toBeDefined();
      expect(headUncertain(asRead(read), OTHER, [idAt(HEAD_MS + 4)], "work:api", said)).toBeDefined();
    }
  });

  test("an unreadable sealed event whose project is known taints only that project", async () => {
    const { store, append, load } = await world(SEALED);
    await append(offloaded(head, s1));
    await append(offloaded(idAt(HEAD_MS + 5), idAt(HEAD_MS + 4), { project: OTHER }));
    // It opens under the store's key, so its project is authenticated; this version cannot use its type.
    const newer = idAt(HEAD_MS - 60_000);
    const line = `${JSON.stringify({ v: 1, id: newer, type: "merged", project: PROJECT, at: NOW.toISOString() })}\n`;
    const { seal } = await import("./seal.ts");
    const sealed = seal({
      key: KEY,
      storeId: STORE_ID,
      eventKey: storeEventKey(newer),
      plaintext: bytes(line),
    });
    if (!sealed.ok) throw new Error(sealed.finding.message);
    store.data.set(storeEventKey(newer), bytes(`${sealed.value}\n`));
    for (const read of [await load(), await load()]) {
      expect(read.doubt).toEqual({ store: [], projects: { [PROJECT]: [newer] } });
      const doubt = headUncertain(asRead(read), PROJECT, [s1], "work:web", said);
      expect(doubt?.finding.message).toContain(newer);
      expect(headUncertain(asRead(read), OTHER, [idAt(HEAD_MS + 4)], "work:api", said)).toBeUndefined();
      expect(headCheck(asRead(read), OTHER, idAt(HEAD_MS + 4), "work:api")).toEqual({ kind: "ok" });
    }
  });

  test("the doubt clears when the event reads", async () => {
    const { store, append, load } = await world();
    await append(offloaded(head, s1));
    const s2 = offloaded(idAt(HEAD_MS - 60_000), idAt(HEAD_MS - 60_001), { base: s1 });
    const whole = encodePlain(CatalogEventSchema.parse(s2));
    store.data.set(storeEventKey(s2.id), bytes('{"v":1,"id":"'));
    expect((await load()).doubt.store).toEqual([s2.id]);
    store.data.set(storeEventKey(s2.id), whole);
    const read = await load();
    expect(read.doubt).toEqual({ store: [], projects: {} });
    expect(read.state.projects[PROJECT]?.head).toBe(s2.snapshot);
    expect(headUncertain(asRead(read), PROJECT, [], "work:web", said)).toBeUndefined();
  });

  test("a torn plain event whose prefix names its project taints only that project, and is read again each sync", async () => {
    const { store, append, load } = await world();
    await append(offloaded(head, s1));
    await append(offloaded(idAt(HEAD_MS + 5), idAt(HEAD_MS + 4), { project: OTHER }));
    const s2 = offloaded(idAt(HEAD_MS - 60_000), idAt(HEAD_MS - 60_001), { base: s1 });
    const whole = encodePlain(CatalogEventSchema.parse(s2));
    // Cut short after its project (a crash mid-write on a disk without hard links, D41).
    const text = new TextDecoder().decode(whole);
    const cut = text.indexOf(`"project":"${PROJECT}"`) + `"project":"${PROJECT}"`.length + 4;
    store.data.set(storeEventKey(s2.id), whole.subarray(0, cut));
    const first = await load();
    expect(first.doubt).toEqual({ store: [], projects: { [PROJECT]: [s2.id] } });
    expect(headUncertain(asRead(first), OTHER, [idAt(HEAD_MS + 4)], "work:api", said)).toBeUndefined();
    expect(headUncertain(asRead(first), PROJECT, [s1], "work:web", said)).toBeDefined();
    store.calls.get = 0;
    const again = await load();
    expect(again.doubt).toEqual(first.doubt);
    expect(store.calls.get).toBeGreaterThan(1); // the identity file, and the torn file again
    // The writer's retry completes it under its own name (D42): it reads, and the doubt is gone.
    store.data.set(storeEventKey(s2.id), whole);
    const read = await load();
    expect(read.doubt).toEqual({ store: [], projects: {} });
    expect(read.state.projects[PROJECT]?.head).toBe(s2.snapshot);
  });

  test("a torn event cut before its project is remembered as skipped, and taints the store offline too", async () => {
    const { store, mirror, append, load } = await world();
    await append(offloaded(head, s1));
    const torn = idAt(HEAD_MS - 60_000);
    store.data.set(storeEventKey(torn), bytes(`{"v":1,"id":"${torn}","ty`));
    expect((await load()).doubt.store).toEqual([torn]);
    expect(
      Object.keys(JSON.parse(new TextDecoder().decode(mirror.data.get(MIRROR_FILE_KEY))).skipped),
    ).toEqual([torn]);
    store.failNext("get", "store.unreachable");
    const offline = await load();
    expect(offline.stale).toBe(true);
    expect(offline.doubt).toEqual({ store: [torn], projects: {} });
  });

  test("a stored-multiple producer taints its project; a stored-multiple discard taints no head", async () => {
    const { store, append, load } = await world();
    await append(offloaded(head, s1));
    await append(offloaded(idAt(HEAD_MS + 5), idAt(HEAD_MS + 4), { project: OTHER }));
    const two = { ssd: "cd".repeat(32), nas: "ef".repeat(32) };
    const producer = {
      ...offloaded(idAt(HEAD_MS - 60_000), idAt(HEAD_MS - 60_001), { base: s1 }),
      stored: two,
    };
    store.data.set(storeEventKey(producer.id), encodePlain(CatalogEventSchema.parse(producer)));
    const discard: CatalogEvent = {
      v: 1,
      id: idAt(HEAD_MS + 20),
      type: "snapshot-discarded",
      device: DEVICE,
      at: NOW.toISOString(),
      op: idAt(HEAD_MS + 19),
      project: OTHER,
      root: ROOT,
      path: "api",
      snapshot: idAt(HEAD_MS + 19),
      stored: two,
    };
    store.data.set(storeEventKey(discard.id), encodePlain(CatalogEventSchema.parse(discard)));
    const read = await load();
    expect(read.doubt).toEqual({ store: [], projects: { [PROJECT]: [producer.id] } });
    expect(headUncertain(asRead(read), PROJECT, [s1], "work:web", said)?.newest).toBe(producer.snapshot);
    expect(headUncertain(asRead(read), OTHER, [idAt(HEAD_MS + 4)], "work:api", said)).toBeUndefined();
  });
});
