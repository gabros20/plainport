import { describe, expect, test } from "bun:test";
import { memoryBlobStore } from "../testing/memory-blob-store.ts";
import { ulid } from "../ulid.ts";
import { claimStoreRoot, ROOT_CLAIM_KEY } from "./root-claim.ts";

const text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);
const claimFile = (root: string) => `${JSON.stringify({ v: 1, root })}\n`;

describe("the store's root claim (D50)", () => {
  test("an unclaimed store is claimed for the root, create-only", async () => {
    const store = memoryBlobStore();
    const root = ulid();
    expect(await claimStoreRoot(store, root)).toEqual({ ok: true, value: { root, created: true } });
    expect(text(store.data.get(ROOT_CLAIM_KEY))).toBe(claimFile(root));
  });

  test("a store claimed for the root is left as it is", async () => {
    const store = memoryBlobStore();
    const root = ulid();
    await claimStoreRoot(store, root);
    const puts = store.calls.put;
    expect(await claimStoreRoot(store, root)).toEqual({ ok: true, value: { root, created: false } });
    expect(store.calls.put).toBe(puts);
  });

  test("a store another root claimed names that root, and nothing is written", async () => {
    const store = memoryBlobStore();
    const other = ulid();
    await claimStoreRoot(store, other);
    const puts = store.calls.put;
    expect(await claimStoreRoot(store, ulid())).toEqual({ ok: true, value: { root: other, created: false } });
    expect(store.calls.put).toBe(puts);
  });

  test("of two roots claiming at once, exactly one wins and both see it", async () => {
    const store = memoryBlobStore();
    const [a, b] = [ulid(), ulid()];
    const results = await Promise.all([claimStoreRoot(store, a), claimStoreRoot(store, b)]);
    const roots = results.map((r) => (r.ok ? r.value.root : "failed"));
    expect(new Set(roots).size).toBe(1);
    expect(results.filter((r) => r.ok && r.value.created)).toHaveLength(1);
  });

  /** A linkless store (D41): a create-only put makes the file empty, waits for `gate`, then writes its bytes. */
  const inPlace = () => {
    const store = memoryBlobStore();
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const puts: string[] = [];
    const put = store.put;
    store.put = async (key, data, opts) => {
      puts.push(text(data) ?? "");
      if (!opts?.ifNotExists) return put(key, data, opts);
      const made = await put(key, new Uint8Array(), opts);
      if (!made.ok) return made;
      await gate;
      store.data.set(key, new Uint8Array(data));
      return made;
    };
    return { store, open, puts };
  };

  test("a claim another root is writing is re-read until it is whole, never written over (D51)", async () => {
    const { store, open, puts } = inPlace();
    const [a, b] = [ulid(), ulid()];
    const writing = claimStoreRoot(store, b);
    // A reads only once B's file exists, empty, with B's bytes still to come.
    while (!store.data.has(ROOT_CLAIM_KEY)) await new Promise((done) => setTimeout(done, 1));
    let reads = 0;
    const result = await claimStoreRoot(store, a, {
      wait: async () => {
        reads++;
        if (reads === 2) open();
      },
    });
    expect(result).toEqual({ ok: true, value: { root: b, created: false } });
    expect(await writing).toEqual({ ok: true, value: { root: b, created: true } });
    expect(puts).toEqual([claimFile(b)]);
    expect(text(store.data.get(ROOT_CLAIM_KEY))).toBe(claimFile(b));
  });

  test("a claim still empty or partial after the re-reads is refused and kept; the fix says wait and retry", async () => {
    for (const partial of ["", '{"v":1,"root":"']) {
      const store = memoryBlobStore();
      store.data.set(ROOT_CLAIM_KEY, new TextEncoder().encode(partial));
      let waits = 0;
      const result = await claimStoreRoot(store, ulid(), {
        wait: async () => {
          waits++;
        },
      });
      expect(result.ok ? "" : result.finding.code).toBe("store.failed");
      expect(result.ok ? "" : result.finding.fix).toContain("re-run");
      expect(result.ok ? "" : result.finding.fix).not.toMatch(/write|edit/i);
      expect(waits).toBeGreaterThan(1);
      expect(store.calls.put).toBe(0);
      expect(text(store.data.get(ROOT_CLAIM_KEY))).toBe(partial);
    }
  });

  test("an unreachable store is its own finding", async () => {
    const store = memoryBlobStore();
    store.failNext("get");
    const result = await claimStoreRoot(store, ulid());
    expect(result.ok ? "" : result.finding.code).toBe("store.unreachable");
  });
});
