// Eligibility per operation on the measured profiles (M2 Task 17; DESIGN.md "Remote stores: consistency and
// publication"): what each backend may do, and that a profile forced weaker refuses exactly what the table says.

import { describe, expect, test } from "bun:test";
import {
  eligibility,
  requireEligible,
  STORE_OPERATIONS,
  type StoreOperation,
  type StoreSemantics,
  StoreSemanticsSchema,
} from "@plainport/core";
import { AWS_S3_DOCUMENTED, SEAWEEDFS_PROFILE, SFTP_OPENSSH_PROFILE } from "./index.ts";

type Expected = "eligible" | "post-grace-proof" | "refused";

/** Per operation: eligible outright, only with Q21's post-grace proof, or refused. */
const verdicts = (semantics: StoreSemantics): Record<StoreOperation, Expected> =>
  Object.fromEntries(
    STORE_OPERATIONS.map((op) => [
      op,
      eligibility(op, semantics).eligible
        ? "eligible"
        : eligibility(op, semantics, { postGraceProof: true }).eligible
          ? "post-grace-proof"
          : "refused",
    ]),
  ) as Record<StoreOperation, Expected>;

describe("the measured profiles", () => {
  test("are well formed", () => {
    for (const profile of [SEAWEEDFS_PROFILE, SFTP_OPENSSH_PROFILE, AWS_S3_DOCUMENTED])
      expect(StoreSemanticsSchema.safeParse(profile).success).toBe(true);
  });

  test("SFTP passes read, append, elect and commit, and release only through Q21's post-grace proof", () => {
    expect(verdicts(SFTP_OPENSSH_PROFILE)).toEqual({
      read: "eligible",
      append: "eligible",
      elect: "eligible",
      commit: "eligible",
      release: "post-grace-proof",
    });
  });

  test("SeaweedFS passes the same, electing on its conditional create; AWS S3 is durable by its documentation", () => {
    expect(verdicts(SEAWEEDFS_PROFILE)).toEqual(verdicts(SFTP_OPENSSH_PROFILE));
    expect(verdicts(AWS_S3_DOCUMENTED)).toEqual({
      read: "eligible",
      append: "eligible",
      elect: "eligible",
      commit: "eligible",
      release: "eligible",
    });
  });

  test("a profile forced to publication in-place refuses append (and so commit), naming the property", () => {
    const inPlace: StoreSemantics = {
      ...SFTP_OPENSSH_PROFILE,
      publication: { value: "in-place", evidence: "asserted" },
    };
    expect(verdicts(inPlace)).toMatchObject({
      read: "eligible",
      append: "refused",
      elect: "eligible",
      commit: "refused",
      release: "refused",
    });
    const refused = requireEligible("append", inPlace, { store: "nas" });
    expect(refused).toMatchObject({ ok: false, finding: { code: "store.semantics-unknown" } });
    if (!refused.ok) expect(refused.finding.message).toContain("publication is in-place (asserted)");
  });

  test("a profile forced to durability unknown refuses release even with the proof, and says why", () => {
    for (const durability of ["unknown", { value: "unknown", evidence: "measured" }] as const) {
      const unknown: StoreSemantics = { ...SFTP_OPENSSH_PROFILE, durability };
      expect(verdicts(unknown)).toEqual({
        read: "eligible",
        append: "eligible",
        elect: "eligible",
        commit: "eligible",
        release: "refused",
      });
      const refused = requireEligible("release", unknown, { store: "nas", proof: { postGraceProof: true } });
      expect(refused).toMatchObject({ ok: false, finding: { code: "store.semantics-unknown" } });
      if (!refused.ok) {
        expect(refused.finding.message).toContain("durability is unknown");
        expect(refused.finding.message).toContain("release a folder");
      }
    }
  });
});
