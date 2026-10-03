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

  test("a half-written claim of this root is completed; any other bytes are refused and kept", async () => {
    const store = memoryBlobStore();
    const root = ulid();
    store.data.set(ROOT_CLAIM_KEY, new TextEncoder().encode(claimFile(root).slice(0, 20)));
    expect(await claimStoreRoot(store, root)).toEqual({ ok: true, value: { root, created: true } });
    expect(text(store.data.get(ROOT_CLAIM_KEY))).toBe(claimFile(root));

    const other = memoryBlobStore();
    other.data.set(ROOT_CLAIM_KEY, new TextEncoder().encode('{"v":1,"root":"0'));
    const refused = await claimStoreRoot(other, `1${root.slice(1)}`);
    expect(refused.ok ? "" : refused.finding.code).toBe("store.failed");
    expect(text(other.data.get(ROOT_CLAIM_KEY))).toBe('{"v":1,"root":"0');
  });

  test("an unreachable store is its own finding", async () => {
    const store = memoryBlobStore();
    store.failNext("get");
    const result = await claimStoreRoot(store, ulid());
    expect(result.ok ? "" : result.finding.code).toBe("store.unreachable");
  });
});
