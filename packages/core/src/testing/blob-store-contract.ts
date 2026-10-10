// The BlobStore contract suite (DESIGN.md "Testing": one suite run against every store). Each implementation's tests
// call blobStoreContract with a factory; the suite covers what the catalog relies on: whole-value put and get,
// create-only writes that refuse an existing key (exactly one winner among racing writers), sorted prefix listing
// and idempotent delete. Its semantic cases (DESIGN.md "Remote stores: consistency and publication") check that what
// a store's semantics() claims holds when probed, and that the local stores pass every operation's predicate.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type BlobStore,
  canAppend,
  canCommit,
  canElect,
  canRead,
  canRelease,
  capabilitiesOf,
  type SemanticProperty,
  StoreSemanticsSchema,
} from "../ports/blob-store.ts";

export interface BlobStoreFixture {
  store: BlobStore;
  cleanup(): void | Promise<void>;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array | null): string | null =>
  data === null ? null : new TextDecoder().decode(data);

const value = <T>(
  result: { ok: true; value: T } | { ok: false; finding: { code: string; message: string } },
): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

/** Faults only a fake (or a measuring harness) can cause; with them the probe also checks cancellation. */
export interface SemanticFaults {
  /** The next put is cancelled: it fails, and lands later or never, as the store does. */
  cancelNext(): void;
  /** Whatever the store will still do on its own happens now (visibility, late landings). */
  settle(): void;
}

/** Keys the listing probe writes: more than one page of the usual 1000-key listing. */
const LIST_PROBE_KEYS = 1001;
const PUBLICATION_PROBE_BYTES = 256 * 1024;

const known = <T>(property: "unknown" | { value: T }): T | "unknown" =>
  property === "unknown" ? "unknown" : property.value;

/**
 * The properties a store's semantics() claims that a probe contradicts, under a fresh `probe/` prefix it removes
 * afterwards. A property the store does not claim is not probed. Durability cannot be probed without a power cut.
 */
export const semanticViolations = async (
  store: BlobStore,
  faults?: SemanticFaults,
): Promise<SemanticProperty[]> => {
  const claims = store.semantics();
  const base = `probe/semantics-${crypto.randomUUID()}/`;
  const violations: SemanticProperty[] = [];
  const getBytes = async (key: string): Promise<Uint8Array | null | undefined> => {
    const got = await store.get(key);
    return got.ok ? got.value : undefined;
  };

  if (known(claims.readAfterWrite) === true) {
    await store.put(`${base}raw`, bytes("raw"));
    if (text((await getBytes(`${base}raw`)) ?? null) !== "raw") violations.push("readAfterWrite");
  }
  if (known(claims.listAfterWrite) === true) {
    await store.put(`${base}law/one`, bytes("law"));
    const listed = await store.list(`${base}law/`);
    if (!listed.ok || !listed.value.some((entry) => entry.key === `${base}law/one`))
      violations.push("listAfterWrite");
  }
  if (known(claims.listComplete) === true) {
    const keys = Array.from(
      { length: LIST_PROBE_KEYS },
      (_, i) => `${base}page/${String(i).padStart(5, "0")}`,
    );
    for (const key of keys) await store.put(key, bytes("p"));
    faults?.settle();
    const listed = await store.list(`${base}page/`);
    if (!listed.ok || listed.value.length !== keys.length) violations.push("listComplete");
  }
  const publication = known(claims.publication);
  if (publication === "atomic-put" || publication === "temp-then-rename") {
    // An observer reads the key while it is written: it sees nothing or every byte, never a part.
    const data = new Uint8Array(PUBLICATION_PROBE_BYTES).fill(7);
    const key = `${base}whole`;
    let done = false;
    let torn = false;
    const observer = (async () => {
      while (!done) {
        const seen = await getBytes(key);
        if (seen != null && seen.length !== data.length) torn = true;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();
    if (publication === "atomic-put") await store.put(key, data);
    else if (store.rename === undefined) torn = true;
    else {
      await store.put(`${base}whole.tmp`, data);
      await store.rename(`${base}whole.tmp`, key);
    }
    done = true;
    await observer;
    faults?.settle();
    const final = await getBytes(key);
    if (torn || final == null || final.length !== data.length) violations.push("publication");
  }
  if (known(claims.conditionalCreate) === true) {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => store.put(`${base}cc`, bytes(`w${i}`), { ifNotExists: true })),
    );
    if (results.filter((result) => result.ok).length !== 1) violations.push("conditionalCreate");
  }
  if (faults !== undefined && known(claims.cancellation) === "never-lands-late") {
    faults.cancelNext();
    const cancelled = await store.put(`${base}late`, bytes("late"));
    const before = await getBytes(`${base}late`);
    faults.settle();
    const after = await getBytes(`${base}late`);
    if (!cancelled.ok && before === null && after != null) violations.push("cancellation");
  }

  faults?.settle();
  const left = await store.list(base);
  if (left.ok) for (const { key } of left.value) await store.delete(key);
  return violations;
};

export const blobStoreContract = (
  name: string,
  make: () => BlobStoreFixture | Promise<BlobStoreFixture>,
): void => {
  describe(`${name}: BlobStore contract`, () => {
    let fixture: BlobStoreFixture;
    let store: BlobStore;
    beforeEach(async () => {
      fixture = await make();
      store = fixture.store;
    });
    afterEach(async () => {
      await fixture.cleanup();
    });

    test("put then get returns the same bytes; a missing key is null", async () => {
      value(await store.put("meta/v1/events/a.json", bytes('{"a":1}\n')));
      expect(text(value(await store.get("meta/v1/events/a.json")))).toBe('{"a":1}\n');
      expect(value(await store.get("meta/v1/events/missing.json"))).toBeNull();
    });

    test("stat reports the size; a missing key is null", async () => {
      value(await store.put("k/one", bytes("12345")));
      expect(value(await store.stat("k/one"))).toMatchObject({ size: 5 });
      expect(value(await store.stat("k/two"))).toBeNull();
    });

    test("a plain put replaces the key", async () => {
      value(await store.put("state.json", bytes("old")));
      value(await store.put("state.json", bytes("new")));
      expect(text(value(await store.get("state.json")))).toBe("new");
    });

    test("create-only refuses an existing key with store.key-exists and leaves it as it was", async () => {
      expect(store.capabilities().createIfAbsent).toBe(true);
      value(await store.put("meta/v1/events/x.json", bytes("first"), { ifNotExists: true }));
      const second = await store.put("meta/v1/events/x.json", bytes("second"), { ifNotExists: true });
      expect(second).toMatchObject({ ok: false, finding: { code: "store.key-exists" } });
      expect(text(value(await store.get("meta/v1/events/x.json")))).toBe("first");
    });

    test("of racing create-only writers exactly one wins, and the key holds its bytes", async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => store.put("race", bytes(`writer ${i}`), { ifNotExists: true })),
      );
      const winners = results.flatMap((result, i) => (result.ok ? [i] : []));
      expect(winners).toHaveLength(1);
      for (const result of results) {
        if (!result.ok) expect(result.finding.code).toBe("store.key-exists");
      }
      expect(text(value(await store.get("race")))).toBe(`writer ${winners[0]}`);
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
      value(await store.delete("a/b"));
      expect(value(await store.get("a/b"))).toBeNull();
      value(await store.delete("a/b"));
      expect(value(await store.list("a/"))).toEqual([]);
    });

    test("semantics: the profile is well formed and capabilities() derives from it", () => {
      const semantics = store.semantics();
      expect(StoreSemanticsSchema.safeParse(semantics).success).toBe(true);
      expect(store.capabilities()).toEqual(capabilitiesOf(semantics));
    });

    test("semantics: what the profile claims holds when probed", async () => {
      expect(await semanticViolations(store)).toEqual([]);
    });

    test("semantics: the store passes every operation's predicate", () => {
      for (const can of [canRead, canAppend, canElect, canCommit, canRelease]) {
        expect(can(store.semantics())).toEqual({ eligible: true });
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
