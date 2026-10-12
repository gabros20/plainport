import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { memoryBlobStore } from "../testing/memory-blob-store.ts";
import { semanticBlobStore } from "../testing/semantic-blob-store.ts";
import { ulid } from "../ulid.ts";
import {
  type CatalogPolicy,
  decode,
  encode,
  encodePlain,
  PLAIN_CATALOG,
  type SkipReason,
  sameEvent,
  storeEventKey,
} from "./codec.ts";
import { type CatalogEvent, CatalogEventSchema } from "./events.ts";
import { ensureStoreIdentity } from "./identity.ts";
import {
  appendEvent,
  eventAt,
  loadCatalog,
  MIRROR_FILE_KEY,
  mirrorEventLog,
  readEvents,
  storeEventLog,
  uncertainEvents,
} from "./log.ts";
import { publishEvent } from "./publish.ts";

const idAt = (ms: number) => ulid(ms, (b) => b);
const STORE_ID = idAt(900);
const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);
const SEALED: CatalogPolicy = { seal: "sealed", storeId: STORE_ID, key: KEY };
const NOW = new Date("2026-10-12T12:00:00.000Z");

const offloaded = (n: number): Extract<CatalogEvent, { type: "offloaded" }> => ({
  v: 1,
  id: idAt(1000 + n),
  type: "offloaded",
  device: idAt(3),
  at: "2026-10-03T12:00:00.000Z",
  op: idAt(500 + n),
  project: idAt(1),
  root: idAt(2),
  path: "web",
  snapshot: idAt(500 + n),
  stored: { ssd: "a".repeat(64) },
  stats: { files: 3, bytes: 300, strippedBytes: 0, ecosystems: ["node"] },
});

/** The plain line appendEvent writes: the event in its schema's key order. */
const plainOf = (event: CatalogEvent) => encodePlain(CatalogEventSchema.parse(event));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytes = (value: string) => new TextEncoder().encode(value);
const sealed = (event: CatalogEvent, policy: CatalogPolicy = SEALED): Uint8Array => {
  const encoded = encode(event, policy);
  if (!encoded.ok) throw new Error(encoded.finding.message);
  return encoded.value;
};
const reasonOf = (decoded: ReturnType<typeof decode>): SkipReason | "event" =>
  "skip" in decoded ? decoded.skip.reason : "event";

describe("codec: encode and decode", () => {
  test("plain: the transport bytes are the plain line, and decode to the event", () => {
    const event = offloaded(1);
    const data = sealed(event, PLAIN_CATALOG);
    expect(text(data)).toBe(`${JSON.stringify(event)}\n`);
    const decoded = decode(data, storeEventKey(event.id), PLAIN_CATALOG);
    expect(decoded).toEqual({ event, opened: data });
  });

  test("sealed: the transport bytes are one envelope line that opens to the plain line", () => {
    const event = offloaded(1);
    const data = sealed(event);
    expect(text(data).endsWith("\n")).toBe(true);
    expect(text(data)).not.toContain(event.project);
    expect(JSON.parse(text(data))).toMatchObject({ pp_seal: 1 });
    const decoded = decode(data, storeEventKey(event.id), SEALED);
    expect(decoded).toEqual({ event, opened: encodePlain(event) });
  });

  test("every skip reason is typed, with its finding naming the file", () => {
    const event = offloaded(1);
    const key = storeEventKey(event.id);
    const plain = encodePlain(event);
    const cases: [string, Uint8Array, CatalogPolicy, SkipReason, string][] = [
      ["torn", plain.subarray(0, 30), PLAIN_CATALOG, "torn", "catalog.event-skipped"],
      ["torn, sealed", sealed(event).subarray(0, 40), SEALED, "torn", "catalog.event-skipped"],
      ["not JSON", bytes("{nope\n"), PLAIN_CATALOG, "not-json", "catalog.event-skipped"],
      [
        "schema",
        bytes(`${JSON.stringify({ ...event, stats: "big" })}\n`),
        PLAIN_CATALOG,
        "schema",
        "catalog.event-skipped",
      ],
      [
        "wrong id",
        encodePlain({ ...event, id: idAt(77) }),
        PLAIN_CATALOG,
        "wrong-id",
        "catalog.event-skipped",
      ],
      [
        "unknown type",
        bytes(`${JSON.stringify({ v: 1, id: event.id, type: "merged" })}\n`),
        PLAIN_CATALOG,
        "unknown-type",
        "catalog.event-skipped",
      ],
      ["plaintext on a sealed store", plain, SEALED, "unsealed-event", "catalog.unsealed-event"],
      [
        "sealed under another key",
        sealed(event, { ...SEALED, key: OTHER_KEY }),
        SEALED,
        "seal-failed",
        "catalog.seal-failed",
      ],
      [
        "sealed for another store",
        sealed(event, { ...SEALED, storeId: idAt(901) }),
        SEALED,
        "seal-failed",
        "catalog.seal-failed",
      ],
      ["sealed, on a plain store", sealed(event), PLAIN_CATALOG, "seal-failed", "catalog.seal-failed"],
      [
        "wrong id inside the seal",
        sealed({ ...event, id: idAt(77) }, SEALED),
        SEALED,
        "seal-failed", // sealed for the other id's key: the associated data does not match
        "catalog.seal-failed",
      ],
    ];
    for (const [name, data, policy, reason, code] of cases) {
      const decoded = decode(data, key, policy);
      expect([name, reasonOf(decoded)]).toEqual([name, reason]);
      if ("skip" in decoded) {
        expect([name, decoded.skip.finding.code]).toEqual([name, code]);
        expect(decoded.skip.finding.paths).toEqual([key]);
        expect(decoded.skip.bytes).toBe(reason === "torn" || reason === "not-json");
      }
    }
  });

  test("a sealed event moved to another event key does not open", () => {
    const event = offloaded(1);
    const moved = decode(sealed(event), storeEventKey(offloaded(2).id), SEALED);
    expect(reasonOf(moved)).toBe("seal-failed");
  });

  test("every skip reason leaves the fold uncertain (D86)", () => {
    const event = offloaded(1);
    const key = storeEventKey(event.id);
    const findings = [
      decode(encodePlain(event), key, SEALED),
      decode(sealed(event, { ...SEALED, key: OTHER_KEY }), key, SEALED),
      decode(bytes("{"), key, PLAIN_CATALOG),
    ].map((d) => ("skip" in d ? d.skip.finding : undefined));
    for (const f of findings) expect(uncertainEvents(f === undefined ? [] : [f])).toEqual([event.id]);
  });
});

describe("codec: the same event, opened (R2-8)", () => {
  test("a sealed retry under a new nonce is the same event; another event is not; another key cannot tell", async () => {
    const event = offloaded(1);
    const key = storeEventKey(event.id);
    const same = sameEvent(key, SEALED);
    const first = sealed(event);
    const retry = sealed(event);
    expect(text(first)).not.toBe(text(retry));
    expect(await same(first, retry)).toEqual({ ok: true, value: true });
    expect(await same(first, sealed({ ...event, path: "other" }))).toEqual({ ok: true, value: false });
    expect(await same(bytes('{"v":1'), retry)).toEqual({ ok: true, value: false });
    const foreign = await same(sealed(event, { ...SEALED, key: OTHER_KEY }), retry);
    expect(foreign).toMatchObject({ ok: false, finding: { code: "catalog.seal-failed" } });
  });

  test("a sealed append whose acknowledgement is lost, then retried, gives one event", async () => {
    const store = semanticBlobStore();
    const log = storeEventLog(store, SEALED);
    const event = offloaded(1);
    store.loseAckNext();
    const lost = await appendEvent(log, event);
    expect(lost.ok).toBe(false);
    expect(await appendEvent(log, event)).toEqual({ ok: true, value: undefined });
    expect([...store.data.keys()].filter((k) => k.startsWith("meta/v1/events/"))).toEqual([
      storeEventKey(event.id),
    ]);
    const read = await readEvents(log);
    expect(read.ok && read.value).toEqual({ events: [event], findings: [], tainted: [] });
  });

  test("publishEvent with the codec's SameEvent: a lost acknowledgement, then a retry with a new nonce, is one event", async () => {
    const store = semanticBlobStore();
    const event = offloaded(1);
    const key = storeEventKey(event.id);
    store.loseAckNext();
    const first = await publishEvent(store, { key, data: sealed(event), sameEvent: sameEvent(key, SEALED) });
    // The put landed although its acknowledgement was lost: read back, it is this event.
    expect(first).toEqual({ ok: true, value: { written: true } });
    const retry = await publishEvent(store, { key, data: sealed(event), sameEvent: sameEvent(key, SEALED) });
    expect(retry).toEqual({ ok: true, value: { written: false } });
    expect([...store.data.keys()].filter((k) => k.startsWith("meta/v1/events/"))).toEqual([key]);
  });
});

describe("codec: the mirror of a sealed store", () => {
  const initStore = async () => {
    const store = memoryBlobStore();
    const id = await ensureStoreIdentity(store, () => STORE_ID);
    if (!id.ok) throw new Error(id.finding.message);
    return store;
  };
  const load = async (
    store: ReturnType<typeof memoryBlobStore>,
    mirror: ReturnType<typeof memoryBlobStore>,
  ) => {
    const result = await loadCatalog({ store, mirror, storeId: STORE_ID, now: NOW, policy: SEALED });
    if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
    return result.value;
  };

  test("the mirror holds opened events and records each store file's size; nothing is fetched again", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    const event = offloaded(1);
    expect((await appendEvent(storeEventLog(store, SEALED), event)).ok).toBe(true);
    const first = await load(store, mirror);
    expect(first.copied).toBe(1);
    expect(first.state.projects[event.project]?.head).toBe(event.snapshot);
    expect(mirror.data.get(`events/${event.id}.json`)).toEqual(plainOf(event));
    const transport = (store.data.get(storeEventKey(event.id)) as Uint8Array).length;
    expect(JSON.parse(text(mirror.data.get(MIRROR_FILE_KEY) as Uint8Array)).transport).toEqual({
      [event.id]: transport,
    });
    // The mirror's copy is read plain, with no key.
    const held = await eventAt(mirrorEventLog(mirror), event.id);
    expect(held.ok && held.value).toEqual({ event });
    store.calls.get = 0;
    const again = await load(store, mirror);
    expect(again).toMatchObject({ copied: 0, cached: true });
    expect(store.calls.get).toBe(1); // the identity file only
  });

  test("the digest changes when a transport file changes size, though the opened event is the same", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    const event = offloaded(1);
    await appendEvent(storeEventLog(store, SEALED), event);
    expect((await load(store, mirror)).cached).toBe(false);
    expect((await load(store, mirror)).cached).toBe(true);
    // The same envelope with other spacing: another size on the store, the same opened bytes in the mirror.
    const key = storeEventKey(event.id);
    const envelope = JSON.parse(text(store.data.get(key) as Uint8Array));
    store.data.set(key, bytes(`${JSON.stringify(envelope, null, 1)}\n`));
    const after = await load(store, mirror);
    expect(after).toMatchObject({ copied: 1, cached: false, findings: [] });
    expect(mirror.data.get(`events/${event.id}.json`)).toEqual(plainOf(event));
    expect((await load(store, mirror)).cached).toBe(true);
  });

  test("a plaintext event on a sealed store is left out, and the fold is uncertain", async () => {
    const store = await initStore();
    const mirror = memoryBlobStore();
    const event = offloaded(1);
    await appendEvent(storeEventLog(store), event); // plain
    const read = await load(store, mirror);
    expect(read.findings.map((f) => f.code)).toEqual(["catalog.unsealed-event"]);
    expect(read.uncertain).toEqual([event.id]);
    expect(read.state.projects[event.project]).toBeUndefined();
    expect(mirror.data.has(`events/${event.id}.json`)).toBe(false);
  });
});

// The codec is the one reader of event bytes: no other module turns them into events (Task 11). A module that reads
// an event file itself, or validates parsed JSON as an event, bypasses sealing, and would take a sealed event for an
// absent or damaged one.
describe("codec: no module outside the codec parses event bytes", () => {
  const ROOTS = ["packages", "test"].map((r) => join(import.meta.dir, "../../../..", r));
  const CODEC = join(import.meta.dir, "codec.ts");

  /** The problems one source file has, by the two rules. */
  const offences = (source: string): string[] => {
    const found: string[] = [];
    // 1. An event schema checking JSON parsed from bytes.
    if (/\b\w*EventSchema\s*\.\s*(safeParse|parse)\s*\(\s*JSON\.parse/.test(source))
      found.push("validates JSON.parse output with an event schema");
    // 2. Reading an event file directly and parsing JSON in the same module.
    const readsEventKey =
      /\.get\(\s*`\$\{\s*(STORE|MIRROR)_EVENTS_PREFIX\s*\}/.test(source) ||
      /\.get\(\s*[`"']meta\/v1\/events\//.test(source) ||
      /\.get\(\s*`events\//.test(source);
    if (readsEventKey && /JSON\.parse\s*\(/.test(source))
      found.push("reads an event file and parses JSON itself");
    return found;
  };

  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      if (name === "node_modules" || name.startsWith(".")) return [];
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
    });

  test("the rules catch the readers M1 had", () => {
    const m1 = [
      "const parsed = OffloadedEventSchema.safeParse(JSON.parse(new TextDecoder().decode(got.value)));",
      "const got = await store.get(`$(STORE_EVENTS_PREFIX}$(event}.json`);\nconst v = JSON.parse(text);",
      "const got = await read.mirror.get(`$(MIRROR_EVENTS_PREFIX}$(id}.json`);\nJSON.parse(x)",
    ];
    // Written with "$(" for a template's "${", so the samples stay plain strings.
    for (const sample of m1) expect(offences(sample.replaceAll("$(", "${")).length).toBeGreaterThan(0);
    expect(offences("const read = await eventAt(storeEventLog(blob, policy), id);")).toEqual([]);
  });

  test("every source file outside codec.ts obeys them", () => {
    const bad: string[] = [];
    for (const root of ROOTS)
      for (const file of sources(root)) {
        if (file === CODEC) continue;
        for (const why of offences(readFileSync(file, "utf8")))
          bad.push(`${relative(join(import.meta.dir, "../../../.."), file)}: ${why}`);
      }
    expect(bad).toEqual([]);
  });
});
