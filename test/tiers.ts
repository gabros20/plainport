// Test tiers (ADR-0018, ADR-0021). `bun test` and `bun run test` run T0. `bun run test:t1` sets
// PLAINPORT_TEST_TIER=1, which adds the suites declared with describeT1: those that run real binaries
// (restic, rclone) from `.tools/`.

import { describe } from "bun:test";

export const tierEnabled = (tier: number, env: Record<string, string | undefined> = process.env): boolean => {
  const value = env.PLAINPORT_TEST_TIER ?? "0";
  return /^\d+$/.test(value) && Number(value) >= tier;
};

/** A suite that needs real binaries. Skipped in T0; its name starts with "[t1]" so `-t '\[t1\]'` selects it. */
export const describeT1 = (name: string, fn: () => void): void => {
  describe.skipIf(!tierEnabled(1))(`[t1] ${name}`, fn);
};
