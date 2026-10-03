// Run only by test/home-tripwire.test.ts in a child `bun test`: prints the child's sandbox, then passes or fails
// as PLAINPORT_FIXTURE_FAIL asks, so the parent can check the sandbox is gone either way.
import { expect, test } from "bun:test";

test("reports its sandbox", () => {
  console.log(`SANDBOX=${process.env.PLAINPORT_TEST_HOME}`);
  expect(process.env.PLAINPORT_FIXTURE_FAIL).not.toBe("1");
});
