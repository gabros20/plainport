import { describe, expect, test } from "bun:test";
import { fail, finding, ok } from "@plainport/contract";
import fc from "fast-check";
import { z } from "zod";
import type { BlobStore, StoreSemantics } from "../ports/blob-store.ts";
import { FAKE_TEMP_PREFIX, semanticBlobStore } from "../testing/semantic-blob-store.ts";
import {
  type Election,
  type ElectionOutcome,
  ElectionRecordSchema,
  elect,
  electionJsonSchemas,
  publishEvent,
  sameBytes,
} from "./publish.ts";

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const decode = (data: Uint8Array): string => new TextDecoder().decode(data);

/** fast-check runs per property. */
const RUNS = 300;

const EVENT_KEY = "meta/v1/events/01J0000000000000000000EV01.json";

const keysOf = (store: { data: Map<string, Uint8Array> }, prefix = ""): string[] =>
  [...store.data.keys()].filter((key) => key.startsWith(prefix)).sort();

describe("publish: an event is published whole", () => {
  test("an atomic-put store puts the key directly; the same event again is a no-op", async () => {
    const store = semanticBlobStore();
    expect(await publishEvent(store, { key: EVENT_KEY, data: bytes("e1"), sameEvent: sameBytes })).toEqual({
      ok: true,
      value: { written: true },
    });
    expect(await publishEvent(store, { key: EVENT_KEY, data: bytes("e1"), sameEvent: sameBytes })).toEqual({
      ok: true,
      value: { written: false },
    });
    expect(keysOf(store)).toEqual([EVENT_KEY]);
    expect(store.calls.put).toBe(1);
  });

  test("another event under the key is refused with store.key-exists and left as it was", async () => {
    const store = semanticBlobStore();
    await publishEvent(store, { key: EVENT_KEY, data: bytes("e1"), sameEvent: sameBytes });
    const other = await publishEvent(store, {
      key: EVENT_KEY,
      data: bytes("e2"),
      sameEvent: sameBytes,
    });
    expect(other).toMatchObject({ ok: false, finding: { code: "store.key-exists" } });
    expect(decode(store.data.get(EVENT_KEY) as Uint8Array)).toBe("e1");
  });

  test("the comparison is the injected SameEvent, not the bytes (R2-8)", async () => {
    const store = semanticBlobStore();
    await publishEvent(store, { key: EVENT_KEY, data: bytes("sealed-1"), sameEvent: sameBytes });
    const opened = (data: Uint8Array) => decode(data).split("-")[0];
    const again = await publishEvent(store, {
      key: EVENT_KEY,
      data: bytes("sealed-2"),
      sameEvent: (existing, intended) => ok(opened(existing) === opened(intended)),
    });
    expect(again).toEqual({ ok: true, value: { written: false } });
    expect(decode(store.data.get(EVENT_KEY) as Uint8Array)).toBe("sealed-1");
  });

  test("a failed put whose read-back finds another event is store.key-exists, and cannot land", async () => {
    const store = semanticBlobStore();
    const racing: BlobStore = {
      ...store,
      put: async (key) => {
        await store.put(key, bytes("someone else's"));
        return fail(finding("store.unreachable", { message: "lost" }));
      },
    };
    const result = await publishEvent(racing, { key: EVENT_KEY, data: bytes("e1"), sameEvent: sameBytes });
    expect(result).toMatchObject({ ok: false, mayLand: false, finding: { code: "store.key-exists" } });
  });

  test("a SameEvent that cannot tell (a codec failure) is returned as such, not as store.key-exists", async () => {
    const store = semanticBlobStore();
    await store.put(EVENT_KEY, bytes("sealed with another key"));
    const result = await publishEvent(store, {
      key: EVENT_KEY,
      data: bytes("e1"),
      sameEvent: () => fail(finding("store.failed", { message: "cannot open the existing event" })),
    });
    expect(result).toMatchObject({ ok: false, mayLand: false, finding: { code: "store.failed" } });
  });

  test("a store that cannot publish whole refuses with store.semantics-unknown and writes nothing", async () => {
    const store = semanticBlobStore({ tornWrites: true });
    const refused = await publishEvent(store, {
      key: EVENT_KEY,
      data: bytes("e1"),
      sameEvent: sameBytes,
    });
    expect(refused).toMatchObject({ ok: false, finding: { code: "store.semantics-unknown" } });
    if (!refused.ok) expect(refused.finding.message).toContain("publication");
    expect(store.calls.put).toBe(0);
  });

  test("a temp-then-rename store's put moves its own temporary onto the key: no torn key is ever visible under events/", async () => {
    const store = semanticBlobStore({ tornWrites: true, tempThenRename: true });
    const data = bytes("x".repeat(4096));
    const seen: string[] = [];
    let done = false;
    const observer = (async () => {
      while (!done) {
        const listed = await store.list("");
        if (listed.ok) for (const { key } of listed.value) seen.push(key);
        const got = await store.get(EVENT_KEY);
        if (got.ok && got.value !== null && got.value.length !== data.length) seen.push("TORN");
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();
    const published = await publishEvent(store, { key: EVENT_KEY, data, sameEvent: sameBytes });
    done = true;
    await observer;
    expect(published).toEqual({ ok: true, value: { written: true } });
    expect(seen).not.toContain("TORN");
    expect(seen.some((key) => key.startsWith(FAKE_TEMP_PREFIX))).toBe(true);
    expect(keysOf(store)).toEqual([EVENT_KEY]);
  });

  for (const profile of ["atomic-put", "temp-then-rename"] as const) {
    test(`${profile}: a lost acknowledgement followed by a retry gives one event, not two`, async () => {
      const store = semanticBlobStore(
        profile === "atomic-put" ? {} : { tornWrites: true, tempThenRename: true },
      );
      store.loseAckNext();
      const input = { key: EVENT_KEY, data: bytes("e1"), sameEvent: sameBytes };
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
    store.loseAckNext();
    // The read after the failed put fails too: the publisher cannot tell, so the write may have landed.
    const flaky: BlobStore = {
      ...store,
      put: async (key, data, opts) => {
        const put = await store.put(key, data, opts);
        store.failNext("get");
        return put;
      },
    };
    const input = { key: EVENT_KEY, data: bytes("e1"), sameEvent: sameBytes };
    expect(await publishEvent(flaky, input)).toMatchObject({ ok: false, mayLand: true });
    expect(await publishEvent(store, input)).toEqual({ ok: true, value: { written: false } });
    expect(store.calls.put).toBe(1);
    expect(keysOf(store, "meta/v1/events/")).toEqual([EVENT_KEY]);
  });

  test("may-land-late: a cancelled put counts as possibly landed, and lands later", async () => {
    const store = semanticBlobStore({ lateLanding: true });
    store.cancelNext();
    const input = { key: EVENT_KEY, data: bytes("e1"), sameEvent: sameBytes };
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
      sameEvent: sameBytes,
    });
    expect(cancelled).toMatchObject({ ok: false, mayLand: false });
  });
});

// --- The elected publication -------------------------------------------------------------------------------------

const PUBLISHED = "meta/v1/store.json";
const CANDIDATES = "meta/v1/candidates/";

const election = (id: string, overrides: Partial<Election> = {}): Election => ({
  key: PUBLISHED,
  candidates: CANDIDATES,
  id,
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
  test("a final contested needs this attempt's own refusal read back (astra r2)", async () => {
    const store = semanticBlobStore({ ...NO_CREATE, lateLanding: true });
    const failing = (suffix: string, how: "cancel" | "fail"): BlobStore => ({
      ...store,
      put: (key, data, opts) => {
        if (key.endsWith(suffix)) {
          if (how === "cancel") store.cancelNext();
          else store.failNext("put");
        }
        return store.put(key, data, opts);
      },
    });
    // A is sole; its .publishing write is cancelled and stays pending.
    expect((await elect(failing("A.publishing", "cancel"), election("A"))).ok).toBe(false);
    // B joins and refuses; A has decided nothing visible.
    expect(await outcome(store, election("B"))).toMatchObject({ outcome: "contested", undecided: ["A"] });
    // A retries before its .publishing lands, and its .refused write fails without landing.
    const retry = await elect(failing("A.refused", "fail"), election("A"));
    if (retry.ok) expect(retry.value).not.toMatchObject({ outcome: "contested", undecided: [] });
    // The pending .publishing lands: A was entitled to publish, and does.
    store.settle();
    expect(await outcome(store, election("A"))).toEqual({ outcome: "won" });
    expect(await outcome(store, election("B"))).toEqual({ outcome: "lost", winner: "A" });
  });

  test("candidate and decision records are schema-checked: a marker that does not validate counts for nothing", async () => {
    const store = semanticBlobStore(NO_CREATE);
    await store.put(`${CANDIDATES}B.json`, bytes('{"v":1,"id":"B","decision":"candidate"}'));
    // B's "refusal" names another attempt: it is not B's refusal, so B stays undecided.
    await store.put(`${CANDIDATES}B.refused`, bytes('{"v":1,"id":"X","decision":"refused"}'));
    expect(await outcome(store, election("A"))).toMatchObject({ outcome: "contested", undecided: ["B"] });
    await store.put(`${CANDIDATES}B.refused`, bytes('{"v":1,"id":"B","decision":"refused"}\n'));
    expect(await outcome(store, election("A"))).toMatchObject({ outcome: "contested", undecided: [] });
    for (const key of keysOf(store, CANDIDATES)) {
      expect(
        ElectionRecordSchema.safeParse(JSON.parse(decode(store.data.get(key) as Uint8Array))).success,
      ).toBe(true);
    }
  });

  test("the election records are published as JSON Schema", () => {
    expect(electionJsonSchemas()).toEqual({
      "election-record": z.toJSONSchema(ElectionRecordSchema, {
        target: "draft-2020-12",
        io: "input",
      }) as Record<string, unknown>,
    });
  });

  test("without read-after-write, a publication not yet visible is no broken promise: re-run after it shows", async () => {
    const store = semanticBlobStore({ delayedVisibility: true });
    const first = await elect(store, election("A"));
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.finding.message).not.toContain("promises");
    store.settle();
    expect(await outcome(store, election("A"))).toEqual({ outcome: "won" });
  });

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
      store.loseAckNext(route === "conditional create" ? 1 : 3);
      const first = await elect(store, election("A"));
      const again = first.ok ? first : await elect(store, election("A"));
      expect(again).toEqual({ ok: true, value: { outcome: "won" } });
    });
  }

  test("every route writes the candidacy: one protocol whatever this device's profile (quality r1)", async () => {
    const store = semanticBlobStore();
    await outcome(store, election("A"));
    expect(keysOf(store, CANDIDATES)).toEqual([`${CANDIDATES}A.json`, `${CANDIDATES}A.publishing`]);
  });

  test("a crash after the candidacy, then a re-run with the same id, reaches a final outcome", async () => {
    const store = semanticBlobStore(NO_CREATE);
    // A writes its candidacy and dies before it lists.
    let crashed = false;
    const dying: BlobStore = {
      ...store,
      list: async () => {
        crashed = true;
        throw new Error("killed");
      },
    };
    await expect(elect(dying, election("A"))).rejects.toThrow("killed");
    expect(crashed).toBe(true);
    // B sees A undecided: not final, and its fix says how to get out.
    const b = await outcome(store, election("B"));
    expect(b).toMatchObject({ outcome: "contested", undecided: ["A"] });
    if (b.outcome === "contested") {
      expect(b.fix).toContain("same id");
      expect(b.fix).toContain("every device");
    }
    // A's recovery re-runs with the journaled id: it sees B, refuses, and the election is final.
    expect(await outcome(store, election("A"))).toMatchObject({ outcome: "contested", undecided: [] });
    expect(await outcome(store, election("B"))).toMatchObject({ outcome: "contested", undecided: [] });
  });

  test("a refusal written on behalf of an attempt whose device is gone settles the election (the withdraw rule)", async () => {
    const store = semanticBlobStore(NO_CREATE);
    await store.put(`${CANDIDATES}GONE.json`, bytes('{"v":1,"id":"GONE","decision":"candidate"}'));
    expect(await outcome(store, election("B"))).toMatchObject({ outcome: "contested", undecided: ["GONE"] });
    // Every device quiesced, the operator withdraws GONE: its refusal record, exactly as GONE would write it.
    await store.put(`${CANDIDATES}GONE.refused`, bytes('{"v":1,"id":"GONE","decision":"refused"}\n'));
    expect(await outcome(store, election("B"))).toMatchObject({ outcome: "contested", undecided: [] });
  });

  test("elect() checks its input: a bad prefix, id or value is a bug and throws", async () => {
    const store = semanticBlobStore();
    await expect(elect(store, election("A", { candidates: "meta/v1/candidates" }))).rejects.toThrow(
      RangeError,
    );
    await expect(elect(store, election("A", { key: `${CANDIDATES}x` }))).rejects.toThrow(RangeError);
    await expect(elect(store, election("a/b"))).rejects.toThrow(RangeError);
    await expect(elect(store, election("x.refused"))).rejects.toThrow(RangeError);
    await expect(elect(store, election("A", { value: election("B").value }))).rejects.toThrow(RangeError);
    expect(store.calls.put).toBe(0);
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

  test("elect() requires exactly what canElect requires: a proven conditional create needs no visibility", async () => {
    const strong = semanticBlobStore().semantics();
    const profile: StoreSemantics = { ...strong, readAfterWrite: "unknown", listComplete: "unknown" };
    const store = semanticBlobStore({ profile });
    expect(await outcome(store, election("A"))).toEqual({ outcome: "won" });
  });

  test("an unknown conditional create alone routes to the fallback", async () => {
    const strong = semanticBlobStore(NO_CREATE).semantics();
    const profile: StoreSemantics = { ...strong, conditionalCreate: "unknown" };
    const store = semanticBlobStore({ ...NO_CREATE, profile });
    expect(await outcome(store, election("A"))).toEqual({ outcome: "won" });
    expect(keysOf(store, CANDIDATES)).toEqual([`${CANDIDATES}A.json`, `${CANDIDATES}A.publishing`]);
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

  test("a sole candidate that pauses before publishing never makes another's contested terminal (astra r1)", async () => {
    const store = semanticBlobStore(NO_CREATE);
    let blocked: () => void = () => {};
    const aBlocked = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    let release: () => void = () => {};
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A lists itself as the sole candidate, then pauses before its next write.
    let listed = false;
    const paused: BlobStore = {
      ...store,
      list: async (prefix) => {
        const result = await store.list(prefix);
        listed = true;
        return result;
      },
      put: async (key, data, opts) => {
        if (listed) {
          blocked();
          await resume;
        }
        return store.put(key, data, opts);
      },
    };
    const a = elect(paused, election("A"));
    await aBlocked;
    // B sees A, exhausts its reads, and returns.
    const b = await outcome(store, election("B"));
    release();
    expect(await a).toEqual({ ok: true, value: { outcome: "won" } });
    // B must not have reported "no winner, every visible candidate refuses": A was entitled to publish.
    expect(b).toMatchObject({ outcome: "contested", undecided: ["A"] });
    expect(await outcome(store, election("B"))).toEqual({ outcome: "lost", winner: "A" });
  });

  test("a terminal contested names no undecided candidate, and its fix is the quiesced cleanup", async () => {
    const store = semanticBlobStore(NO_CREATE);
    await store.put(`${CANDIDATES}B.json`, bytes('{"v":1,"id":"B","decision":"candidate"}'));
    await store.put(`${CANDIDATES}B.refused`, bytes('{"v":1,"id":"B","decision":"refused"}'));
    const o = await outcome(store, election("A"));
    expect(o).toMatchObject({ outcome: "contested", candidates: ["A", "B"], undecided: [] });
    if (o.outcome === "contested") expect(o.fix).toContain("every device");
    // A refused for good: re-running the same attempt never publishes.
    await store.delete(`${CANDIDATES}B.json`);
    await store.delete(`${CANDIDATES}B.refused`);
    expect(await outcome(store, election("A"))).toMatchObject({ outcome: "contested", undecided: [] });
    expect(store.data.has(PUBLISHED)).toBe(false);
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
            if (lossy) inner.loseAckNext();
            const store = scheduled(inner, s);
            const ids = Array.from({ length: n }, (_, i) => `C${i}`);
            const running = Promise.all(ids.map((id) => elect(store, election(id))));
            const results = await s.waitFor(running);
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
              if (o.outcome === "contested") {
                expect(o.candidates.length).toBeGreaterThan(1);
                // A terminal contested ("every visible candidate refuses") is never wrong: nobody won.
                if (o.undecided.length === 0) expect(won).toEqual([]);
              }
            }
            // A published value always names a claimant, and only one ever is.
            if (winner !== undefined) expect(ids).toContain(winner);
          }),
          { numRuns: RUNS },
        );
      });
    }
  }

  for (const [route, options] of [
    ["conditional create", {}],
    ["sole candidate", NO_CREATE],
  ] as const) {
    test(`${route}: a cancelled write that lands late never makes a second winner or a wrong final contested`, async () => {
      await fc.assert(
        fc.asyncProperty(fc.scheduler(), fc.nat(8), fc.nat(8), async (s, cancelAt, failAt) => {
          const inner = semanticBlobStore({ ...options, lateLanding: true });
          // Cancel one put (it may land late) and fail another (it never lands): candidacies, markers, publications.
          let puts = 0;
          const faulty: BlobStore = {
            ...inner,
            put: (key, data, opts) => {
              const n = puts++;
              if (n === cancelAt) inner.cancelNext();
              else if (n === failAt) inner.failNext("put");
              return inner.put(key, data, opts);
            },
          };
          const store = scheduled(faulty, s);
          const ids = ["C0", "C1"];
          const settling = s.schedule(Promise.resolve()).then(() => inner.settle());
          const first = await s.waitFor(Promise.all(ids.map((id) => elect(store, election(id)))));
          // Retries before the late write lands (astra r2), then after everything has landed (recovery).
          const early = await s.waitFor(Promise.all(ids.map((id) => elect(store, election(id)))));
          await s.waitFor(settling);
          inner.settle();
          const again = await Promise.all(ids.map((id) => elect(inner, election(id))));
          const won = new Set<string>();
          let final = false;
          for (const results of [first, early, again]) {
            results.forEach((r, i) => {
              if (r.ok && r.value.outcome === "won") won.add(ids[i] as string);
              if (r.ok && r.value.outcome === "contested" && r.value.undecided.length === 0) final = true;
            });
          }
          expect(won.size).toBeLessThanOrEqual(1);
          // A final contested is never wrong: nobody wins, then or later.
          if (final) expect([...won]).toEqual([]);
          const published = inner.data.get(PUBLISHED);
          if (won.size === 1) expect(election("x").winnerOf(published as Uint8Array)).toBe([...won][0]);
          for (const r of again) {
            if (r.ok && r.value.outcome === "lost") expect([...won]).toEqual([r.value.winner]);
          }
        }),
        { numRuns: RUNS },
      );
    });
  }

  for (const n of [2, 3]) {
    test(`mixed routes: ${n} devices with different profiles for one store never both win (quality r1)`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.scheduler(),
          fc.array(fc.boolean(), { minLength: n, maxLength: n }),
          async (s, proven) => {
            const inner = semanticBlobStore();
            // A device that has not measured conditional create sees the same store without it.
            const unmeasured: BlobStore = {
              ...inner,
              semantics: () => ({ ...inner.semantics(), conditionalCreate: "unknown" }),
              capabilities: () => ({ createIfAbsent: false, replaceIfMatch: false }),
            };
            const ids = Array.from({ length: n }, (_, i) => `C${i}`);
            const results = await s.waitFor(
              Promise.all(
                ids.map((id, i) => elect(scheduled(proven[i] ? inner : unmeasured, s), election(id))),
              ),
            );
            const won = ids.filter((_, i) => {
              const r = results[i];
              return r?.ok === true && r.value.outcome === "won";
            });
            expect(won.length).toBeLessThanOrEqual(1);
            const published = inner.data.get(PUBLISHED);
            if (won.length === 1) expect(election("x").winnerOf(published as Uint8Array)).toBe(won[0]);
            for (const r of results) {
              if (r.ok && r.value.outcome === "lost") {
                expect(r.value.winner).toBe(election("x").winnerOf(published as Uint8Array) as string);
              }
            }
          },
        ),
        { numRuns: RUNS },
      );
    });
  }
});
