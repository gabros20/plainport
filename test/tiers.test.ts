import { expect, test } from "bun:test";
import { tierEnabled } from "./tiers.ts";

test("T1 suites are skipped unless PLAINPORT_TEST_TIER is 1 or higher", () => {
  expect(tierEnabled(1, {})).toBe(false);
  expect(tierEnabled(1, { PLAINPORT_TEST_TIER: "0" })).toBe(false);
  expect(tierEnabled(1, { PLAINPORT_TEST_TIER: "1" })).toBe(true);
  expect(tierEnabled(1, { PLAINPORT_TEST_TIER: "2" })).toBe(true);
  expect(tierEnabled(2, { PLAINPORT_TEST_TIER: "1" })).toBe(false);
  expect(tierEnabled(1, { PLAINPORT_TEST_TIER: "yes" })).toBe(false);
});
