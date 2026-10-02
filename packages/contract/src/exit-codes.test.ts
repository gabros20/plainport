import { describe, expect, test } from "bun:test";
import { EXIT, EXIT_CODE_MEANINGS, ExitCodeSchema, FailureExitCodeSchema } from "./index.ts";

// The frozen table. Exit codes are public API (ADR-0007): a change here is a breaking change and needs a
// plainport_json bump, so this literal is edited only together with docs/machine-contract.md.
const FROZEN = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  confirm: 3,
  notFound: 4,
  denied: 5,
  blocked: 6,
  verifyFailed: 7,
  conflict: 8,
  unreachable: 9,
  unhydrated: 10,
  locked: 11,
  cancelled: 130,
};

const FROZEN_MEANINGS = {
  0: "Success",
  1: "Unexpected failure",
  2: "Usage error, or an ambiguous project name",
  3: "Needs --yes; the message names the exact re-run",
  4: "Not found: project, snapshot, device, store or command",
  5: "Denied by policy: a root not allowed on this device, untrusted hooks, a key without permission",
  6: "Blocked by a preflight finding, or the plan is stale",
  7: "Verification failed",
  8: "Conflict, or a strict lease held elsewhere",
  9: "Store or peer unreachable",
  10: "Restored but not hydrated",
  11: "Another operation holds the lock",
  130: "Cancelled",
};

describe("exit codes", () => {
  test("the table is frozen", () => {
    expect(EXIT as unknown).toEqual(FROZEN);
    expect(EXIT_CODE_MEANINGS as unknown).toEqual(FROZEN_MEANINGS);
    expect(Object.isFrozen(EXIT)).toBe(true);
    expect(Object.isFrozen(EXIT_CODE_MEANINGS)).toBe(true);
  });

  test("0 to 5 match plainkeep's protocol", () => {
    expect([EXIT.ok, EXIT.unexpected, EXIT.usage, EXIT.confirm, EXIT.notFound, EXIT.denied]).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
  });

  test("the schema accepts exactly the table", () => {
    for (const code of Object.values(FROZEN)) expect(ExitCodeSchema.safeParse(code).success).toBe(true);
    for (const code of [-1, 12, 13, 126, 127, 128, 129, 131, 255, 1.5, "0"]) {
      expect(ExitCodeSchema.safeParse(code).success).toBe(false);
    }
  });

  test("a failure exit code is any code but 0", () => {
    expect(FailureExitCodeSchema.safeParse(0).success).toBe(false);
    for (const code of Object.values(FROZEN).filter((c) => c !== 0)) {
      expect(FailureExitCodeSchema.safeParse(code).success).toBe(true);
    }
  });
});
