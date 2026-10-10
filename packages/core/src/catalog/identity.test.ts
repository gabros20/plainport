import { describe, expect, test } from "bun:test";
import { memoryBlobStore } from "../testing/memory-blob-store.ts";
import { ulid } from "../ulid.ts";
import { catalogJsonSchemas } from "./index.ts";
import {
  encodeStoreIdentityV2,
  readStoreDescriptor,
  readStoreIdentity,
  STORE_IDENTITY_KEY,
  StoreIdentitySchema,
} from "./identity.ts";

const put = (text: string) => {
  const store = memoryBlobStore();
  store.data.set(STORE_IDENTITY_KEY, new TextEncoder().encode(text));
  return store;
};

describe("store identity: format 1 and format 2 (Q2)", () => {
  test("a format-1 file describes an M1 store: its repository at repo/, its catalog plain", async () => {
    const id = ulid();
    const store = put(`${JSON.stringify({ v: 1, id })}\n`);
    expect(await readStoreDescriptor(store)).toEqual({
      ok: true,
      value: { format: 1, id, repo: "repo", seal: "none" },
    });
    expect(await readStoreIdentity(store)).toEqual({ ok: true, value: id });
  });

  test("a format-2 file names the store's id, its repository and its seal policy", async () => {
    const id = ulid();
    const bytes = encodeStoreIdentityV2({ id, repo: `repos/${id}`, seal: "v1" });
    expect(new TextDecoder().decode(bytes)).toBe(
      `${JSON.stringify({ v: 2, id, repo: `repos/${id}`, catalog: { seal: "v1" }, format: 2 })}\n`,
    );
    const store = memoryBlobStore();
    store.data.set(STORE_IDENTITY_KEY, bytes);
    expect(await readStoreDescriptor(store)).toEqual({
      ok: true,
      value: { format: 2, id, repo: `repos/${id}`, seal: "v1" },
    });
    expect(await readStoreIdentity(store)).toEqual({ ok: true, value: id });
  });

  test("a format-2 file is strict: unknown keys, a repository outside the store's layout or a mismatched format refuse", async () => {
    const id = ulid();
    const good = { v: 2, id, repo: `repos/${id}`, catalog: { seal: "none" }, format: 2 };
    for (const bad of [
      { ...good, extra: 1 },
      { ...good, repo: "../elsewhere" },
      { ...good, repo: "repos/not-a-ulid" },
      { ...good, format: 1 },
      { ...good, catalog: { seal: "maybe" } },
    ]) {
      const read = await readStoreDescriptor(put(`${JSON.stringify(bad)}\n`));
      expect(read.ok ? "" : read.finding.code).toBe("store.failed");
    }
    // A store upgraded from format 1 keeps M1's repository location.
    expect((await readStoreDescriptor(put(`${JSON.stringify({ ...good, repo: "repo" })}\n`))).ok).toBe(true);
  });

  test("a store without the file has no identity", async () => {
    expect(await readStoreDescriptor(memoryBlobStore())).toEqual({ ok: true, value: null });
  });

  test("store-identity's published JSON Schema accepts both formats", () => {
    const schema = catalogJsonSchemas()["store-identity"] as { anyOf?: unknown[]; oneOf?: unknown[] };
    expect((schema.anyOf ?? schema.oneOf ?? []).length).toBe(2);
    const id = ulid();
    expect(StoreIdentitySchema.safeParse({ v: 1, id }).success).toBe(true);
    expect(
      StoreIdentitySchema.safeParse({ v: 2, id, repo: "repo", catalog: { seal: "none" }, format: 2 }).success,
    ).toBe(true);
  });
});
