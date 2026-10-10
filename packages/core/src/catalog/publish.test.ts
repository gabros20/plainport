import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { BlobStore, StoreSemantics } from "../ports/blob-store.ts";
import { memoryBlobStore } from "../testing/memory-blob-store.ts";
import { semanticBlobStore } from "../testing/semantic-blob-store.ts";
import { ulid } from "../ulid.ts";
import {
  type Election,
  type ElectionOutcome,
  elect,
  publishEvent,
  sameBytes,
  sweepTemporaries,
  TEMP_PREFIX,
} from "./publish.ts";

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const decode = (data: Uint8Array): string => new TextDecoder().decode(data);

const OP = "01J00000000000000000000OP1";
const EVENT_KEY = "meta/v1/events/01J0000000000000000000EV01.json";

const keysOf = (store: { data: Map<string, Uint8Array> }, prefix = ""): string[] =>
  [...store.data.keys()].filter((key) => key.startsWith(prefix)).sort();

describe("publish: an event is published whole", () => {
  test("an atomic-put store puts the key directly; the same event again is a no-op", async () => {
    const store = semanticBlobStore();
    expect(
      await publishEvent(store, { key: EVENT_KEY, data: bytes("e1"), op: OP, sameEvent: sameBytes }),
    ).toEqual({ ok: true, value: { written: true } });
    expect(
      await publishEvent(store, { key: EVENT_KEY, data: bytes("e1"), op: OP, sameEvent: sameBytes }),
    ).toEqual({ ok: true, value: { written: false } });
    expect(keysOf(store)).toEqual([EVENT_KEY]);
    expect(store.calls.put).toBe(1);
  });

  test("another event under the key is refused with store.key-exists and left as it was", async () => {
    const store = semanticBlobStore();
    await publishEvent(store, { key: EVENT_KEY, data: bytes("e1"), op: OP, sameEvent: sameBytes });
    const other = await publishEvent(store, {
      key: EVENT_KEY,
      data: bytes("e2"),
      op: OP,
      sameEvent: sameBytes,
    });
    expect(other).toMatchObject({ ok: false, finding: { code: "store.key-exists" } });
    expect(decode(store.data.get(EVENT_KEY) as Uint8Array)).toBe("e1");
  });

  test("the comparison is the injected SameEvent, not the bytes (R2-8)", async () => {
    const store = semanticBlobStore();
    await publishEvent(store, { key: EVENT_KEY, data: bytes("sealed-1"), op: OP, sameEvent: sameBytes });
    const opened = (data: Uint8Array) => decode(data).split("-")[0];
    const again = await publishEvent(store, {
      key: EVENT_KEY,
      data: bytes("sealed-2"),
      op: OP,
      sameEvent: (existing, intended) => opened(existing) === opened(intended),
    });
    expect(again).toEqual({ ok: true, value: { written: false } });
    expect(decode(store.data.get(EVENT_KEY) as Uint8Array)).toBe("sealed-1");
  });

  test("a store that cannot publish whole refuses with store.semantics-unknown and writes nothing", async () => {
    const store = semanticBlobStore({ tornWrites: true });
    const refused = await publishEvent(store, {
      key: EVENT_KEY,
      data: bytes("e1"),
      op: OP,
      sameEvent: sameBytes,
    });
    expect(refused).toMatchObject({ ok: false, finding: { code: "store.semantics-unknown" } });
    if (!refused.ok) expect(refused.finding.message).toContain("publication");
    expect(store.calls.put).toBe(0);
  });

  test("a temp-then-rename store uploads to meta/v1/tmp/<op>-<nonce> and renames; no torn key is ever visible under events/", async () => {
    const store = semanticBlobStore({ tornWrites: true, rename: true });
    const data = bytes("x".repeat(4096));
    const seen: string[] = [];
    let done = false;
    const observer = (async () => {
      while (!done) {
        const listed = await store.list("meta/v1/");
        if (listed.ok) for (const { key } of listed.value) seen.push(key);
        const got = await store.get(EVENT_KEY);
        if (got.ok && got.value !== null && got.value.length !== data.length) seen.push("TORN");
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();
    const published = await publishEvent(store, { key: EVENT_KEY, data, op: OP, sameEvent: sameBytes });
    done = true;
    await observer;
    expect(published).toEqual({ ok: true, value: { written: true } });
    expect(seen).not.toContain("TORN");
    expect(seen.some((key) => key.startsWith(`${TEMP_PREFIX}${OP}-`))).toBe(true);
    expect(keysOf(store, "meta/v1/")).toEqual([EVENT_KEY]);
  });

  for (const profile of ["atomic-put", "temp-then-rename"] as const) {
    test(`${profile}: a lost acknowledgement followed by a retry gives one event, not two`, async () => {
      const store = semanticBlobStore(profile === "atomic-put" ? {} : { tornWrites: true, rename: true });
      store.loseAckNext(profile === "atomic-put" ? "put" : "rename");
      const input = { key: EVENT_KEY, data: bytes("e1"), op: OP, sameEvent: sameBytes };
      const first = await publishEvent(store, input);
      // The publisher reads the key after a failed write: the event is there, so it is published.
      expect(first).toEqual({ ok: true, value: { written: true } });
      const retry = await publishEvent(store, input);
      expect(retry).toEqual({ ok: true, value: { written: false } });
      expect(keysOf(store, "meta/v1/events/")).toEqual([EVENT_KEY]);
    });
  }

  test("a lost acknowledgement whose read-back also fails is retried by reading first: one event", async () => {
    const store = semanticBlobStore();
    store.loseAckNext("put");
    store.failNext("get");
    store.failNext("get");
    const input = { key: EVENT_KEY, data: bytes("e1"), op: OP, sameEvent: sameBytes };
    expect(await publishEvent(store, input)).toMatchObject({ ok: false });
    expect(await publishEvent(store, input)).toEqual({ ok: true, value: { written: false } });
    expect(store.calls.put).toBe(1);
    expect(keysOf(store, "meta/v1/events/")).toEqual([EVENT_KEY]);
  });

  test("may-land-late: a cancelled put counts as possibly landed, and lands later", async () => {
    const store = semanticBlobStore({ lateLanding: true });
    store.cancelNext();
    const input = { key: EVENT_KEY, data: bytes("e1"), op: OP, sameEvent: sameBytes };
    const cancelled = await publishEvent(store, input);
    expect(cancelled).toMatchObject({ ok: false, mayLand: true, finding: { code: "process.cancelled" } });
    store.settle();
    expect(await publishEvent(store, input)).toEqual({ ok: true, value: { written: false } });
  });

  test("never-lands-late: a cancelled put that is not there afterwards never lands", async () => {
    const store = semanticBlobStore();
    store.cancelNext();
    const cancelled = await publishEvent(store, {
      key: EVENT_KEY,
      data: bytes("e1"),
      op: OP,
      sameEvent: sameBytes,
    });
    expect(cancelled).toMatchObject({ ok: false, mayLand: false });
  });

  test("temporaries are swept only by their own operation's recovery", async () => {
    const store = memoryBlobStore();
    const other = "01J00000000000000000000OP2";
    for (const key of [`${TEMP_PREFIX}${OP}-a1`, `${TEMP_PREFIX}${OP}-b2`, `${TEMP_PREFIX}${other}-c3`]) {
      await store.put(key, bytes("t"));
    }
    expect(await sweepTemporaries(store, OP)).toEqual({
      ok: true,
      value: { removed: [`${TEMP_PREFIX}${OP}-a1`, `${TEMP_PREFIX}${OP}-b2`] },
    });
    expect(keysOf(store)).toEqual([`${TEMP_PREFIX}${other}-c3`]);
  });
});

// --- The elected publication -------------------------------------------------------------------------------------

const PUBLISHED = "meta/v1/store.json";
const CANDIDATES = "meta/v1/candidates/";

const election = (id: string, overrides: Partial<Election> = {}): Election => ({
  key: PUBLISHED,
  candidates: CANDIDATES,
  id,
  op: id,
  value: bytes(`${JSON.stringify({ v: 1, winner: id })}\n`),
  winnerOf: (data) => {
    try {
      const parsed = JSON.parse(decode(data)) as { winner?: unknown };
      return typeof parsed.winner === "string" ? parsed.winner : undefined;
    } catch {
      return undefined;
    }
  },
  wait: () => Promise.resolve(),
  ...overrides,
});

const NO_CREATE = { conditionalCreate: false } as const;

const outcome = async (store: BlobStore, e: Election): Promise<ElectionOutcome> => {
  const result = await elect(store, e);
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

describe("publish: the elected publication", () => {
  for (const [route, options] of [
    ["conditional create", {}],
    ["sole candidate", NO_CREATE],
  ] as const) {
    test(`${route}: a single claimant wins, and a later one loses naming the winner`, async () => {
      const store = semanticBlobStore(options);
      expect(await outcome(store, election("A"))).toEqual({ outcome: "won" });
      expect(await outcome(store, election("A"))).toEqual({ outcome: "won" });
      expect(await outcome(store, election("B"))).toEqual({ outcome: "lost", winner: "A" });
      expect(decode(store.data.get(PUBLISHED) as Uint8Array)).toContain('"winner":"A"');
    });

    test(`${route}: a lost acknowledgement of the publication is still a win on retry`, async () => {
      const store = semanticBlobStore(options);
      store.loseAckNext("put", route === "conditional create" ? 1 : 2);
      const first = await elect(store, election("A"));
      const again = first.ok ? first : await elect(store, election("A"));
      expect(again).toEqual({ ok: true, value: { outcome: "won" } });
    });
  }

  test("the conditional route writes no candidate", async () => {
    const store = semanticBlobStore();
    await outcome(store, election("A"));
    expect(keysOf(store, CANDIDATES)).toEqual([]);
  });

  test("the fallback refuses on a profile that fails elect, and writes nothing", async () => {
    for (const weakness of [
      { listOmitsRecent: true },
      { delayedVisibility: true },
      { truncateListAt: 100 },
    ] as const) {
      const store = semanticBlobStore({ ...NO_CREATE, ...weakness });
      const refused = await elect(store, election("A"));
      expect(refused).toMatchObject({ ok: false, finding: { code: "store.semantics-unknown" } });
      expect(store.calls.put).toBe(0);
    }
  });

  test("an unknown conditional create alone routes to the fallback", async () => {
    const strong = semanticBlobStore(NO_CREATE).semantics();
    const profile: StoreSemantics = { ...strong, conditionalCreate: "unknown" };
    const store = semanticBlobStore({ ...NO_CREATE, profile });
    expect(await outcome(store, election("A"))).toEqual({ outcome: "won" });
    expect(keysOf(store, CANDIDATES)).toEqual([`${CANDIDATES}A.json`]);
  });

  test("when every candidate is visible before any listing, all end contested and nothing is published", async () => {
    for (const n of [2, 3]) {
      const inner = semanticBlobStore(NO_CREATE);
      const ids = Array.from({ length: n }, (_, i) => `C${i}`);
      // Hold every listing until every candidate is written.
      let written = 0;
      let open: () => void = () => {};
      const allWritten = new Promise<void>((resolve) => {
        open = resolve;
      });
      const gated: BlobStore = {
        ...inner,
        put: async (key, data, opts) => {
          const put = await inner.put(key, data, opts);
          if (key.startsWith(CANDIDATES) && ++written === n) open();
          return put;
        },
        list: async (prefix) => {
          await allWritten;
          return inner.list(prefix);
        },
      };
      const outcomes = await Promise.all(ids.map((id) => outcome(gated, election(id))));
      for (const o of outcomes) {
        expect(o).toMatchObject({ outcome: "contested", candidates: ids });
        if (o.outcome === "contested") {
          expect(o.fix).toContain("every device");
          expect(o.fix).toContain(`${CANDIDATES}C0.json`);
        }
      }
      expect(inner.data.has(PUBLISHED)).toBe(false);
    }
  });

  test("after a contested run, the quiesced cleanup lets a single retry win", async () => {
    const store = semanticBlobStore(NO_CREATE);
    await store.put(`${CANDIDATES}B.json`, bytes("{}"));
    expect(await outcome(store, election("A"))).toMatchObject({ outcome: "contested" });
    for (const key of keysOf(store, CANDIDATES)) await store.delete(key);
    expect(await outcome(store, election("A"))).toEqual({ outcome: "won" });
  });

  test("a contested claimant that sees a winner published while it re-reads loses, naming it", async () => {
    const store = semanticBlobStore(NO_CREATE);
    await store.put(`${CANDIDATES}A.json`, bytes("{}"));
    let waits = 0;
    const b = election("B", {
      wait: async () => {
        if (++waits === 1) await store.put(PUBLISHED, election("A").value);
      },
    });
    expect(await outcome(store, b)).toEqual({ outcome: "lost", winner: "A" });
  });

  /** A store whose every call runs when the fast-check scheduler says. */
  const scheduled = (inner: BlobStore, s: fc.Scheduler): BlobStore => ({
    ...inner,
    get: s.scheduleFunction(inner.get.bind(inner)),
    put: s.scheduleFunction(inner.put.bind(inner)),
    list: s.scheduleFunction(inner.list.bind(inner)),
    stat: s.scheduleFunction(inner.stat.bind(inner)),
    delete: s.scheduleFunction(inner.delete.bind(inner)),
  });

  for (const [route, options] of [
    ["conditional create", {}],
    ["sole candidate", NO_CREATE],
  ] as const) {
    for (const n of [2, 3]) {
      test(`${route}: every interleaving of ${n} claimants ends with at most one won`, async () => {
        await fc.assert(
          fc.asyncProperty(fc.scheduler(), fc.boolean(), async (s, lossy) => {
            const inner = semanticBlobStore(options);
            if (lossy) inner.loseAckNext("put");
            const store = scheduled(inner, s);
            const ids = Array.from({ length: n }, (_, i) => `C${i}`);
            const running = Promise.all(ids.map((id) => elect(store, election(id))));
            await s.waitAll();
            const results = await running;
            const outcomes = results.flatMap((r) => (r.ok ? [r.value] : []));
            const won = ids.filter(
              (_, i) => results[i]?.ok && (results[i] as { value: ElectionOutcome }).value.outcome === "won",
            );
            expect(won.length).toBeLessThanOrEqual(1);
            const published = inner.data.get(PUBLISHED);
            const winner = published === undefined ? undefined : election("x").winnerOf(published);
            if (won.length === 1) expect(winner).toBe(won[0]);
            for (const o of outcomes) {
              if (o.outcome === "lost") expect(o.winner).toBe(winner as string);
              if (o.outcome === "contested") expect(o.candidates.length).toBeGreaterThan(1);
            }
            // A published value always names a claimant, and only one ever is.
            if (winner !== undefined) expect(ids).toContain(winner);
          }),
          { numRuns: 200 },
        );
      });
    }
  }
});
