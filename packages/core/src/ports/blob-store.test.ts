import { describe, expect, test } from "bun:test";
import { fail, finding, ok } from "@plainport/contract";
import { z } from "zod";
import { memoryBlobStore } from "../testing/memory-blob-store.ts";
import {
  canAppend,
  canCommit,
  canElect,
  canRead,
  canRelease,
  capabilitiesOf,
  getMany,
  requireEligible,
  type StoreSemantics,
  StoreSemanticsSchema,
  storeSemanticsJsonSchemas,
  UNKNOWN_SEMANTICS,
} from "./blob-store.ts";

const strong: StoreSemantics = {
  readAfterWrite: { value: true, evidence: "documented" },
  listAfterWrite: { value: true, evidence: "documented" },
  listComplete: { value: true, evidence: "documented" },
  publication: { value: "atomic-put", evidence: "documented" },
  conditionalCreate: { value: true, evidence: "documented" },
  durability: { value: "durable", evidence: "asserted" },
  cancellation: { value: "never-lands-late", evidence: "documented" },
};
const withProp = (patch: Partial<StoreSemantics>): StoreSemantics => ({ ...strong, ...patch });

describe("store semantics: the profile", () => {
  test("every property is a value with its evidence, or unknown; anything else is refused", () => {
    expect(StoreSemanticsSchema.safeParse(strong).success).toBe(true);
    expect(StoreSemanticsSchema.safeParse(UNKNOWN_SEMANTICS).success).toBe(true);
    expect(
      StoreSemanticsSchema.safeParse({ ...strong, readAfterWrite: { value: true, evidence: "guessed" } })
        .success,
    ).toBe(false);
    expect(StoreSemanticsSchema.safeParse({ ...strong, publication: { value: "none" } }).success).toBe(false);
    expect(StoreSemanticsSchema.safeParse({ ...strong, extra: "unknown" }).success).toBe(false);
  });

  test("the profile is published as JSON Schema, the zod schema's own export", () => {
    expect(storeSemanticsJsonSchemas()).toEqual({
      "store-semantics": z.toJSONSchema(StoreSemanticsSchema, {
        target: "draft-2020-12",
        io: "input",
      }) as Record<string, unknown>,
    });
  });

  test("capabilities() derives from the profile: create-if-absent only when conditional create is known true", () => {
    expect(capabilitiesOf(strong)).toEqual({ createIfAbsent: true, replaceIfMatch: false });
    expect(capabilitiesOf(withProp({ conditionalCreate: { value: false, evidence: "measured" } }))).toEqual({
      createIfAbsent: false,
      replaceIfMatch: false,
    });
    expect(capabilitiesOf(UNKNOWN_SEMANTICS)).toEqual({ createIfAbsent: false, replaceIfMatch: false });
  });
});

describe("store semantics: eligibility per operation", () => {
  test("a strong profile is eligible for every operation", () => {
    for (const can of [canRead, canAppend, canElect, canCommit, canRelease]) {
      expect(can(strong)).toEqual({ eligible: true });
    }
  });

  test("read needs only a listing that works: the all-unknown profile can still read", () => {
    expect(canRead(UNKNOWN_SEMANTICS)).toEqual({ eligible: true });
  });

  test("append needs whole publication and read-after-write", () => {
    expect(canAppend(withProp({ publication: { value: "in-place", evidence: "measured" } }))).toEqual({
      eligible: false,
      missing: ["publication"],
    });
    expect(canAppend(withProp({ publication: { value: "temp-then-rename", evidence: "measured" } }))).toEqual(
      { eligible: true },
    );
    expect(canAppend(withProp({ readAfterWrite: { value: false, evidence: "measured" } }))).toEqual({
      eligible: false,
      missing: ["readAfterWrite"],
    });
    expect(canAppend(UNKNOWN_SEMANTICS)).toEqual({
      eligible: false,
      missing: ["readAfterWrite", "publication"],
    });
  });

  test("elect needs a conditional create, or visibility both ways and complete listings", () => {
    const noCreate = withProp({ conditionalCreate: { value: false, evidence: "measured" } });
    // A missing conditional create alone only routes elections to the fallback.
    expect(canElect(noCreate)).toEqual({ eligible: true });
    expect(canElect(withProp({ conditionalCreate: "unknown" }))).toEqual({ eligible: true });
    // With a conditional create the visibility properties are not needed.
    expect(canElect(withProp({ listComplete: { value: false, evidence: "measured" } }))).toEqual({
      eligible: true,
    });
    for (const property of ["readAfterWrite", "listAfterWrite", "listComplete"] as const) {
      expect(canElect({ ...noCreate, [property]: { value: false, evidence: "measured" } })).toEqual({
        eligible: false,
        missing: [property],
      });
      expect(canElect({ ...noCreate, [property]: "unknown" })).toEqual({
        eligible: false,
        missing: [property],
      });
    }
  });

  test("commit needs append and elect", () => {
    expect(canCommit(withProp({ publication: { value: "in-place", evidence: "measured" } }))).toEqual({
      eligible: false,
      missing: ["publication"],
    });
    expect(
      canCommit(
        withProp({
          conditionalCreate: { value: false, evidence: "measured" },
          listComplete: "unknown",
        }),
      ),
    ).toEqual({ eligible: false, missing: ["listComplete"] });
  });

  test("release needs commit and a durable store, or acked-unsynced with Q21's post-grace proof", () => {
    const unsynced = withProp({ durability: { value: "acked-unsynced", evidence: "documented" } });
    expect(canRelease(unsynced)).toEqual({ eligible: false, missing: ["durability"] });
    expect(canRelease(unsynced, { postGraceProof: true })).toEqual({ eligible: true });
    expect(canRelease(withProp({ durability: { value: "unknown", evidence: "documented" } }))).toEqual({
      eligible: false,
      missing: ["durability"],
    });
    expect(canRelease(withProp({ durability: "unknown" }), { postGraceProof: true })).toEqual({
      eligible: false,
      missing: ["durability"],
    });
    expect(canRelease(withProp({ readAfterWrite: "unknown" }))).toEqual({
      eligible: false,
      missing: ["readAfterWrite"],
    });
  });
});

describe("store semantics: refusals", () => {
  test("an operation whose predicate fails refuses with store.semantics-unknown, naming the property", () => {
    const refused = requireEligible("append", withProp({ readAfterWrite: "unknown" }), { store: "nas" });
    expect(refused).toMatchObject({ ok: false, exitCode: 6, finding: { code: "store.semantics-unknown" } });
    if (refused.ok) throw new Error("unreachable");
    expect(refused.finding.message).toContain("readAfterWrite");
    expect(refused.finding.message).toContain("nas");
    expect(refused.finding.fix).toContain("readAfterWrite");
  });

  test("a refused operation leaves the store usable for the others", () => {
    const weak = withProp({ durability: "unknown" });
    expect(requireEligible("release", weak, { store: "nas" }).ok).toBe(false);
    for (const op of ["read", "append", "elect", "commit"] as const) {
      expect(requireEligible(op, weak, { store: "nas" })).toEqual({ ok: true, value: undefined });
    }
  });
});

describe("getMany: one batch where the store offers one", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  test("without a batch read it gets each key once, leaving out the missing", async () => {
    const store = memoryBlobStore();
    await store.put("a", bytes("A"));
    await store.put("b", bytes("B"));
    const got = await getMany(store, ["a", "b", "a", "missing"]);
    expect(got.ok && [...got.value.entries()]).toEqual([
      ["a", bytes("A")],
      ["b", bytes("B")],
    ]);
  });

  test("a failed read fails the batch", async () => {
    const store = memoryBlobStore();
    const failing = { ...store, get: async () => fail(finding("store.unreachable", { message: "down" })) };
    expect(await getMany(failing, ["a"])).toMatchObject({
      ok: false,
      finding: { code: "store.unreachable" },
    });
  });

  test("a store's own batch read is used", async () => {
    const store = memoryBlobStore();
    const batch = new Map([["x", bytes("X")]]);
    const batched = { ...store, getMany: async () => ok(batch) };
    expect(await getMany(batched, ["x"])).toEqual(ok(batch));
  });
});
