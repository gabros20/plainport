// The BlobStore contract suite (DESIGN.md "Testing": one suite run against every store). Each implementation's tests
// call blobStoreContract with a factory; the suite covers what the catalog relies on: whole-value put and get,
// create-only writes that refuse an existing key (exactly one winner among racing writers), sorted prefix listing
// and idempotent delete. Its semantic cases (DESIGN.md "Remote stores: consistency and publication") check that what
// a store's semantics() claims holds when probed, and that each operation's predicate gives what the backend expects
// (every one for the local stores; release only with Q21's post-grace proof for an acked-unsynced store).
//
// The suite is driven by the store's own profile: create-only cases run only where conditional create is claimed, and
// a read or listing right after a write is asserted at once only where read-after-write or list-after-write is
// claimed. Otherwise the suite waits for visibility: the fixture's settle() when it has one (the fakes), else
// polling within a bound.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type BlobEntry,
  type BlobStore,
  capabilitiesOf,
  eligibility,
  type SemanticProperty,
  STORE_OPERATIONS,
  type StoreOperation,
  StoreSemanticsSchema,
  semanticValue,
} from "../ports/blob-store.ts";

export interface BlobStoreFixture {
  store: BlobStore;
  cleanup(): void | Promise<void>;
  /** Makes everything the store will still show on its own visible now (a fake's settle). */
  settle?(): void;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array | null): string | null =>
  data === null ? null : new TextDecoder().decode(data);

/** The value of an expected result; a failure (an I/O error) is an error of the test, never a counterexample. */
const value = <T>(
  result: { ok: true; value: T } | { ok: false; finding: { code: string; message: string } },
): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

/** How long a store without immediate visibility is given to show a write: `tries` reads, `ms` apart. */
export interface PollBound {
  tries: number;
  ms: number;
}
const POLL: PollBound = { tries: 100, ms: 20 };

/**
 * Reads until `done` holds: once where the profile promises immediate visibility (`immediate`), else after the
 * fixture's settle() or by polling within the bound. Returns the last read, and whether `done` held.
 */
const visible = async <T>(
  immediate: boolean,
  read: () => Promise<T>,
  done: (seen: T) => boolean,
  settle?: () => void,
  bound: PollBound = POLL,
): Promise<{ seen: T; shown: boolean }> => {
  if (immediate) {
    const seen = await read();
    return { seen, shown: done(seen) };
  }
  settle?.();
  let seen = await read();
  for (let tries = 1; !done(seen) && tries < bound.tries; tries++) {
    await new Promise((resolve) => setTimeout(resolve, bound.ms));
    settle?.();
    seen = await read();
  }
  return { seen, shown: done(seen) };
};

/** A probe that could not decide: the write did not show within the bound, which disproves nothing. */
const inconclusive = (what: string, bound: PollBound): Error =>
  new Error(
    `inconclusive visibility: ${what} did not show within ${bound.tries * bound.ms} ms, so nothing is proven either way`,
  );

/** Faults only a fake (or a measuring harness) can cause; with them the probe also checks cancellation. */
export interface SemanticFaults {
  /** The next put is cancelled: it fails, and lands later or never, as the store does. */
  cancelNext?(): void;
  /** Whatever the store will still do on its own happens now (visibility, late landings). */
  settle?(): void;
}

/** Keys the listing probe writes by default: more than one page of the usual 1000-key listing. */
const LIST_PROBE_KEYS = 1001;

export interface SemanticProbeOptions {
  /** Keys the listing probe writes; a small volume (the exFAT image) passes fewer. */
  listProbeKeys?: number;
  /** How long a write is given to show where the profile does not promise it at once. */
  poll?: PollBound;
}

/**
 * What a backend's profile should give each operation: eligible outright, eligible only with Q21's post-grace proof
 * (release on an acked-unsynced store), or refused.
 */
export type Expected = "eligible" | "post-grace-proof" | "refused";

export const ALL_ELIGIBLE: Readonly<Record<StoreOperation, Expected>> = Object.freeze({
  read: "eligible",
  append: "eligible",
  elect: "eligible",
  commit: "eligible",
  release: "eligible",
});

export interface ContractOptions extends SemanticProbeOptions {
  /** Per operation, what this backend's profile gives. */
  eligibility: Readonly<Record<StoreOperation, Expected>>;
}

const PUBLICATION_PROBE_BYTES = 256 * 1024;

/**
 * The properties a store's semantics() claims that a probe contradicts, under a fresh `probe/` prefix. A property
 * the store does not claim is not probed, and durability cannot be probed without a power cut. An I/O failure is
 * thrown as an error, never reported as a counterexample. Every key the probe issued is deleted afterwards, by name,
 * whatever the listing shows.
 */
export const semanticViolations = async (
  store: BlobStore,
  faults?: SemanticFaults,
  options: SemanticProbeOptions = {},
): Promise<SemanticProperty[]> => {
  const claims = store.semantics();
  const raw = semanticValue(claims.readAfterWrite) === true;
  const law = semanticValue(claims.listAfterWrite) === true;
  const base = `probe/semantics-${crypto.randomUUID()}/`;
  const violations: SemanticProperty[] = [];
  const issued = new Set<string>();
  const put = async (key: string, data: Uint8Array): Promise<void> => {
    issued.add(key);
    value(await store.put(key, data));
  };
  const get = async (key: string): Promise<Uint8Array | null> => value(await store.get(key));
  const list = async (prefix: string): Promise<BlobEntry[]> => value(await store.list(prefix));
  const settle = () => faults?.settle?.();
  const bound = options.poll ?? POLL;
  let probeFailed = false;

  try {
    if (raw) {
      await put(`${base}raw`, bytes("raw"));
      if (text(await get(`${base}raw`)) !== "raw") violations.push("readAfterWrite");
    }
    if (law) {
      await put(`${base}law/one`, bytes("law"));
      if (!(await list(`${base}law/`)).some((entry) => entry.key === `${base}law/one`))
        violations.push("listAfterWrite");
    }
    if (semanticValue(claims.listComplete) === true) {
      const keys = Array.from(
        { length: options.listProbeKeys ?? LIST_PROBE_KEYS },
        (_, i) => `${base}page/${String(i).padStart(5, "0")}`,
      );
      for (let i = 0; i < keys.length; i += 50) {
        // Every write of the batch settles before a failure is thrown, so cleanup never races a write in flight.
        const settled = await Promise.allSettled(keys.slice(i, i + 50).map((key) => put(key, bytes("p"))));
        const failed = settled.find((result) => result.status === "rejected");
        if (failed !== undefined) throw failed.reason;
      }
      // Completeness is not visibility: without list-after-write, wait for the keys to show first.
      const listed = await visible(
        law,
        () => list(`${base}page/`),
        (seen) => seen.length === keys.length,
        settle,
        bound,
      );
      if (!listed.shown) {
        if (!law) throw inconclusive(`the ${keys.length} listing keys`, bound);
        violations.push("listComplete");
      }
    }
    const publication = semanticValue(claims.publication);
    if (publication === "atomic-put" || publication === "temp-then-rename") {
      // An observer reads the key while it is written: it sees nothing or every byte, never a part. Whether it shows
      // at once is read-after-write's business: without it, the final read waits for the value to show.
      const data = new Uint8Array(PUBLICATION_PROBE_BYTES).fill(7);
      const key = `${base}whole`;
      let done = false;
      let torn = false;
      // The rejection handler is attached as the loop starts: a read that fails during a slow write is held here,
      // never an unhandled rejection.
      const observer = (async () => {
        while (!done) {
          const seen = await get(key);
          if (seen !== null && seen.length !== data.length) torn = true;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      })().then(
        () => undefined,
        (error: unknown) => error ?? new Error("the observer failed"),
      );
      let observed: unknown;
      try {
        await put(key, data);
      } finally {
        // Stopped and joined even when the write fails, so no read loop outlives the probe.
        done = true;
        observed = await observer;
      }
      if (observed !== undefined) throw observed; // the observer's read failed: an error, not a counterexample
      const final = await visible(
        raw,
        () => get(key),
        (seen) => seen !== null,
        settle,
        bound,
      );
      if (!final.shown && !raw) throw inconclusive(`the publication probe ${key}`, bound);
      // Not shown although read-after-write is claimed is that property's failure; torn or short bytes are publication's.
      if (final.seen === null && !violations.includes("readAfterWrite")) violations.push("readAfterWrite");
      if (torn || (final.seen !== null && final.seen.length !== data.length)) violations.push("publication");
    }
    if (semanticValue(claims.conditionalCreate) === true) {
      issued.add(`${base}cc`);
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => store.put(`${base}cc`, bytes(`w${i}`), { ifNotExists: true })),
      );
      for (const result of results) {
        if (!result.ok && result.finding.code !== "store.key-exists") value(result);
      }
      if (results.filter((result) => result.ok).length !== 1) violations.push("conditionalCreate");
    }
    if (faults?.cancelNext !== undefined && semanticValue(claims.cancellation) === "never-lands-late") {
      issued.add(`${base}late`);
      faults.cancelNext();
      const cancelled = await store.put(`${base}late`, bytes("late"));
      const before = await get(`${base}late`);
      settle();
      const after = await get(`${base}late`);
      if (!cancelled.ok && before === null && after !== null) violations.push("cancellation");
    }
  } catch (error) {
    probeFailed = true;
    throw error;
  } finally {
    // Every issued key is deleted by name; a delete that fails is reported once all were tried, unless the probe
    // is already failing with its own error.
    settle();
    const undeleted: string[] = [];
    for (const key of issued) {
      const deleted = await store.delete(key);
      if (!deleted.ok) undeleted.push(`${key} (${deleted.finding.code}: ${deleted.finding.message})`);
    }
    if (undeleted.length > 0 && !probeFailed) {
      // biome-ignore lint/correctness/noUnsafeFinally: a cleanup failure is the probe's error when nothing else failed
      throw new Error(`the probe could not delete what it wrote: ${undeleted.join("; ")}`);
    }
  }
  return violations;
};

export const blobStoreContract = (
  name: string,
  make: () => BlobStoreFixture | Promise<BlobStoreFixture>,
  options: ContractOptions,
): void => {
  describe(`${name}: BlobStore contract`, () => {
    let fixture: BlobStoreFixture;
    let store: BlobStore;
    let raw: boolean;
    let law: boolean;
    let conditional: boolean;
    beforeEach(async () => {
      fixture = await make();
      store = fixture.store;
      const semantics = store.semantics();
      raw = semanticValue(semantics.readAfterWrite) === true;
      law = semanticValue(semantics.listAfterWrite) === true;
      conditional = semanticValue(semantics.conditionalCreate) === true;
    });
    afterEach(async () => {
      await fixture.cleanup();
    });

    /** A read after a write: at once where the profile promises it, else once the write shows. */
    const read = async (key: string, done: (seen: Uint8Array | null) => boolean) =>
      (await visible(raw, async () => value(await store.get(key)), done, fixture.settle)).seen;
    const listed = async (prefix: string, done: (seen: BlobEntry[]) => boolean) =>
      (await visible(law, async () => value(await store.list(prefix)), done, fixture.settle)).seen;

    test("put then get returns the same bytes; a missing key is null", async () => {
      value(await store.put("meta/v1/events/a.json", bytes('{"a":1}\n')));
      expect(text(await read("meta/v1/events/a.json", (seen) => seen !== null))).toBe('{"a":1}\n');
      expect(value(await store.get("meta/v1/events/missing.json"))).toBeNull();
    });

    test("stat reports the size; a missing key is null", async () => {
      value(await store.put("k/one", bytes("12345")));
      await read("k/one", (seen) => seen !== null);
      expect(value(await store.stat("k/one"))).toMatchObject({ size: 5 });
      expect(value(await store.stat("k/two"))).toBeNull();
    });

    test("a plain put replaces the key", async () => {
      value(await store.put("state.json", bytes("old")));
      value(await store.put("state.json", bytes("new")));
      expect(text(await read("state.json", (seen) => text(seen) === "new"))).toBe("new");
    });

    test("create-if-absent is offered exactly when the profile claims conditional create", () => {
      expect(store.capabilities().createIfAbsent).toBe(conditional);
    });

    test("create-only refuses an existing key with store.key-exists and leaves it as it was", async () => {
      if (!conditional) return; // not offered: nothing to check
      value(await store.put("meta/v1/events/x.json", bytes("first"), { ifNotExists: true }));
      const second = await store.put("meta/v1/events/x.json", bytes("second"), { ifNotExists: true });
      expect(second).toMatchObject({ ok: false, finding: { code: "store.key-exists" } });
      expect(text(await read("meta/v1/events/x.json", (seen) => seen !== null))).toBe("first");
    });

    test("of racing create-only writers exactly one wins, and the key holds its bytes", async () => {
      if (!conditional) return; // not offered: nothing to check
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => store.put("race", bytes(`writer ${i}`), { ifNotExists: true })),
      );
      const winners = results.flatMap((result, i) => (result.ok ? [i] : []));
      expect(winners).toHaveLength(1);
      for (const result of results) {
        if (!result.ok) expect(result.finding.code).toBe("store.key-exists");
      }
      expect(text(await read("race", (seen) => seen !== null))).toBe(`writer ${winners[0]}`);
    });

    test("list returns every key under a prefix, sorted, with sizes; nothing else", async () => {
      for (const key of [
        "meta/v1/events/02.json",
        "meta/v1/events/01.json",
        "meta/v1/state.json",
        "meta/v2/x",
      ]) {
        value(await store.put(key, bytes(key)));
      }
      await listed("", (seen) => seen.length === 4);
      expect(value(await store.list("meta/v1/events/"))).toEqual([
        expect.objectContaining({ key: "meta/v1/events/01.json", size: "meta/v1/events/01.json".length }),
        expect.objectContaining({ key: "meta/v1/events/02.json", size: "meta/v1/events/02.json".length }),
      ]);
      expect(value(await store.list("meta/v1/")).map((e) => e.key)).toEqual([
        "meta/v1/events/01.json",
        "meta/v1/events/02.json",
        "meta/v1/state.json",
      ]);
      expect(value(await store.list("")).map((e) => e.key)).toHaveLength(4);
      expect(value(await store.list("meta/v1/ev")).map((e) => e.key)).toHaveLength(2);
      expect(value(await store.list("nothing/here/"))).toEqual([]);
    });

    test("delete removes a key, and deleting a missing key is fine", async () => {
      value(await store.put("a/b", bytes("x")));
      await read("a/b", (seen) => seen !== null);
      value(await store.delete("a/b"));
      expect(await read("a/b", (seen) => seen === null)).toBeNull();
      value(await store.delete("a/b"));
      expect(await listed("a/", (seen) => seen.length === 0)).toEqual([]);
    });

    test("semantics: the profile is well formed and capabilities() derives from it", () => {
      const semantics = store.semantics();
      expect(StoreSemanticsSchema.safeParse(semantics).success).toBe(true);
      expect(store.capabilities()).toEqual(capabilitiesOf(semantics));
    });

    test("semantics: what the profile claims holds when probed", async () => {
      expect(await semanticViolations(store, { settle: fixture.settle }, options)).toEqual([]);
    });

    test("semantics: each operation's predicate gives what this backend expects", () => {
      const semantics = store.semantics();
      for (const op of STORE_OPERATIONS) {
        const expected = options.eligibility[op];
        const plain = eligibility(op, semantics).eligible;
        const proven = eligibility(op, semantics, { postGraceProof: true }).eligible;
        expect({ op, plain, proven }).toEqual({
          op,
          plain: expected === "eligible",
          proven: expected !== "refused",
        });
      }
    });

    test("a key with empty, . or .. segments, or a leading /, is a bug and throws", async () => {
      for (const key of ["", "/abs", "a//b", "a/../b", "..", "./a", "a/", "a\0b"]) {
        expect(() => store.get(key)).toThrow(RangeError);
        expect(() => store.put(key, bytes("x"))).toThrow(RangeError);
      }
      expect(() => store.list("../")).toThrow(RangeError);
    });
  });
};
