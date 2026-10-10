import { describe, expect, test } from "bun:test";
import {
  canAppend,
  canCommit,
  canElect,
  canRead,
  canRelease,
  capabilitiesOf,
  requireEligible,
  type StoreSemantics,
  StoreSemanticsSchema,
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
