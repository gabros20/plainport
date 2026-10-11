import { describe, expect, test } from "bun:test";
import { InjectedFault } from "../ports/host.ts";
import { memoryBlobStore } from "../testing/memory-blob-store.ts";
import { ulid } from "../ulid.ts";
import { claimStoreRoot, ROOT_CLAIM_KEY, ROOT_CLAIMS_PREFIX } from "./root-claim.ts";

const text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);
const claimFile = (root: string) => `${JSON.stringify({ v: 1, root })}\n`;

describe("root-claim: the store's root claim (D50, Q9)", () => {
  test("an unclaimed store is claimed for the root, create-only", async () => {
    const store = memoryBlobStore();
    const root = ulid();
    expect(await claimStoreRoot(store, root)).toEqual({ ok: true, value: { root } });
    expect(text(store.data.get(ROOT_CLAIM_KEY))).toBe(claimFile(root));
  });

  test("a store claimed for the root is left as it is", async () => {
    const store = memoryBlobStore();
    const root = ulid();
    await claimStoreRoot(store, root);
    const puts = store.calls.put;
    expect(await claimStoreRoot(store, root)).toEqual({ ok: true, value: { root } });
    expect(store.calls.put).toBe(puts);
  });

  test("a store another root claimed names that root, and nothing is written", async () => {
    const store = memoryBlobStore();
    const other = ulid();
    await claimStoreRoot(store, other);
    const puts = store.calls.put;
    expect(await claimStoreRoot(store, ulid())).toEqual({ ok: true, value: { root: other } });
    expect(store.calls.put).toBe(puts);
  });

  test("of two roots claiming at once, at most one wins and both agree; with no winner nothing is claimed", async () => {
    const store = memoryBlobStore();
    const [a, b] = [ulid(), ulid()];
    const results = await Promise.all([claimStoreRoot(store, a), claimStoreRoot(store, b)]);
    const roots = results.flatMap((r) => (r.ok ? [r.value.root] : []));
    expect(new Set(roots).size).toBeLessThanOrEqual(1);
    if (roots.length === 0) {
      for (const r of results)
        expect(r.ok ? "" : r.finding.code).toMatch(/^store\.root-(contested|undecided)$/);
      expect(store.data.has(ROOT_CLAIM_KEY)).toBe(false);
    }
  });

  test("the root claim is the elected publication under meta/v1/root-claims/, the root's id its attempt (Q9)", async () => {
    const store = memoryBlobStore();
    const root = ulid();
    await claimStoreRoot(store, root);
    expect([...store.data.keys()].filter((k) => k.startsWith(ROOT_CLAIMS_PREFIX)).sort()).toEqual([
      `${ROOT_CLAIMS_PREFIX}${root}.json`,
      `${ROOT_CLAIMS_PREFIX}${root}.publishing`,
    ]);
    // root.json keeps format 1's shape, so v0.1.1 reads the claim as before.
    expect(text(store.data.get(ROOT_CLAIM_KEY))).toBe(claimFile(root));
  });

  const record = (id: string, decision: string) =>
    new TextEncoder().encode(`${JSON.stringify({ v: 1, id, decision })}\n`);

  test("two roots that both stand and both refuse: store.root-contested, nothing claimed, the fix is the quiesced cleanup", async () => {
    const store = memoryBlobStore();
    const [a, b] = [ulid(), ulid()];
    store.data.set(`${ROOT_CLAIMS_PREFIX}${b}.json`, record(b, "candidate"));
    store.data.set(`${ROOT_CLAIMS_PREFIX}${b}.refused`, record(b, "refused"));
    const result = await claimStoreRoot(store, a, { wait: async () => {} });
    expect(result.ok ? "" : result.finding.code).toBe("store.root-contested");
    expect(result.ok ? "" : result.finding.fix).toContain("every device");
    expect(result.ok ? "" : result.finding.message).toContain(b);
    expect(store.data.has(ROOT_CLAIM_KEY)).toBe(false);
  });

  test("a rival root that has not decided yet: store.root-undecided, re-run later, nothing removed", async () => {
    const store = memoryBlobStore();
    const [a, b] = [ulid(), ulid()];
    store.data.set(`${ROOT_CLAIMS_PREFIX}${b}.json`, record(b, "candidate"));
    const result = await claimStoreRoot(store, a, { wait: async () => {} });
    expect(result.ok ? "" : result.finding.code).toBe("store.root-undecided");
    expect(result.ok ? "" : result.finding.message).toContain(b);
    expect(result.ok ? "" : result.finding.fix).toContain("re-run");
    expect(store.data.has(`${ROOT_CLAIMS_PREFIX}${b}.json`)).toBe(true);
    // The same root re-run, once the rival publishes, sees the claim and is refused as before (store.root-mismatch).
    store.data.set(ROOT_CLAIM_KEY, new TextEncoder().encode(claimFile(b)));
    expect(await claimStoreRoot(store, a)).toEqual({ ok: true, value: { root: b } });
  });

  test("a claim v0.1.1 made (root.json with no candidates) holds: another root sees it, and nothing is written", async () => {
    const store = memoryBlobStore();
    const old = ulid();
    store.data.set(ROOT_CLAIM_KEY, new TextEncoder().encode(claimFile(old)));
    const puts = store.calls.put;
    expect(await claimStoreRoot(store, ulid())).toEqual({ ok: true, value: { root: old } });
    expect(store.calls.put).toBe(puts);
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
      if (key === ROOT_CLAIM_KEY) puts.push(text(data) ?? "");
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
    expect(result).toEqual({ ok: true, value: { root: b } });
    expect(await writing).toEqual({ ok: true, value: { root: b } });
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

  test("a crash right after each of the claim's election writes (D52 seams), then a re-run with the root's id, claims it", async () => {
    for (const point of ["candidacy", "publishing", "publication"] as const) {
      const store = memoryBlobStore();
      const root = ulid();
      const crashed = claimStoreRoot(store, root, {
        wait: async () => {},
        after: (write) => {
          if (write === point) throw new InjectedFault(`offload.root-claim.${write}`);
        },
      });
      await expect(crashed).rejects.toBeInstanceOf(InjectedFault);
      const again = await claimStoreRoot(store, root, { wait: async () => {} });
      expect(again.ok && again.value.root).toBe(root);
      expect(text(store.data.get(ROOT_CLAIM_KEY))).toBe(claimFile(root));
    }
  });

  test("a crash right after a root's refusal, then a re-run: the refusal stands, and it never claims", async () => {
    const store = memoryBlobStore();
    const [a, b] = [ulid(), ulid()];
    store.data.set(`${ROOT_CLAIMS_PREFIX}${b}.json`, record(b, "candidate"));
    const crashed = claimStoreRoot(store, a, {
      wait: async () => {},
      after: (write) => {
        if (write === "refusal") throw new InjectedFault("offload.root-claim.refusal");
      },
    });
    await expect(crashed).rejects.toBeInstanceOf(InjectedFault);
    store.data.delete(`${ROOT_CLAIMS_PREFIX}${b}.json`);
    const again = await claimStoreRoot(store, a, { wait: async () => {} });
    expect(again.ok ? "" : again.finding.code).toBe("store.root-contested");
    expect(store.data.has(ROOT_CLAIM_KEY)).toBe(false);
  });
});
