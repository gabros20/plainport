// Run only by test/home-tripwire.test.ts in a child `bun test`; the name keeps it out of the normal run.
// Both tests must fail: one lets the tripwire error escape, the other swallows it.
import { test } from "bun:test";
import { writeFileSync } from "node:fs";

const probe = process.env.PLAINPORT_TRIPWIRE_PROBE ?? "";
if (probe === "") throw new Error("PLAINPORT_TRIPWIRE_PROBE is not set");

test("writes under the real home", () => {
  writeFileSync(probe, "x");
});

test("writes under the real home and swallows the error", () => {
  try {
    writeFileSync(probe, "x");
  } catch {
    // The tripwire must still fail this test.
  }
});
