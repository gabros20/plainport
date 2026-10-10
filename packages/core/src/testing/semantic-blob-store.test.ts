import { describe, expect, test } from "bun:test";
import {
  canAppend,
  canCommit,
  canElect,
  canRelease,
  requireEligible,
  type StoreSemantics,
} from "../ports/blob-store.ts";
import { ALL_ELIGIBLE, blobStoreContract, semanticViolations } from "./blob-store-contract.ts";
import { semanticBlobStore } from "./semantic-blob-store.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array | null | undefined): string | null | undefined =>
  data == null ? data : new TextDecoder().decode(data);

/** What a store that lies would claim: every property at its strongest. */
const STRONG: StoreSemantics = {
  readAfterWrite: { value: true, evidence: "asserted" },
  listAfterWrite: { value: true, evidence: "asserted" },
  listComplete: { value: true, evidence: "asserted" },
  publication: { value: "atomic-put", evidence: "asserted" },
  conditionalCreate: { value: true, evidence: "asserted" },
  durability: { value: "durable", evidence: "asserted" },
  cancellation: { value: "never-lands-late", evidence: "asserted" },
};

// With no weakness switched on, the fake is the memory store, and keeps its contract.
blobStoreContract(
  "semantic fake without weaknesses",
  () => ({ store: semanticBlobStore(), cleanup: () => {} }),
  { eligibility: ALL_ELIGIBLE },
);

// A store that acknowledges before it syncs (SFTP) keeps the contract too: Q21 admits it for release with the
// post-grace proof, and the contract asserts exactly that instead of every predicate.
blobStoreContract(
  "semantic fake, acked-unsynced",
  () => ({ store: semanticBlobStore({ durability: "acked-unsynced" }), cleanup: () => {} }),
  { eligibility: { ...ALL_ELIGIBLE, release: "post-grace-proof" } },
);

describe("semantic probe: failure handling", () => {
  test("a probe write that fails stops and joins the observer, and removes the probe's keys", async () => {
    const inner = semanticBlobStore();
    const failing = {
      ...inner,
      put: (key: string, data: Uint8Array, opts?: { ifNotExists?: boolean }) =>
        key.endsWith("/whole")
          ? Promise.resolve({
              ok: false as const,
              exitCode: 1 as const,
              finding: {
                code: "store.failed",
                severity: "block" as const,
                message: "injected",
                allowable: false,
              },
            })
          : inner.put(key, data, opts),
    };
    await expect(semanticViolations(failing, undefined, { listProbeKeys: 5 })).rejects.toThrow("injected");
    const reads = inner.calls.get;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inner.calls.get).toBe(reads);
    expect([...inner.data.keys()].filter((key) => key.startsWith("probe/"))).toEqual([]);
  });
});

describe("semantic fake: each weakness is caught", () => {
  test("delayed visibility: a get does not see a write until it settles", async () => {
    const store = semanticBlobStore({ delayedVisibility: true });
    await store.put("k", bytes("v"));
    expect(await store.get("k")).toEqual({ ok: true, value: null });
    store.settle();
    expect(text(((await store.get("k")) as { value: Uint8Array }).value)).toBe("v");
  });

  test("delayed visibility contradicts a claimed read-after-write", async () => {
    const lying = semanticBlobStore({ delayedVisibility: true, profile: STRONG });
    expect(await semanticViolations(lying, lying)).toContain("readAfterWrite");
    const honest = semanticBlobStore({ delayedVisibility: true });
    expect(await semanticViolations(honest, honest)).toEqual([]);
    expect(canAppend(honest.semantics())).toEqual({ eligible: false, missing: ["readAfterWrite"] });
  });

  test("a listing that omits recent keys contradicts a claimed list-after-write", async () => {
    const store = semanticBlobStore({ listOmitsRecent: true });
    await store.put("p/old", bytes("1"));
    store.settle();
    await store.put("p/new", bytes("2"));
    expect(((await store.list("p/")) as { value: { key: string }[] }).value.map((e) => e.key)).toEqual([
      "p/old",
    ]);
    const lying = semanticBlobStore({ listOmitsRecent: true, profile: STRONG });
    expect(await semanticViolations(lying, lying)).toContain("listAfterWrite");
    const honest = semanticBlobStore({ listOmitsRecent: true, conditionalCreate: false });
    expect(await semanticViolations(honest, honest)).toEqual([]);
    expect(canElect(honest.semantics())).toEqual({ eligible: false, missing: ["listAfterWrite"] });
  });

  test("a listing cut short by pagination contradicts a claimed complete listing", async () => {
    const lying = semanticBlobStore({ truncateListAt: 1000, profile: STRONG });
    expect(await semanticViolations(lying, lying)).toContain("listComplete");
    const honest = semanticBlobStore({ truncateListAt: 1000, conditionalCreate: false });
    expect(await semanticViolations(honest, honest)).toEqual([]);
    expect(canElect(honest.semantics())).toEqual({ eligible: false, missing: ["listComplete"] });
  });

  test("a torn in-place write is visible while it is written, and stays torn after a crash", async () => {
    const store = semanticBlobStore({ tornWrites: true });
    const seen: (string | null)[] = [];
    const writing = store.put("k", bytes("0123456789"));
    seen.push(text(((await store.get("k")) as { value: Uint8Array | null }).value) as string | null);
    await writing;
    seen.push(text(((await store.get("k")) as { value: Uint8Array | null }).value) as string | null);
    expect(seen).toEqual(["01234", "0123456789"]);

    store.tearNext();
    expect(await store.put("t", bytes("abcdef"))).toMatchObject({ ok: false });
    expect(text(((await store.get("t")) as { value: Uint8Array }).value)).toBe("abc");
  });

  test("a torn write contradicts a claimed atomic put; an honest in-place store cannot append", async () => {
    const lying = semanticBlobStore({ tornWrites: true, profile: STRONG });
    expect(await semanticViolations(lying, lying)).toContain("publication");
    const honest = semanticBlobStore({ tornWrites: true });
    expect(honest.semantics().publication).toMatchObject({ value: "in-place" });
    expect(await semanticViolations(honest, honest)).toEqual([]);
    expect(canAppend(honest.semantics())).toEqual({ eligible: false, missing: ["publication"] });
  });

  test("with a whole rename the torn store publishes temp-then-rename, and a rename is never seen torn", async () => {
    const store = semanticBlobStore({ tornWrites: true, rename: true });
    expect(store.semantics().publication).toMatchObject({ value: "temp-then-rename" });
    expect(await semanticViolations(store, store)).toEqual([]);
    expect(canAppend(store.semantics())).toEqual({ eligible: true });
  });

  test("a lost acknowledgement: the write lands, the call fails", async () => {
    const store = semanticBlobStore();
    store.loseAckNext();
    const put = await store.put("k", bytes("v"));
    expect(put).toMatchObject({ ok: false, finding: { code: "store.unreachable" } });
    expect(text(((await store.get("k")) as { value: Uint8Array }).value)).toBe("v");
  });

  test("late landing after cancellation: the put fails, and the write lands later", async () => {
    const store = semanticBlobStore({ lateLanding: true });
    expect(store.semantics().cancellation).toMatchObject({ value: "may-land-late" });
    store.cancelNext();
    expect(await store.put("k", bytes("v"))).toMatchObject({
      ok: false,
      finding: { code: "process.cancelled" },
    });
    expect(await store.get("k")).toEqual({ ok: true, value: null });
    store.settle();
    expect(text(((await store.get("k")) as { value: Uint8Array }).value)).toBe("v");

    const dropped = semanticBlobStore();
    dropped.cancelNext();
    await dropped.put("k", bytes("v"));
    dropped.settle();
    expect(await dropped.get("k")).toEqual({ ok: true, value: null });
  });

  test("a cancelled conditional create that lands late keeps its condition: it fails if the key now exists", async () => {
    const store = semanticBlobStore({ lateLanding: true });
    store.cancelNext();
    await store.put("k", bytes("late"), { ifNotExists: true });
    expect(await store.put("k", bytes("first"), { ifNotExists: true })).toMatchObject({ ok: true });
    store.settle();
    expect(text(((await store.get("k")) as { value: Uint8Array }).value)).toBe("first");
  });

  test("late landing contradicts a claimed never-lands-late", async () => {
    const lying = semanticBlobStore({ lateLanding: true, profile: STRONG });
    expect(await semanticViolations(lying, lying)).toContain("cancellation");
    const honest = semanticBlobStore({ lateLanding: true });
    expect(await semanticViolations(honest, honest)).toEqual([]);
  });
});

describe("semantic fake: each predicate refuses on the profile that lacks its property", () => {
  const cases: {
    name: string;
    store: ReturnType<typeof semanticBlobStore>;
    op: "append" | "elect" | "commit" | "release";
    property: string;
  }[] = [
    {
      name: "in-place writes",
      store: semanticBlobStore({ tornWrites: true }),
      op: "append",
      property: "publication",
    },
    {
      name: "delayed visibility",
      store: semanticBlobStore({ delayedVisibility: true }),
      op: "append",
      property: "readAfterWrite",
    },
    {
      name: "a listing that omits recent keys, without conditional create",
      store: semanticBlobStore({ listOmitsRecent: true, conditionalCreate: false }),
      op: "elect",
      property: "listAfterWrite",
    },
    {
      name: "a short listing, without conditional create",
      store: semanticBlobStore({ truncateListAt: 10, conditionalCreate: false }),
      op: "commit",
      property: "listComplete",
    },
    {
      name: "acknowledged before synced",
      store: semanticBlobStore({ durability: "acked-unsynced" }),
      op: "release",
      property: "durability",
    },
  ];
  for (const { name, store, op, property } of cases) {
    test(`${name}: ${op} refuses, naming ${property}`, () => {
      const refused = requireEligible(op, store.semantics(), { store: "fake" });
      expect(refused).toMatchObject({ ok: false, finding: { code: "store.semantics-unknown" } });
      if (!refused.ok) expect(refused.finding.message).toContain(property);
    });
  }

  test("the fake's strong default passes every predicate", () => {
    const store = semanticBlobStore();
    for (const can of [canAppend, canElect, canCommit, canRelease]) {
      expect(can(store.semantics())).toEqual({ eligible: true });
    }
  });
});
