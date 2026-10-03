// The BlobStore contract suite (DESIGN.md "Testing": one suite run against every store). Each implementation's tests
// call blobStoreContract with a factory; the suite covers what the catalog relies on: whole-value put and get,
// create-only writes that refuse an existing key (exactly one winner among racing writers), sorted prefix listing
// and idempotent delete.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BlobStore } from "../ports/blob-store.ts";

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

    test("a key with empty, . or .. segments, or a leading /, is a bug and throws", async () => {
      for (const key of ["", "/abs", "a//b", "a/../b", "..", "./a", "a/", "a\0b"]) {
        expect(() => store.get(key)).toThrow(RangeError);
        expect(() => store.put(key, bytes("x"))).toThrow(RangeError);
      }
      expect(() => store.list("../")).toThrow(RangeError);
    });
  });
};
