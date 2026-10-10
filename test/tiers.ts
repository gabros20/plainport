// Test tiers (ADR-0018, ADR-0021). `bun test` and `bun run test` run T0. `bun run test:t1` sets
// PLAINPORT_TEST_TIER=1, which adds the suites declared with describeT1: those that run real binaries
// (restic, rclone) from `.tools/`. `test:t2` (2) adds describeT2, the suites that need the store containers
// `scripts/testenv up` brings up; `test:t3` (3) adds describeT3, the real buckets and the Mac mini (M2 Task 28).
//
// Below its tier a suite is skipped. At its tier, a T2 or T3 suite whose environment is missing fails, naming the
// command to run: it never skips silently.

import { describe, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostTarget } from "../packages/core/src/tools.ts";
import { environmentProblem, testenvDir } from "../scripts/testenv.ts";

type Env = Record<string, string | undefined>;

const checkout = resolve(import.meta.dir, "..");

export const tierEnabled = (tier: number, env: Env = process.env): boolean => {
  const value = env.PLAINPORT_TEST_TIER ?? "0";
  return /^\d+$/.test(value) && Number(value) >= tier;
};

export { testenvDir };

export type Gate =
  | { run: true }
  | { run: false; reason: "tier" }
  | { run: false; reason: "missing"; message: string };

// One health probe per environment folder and test process: every describeT2 suite in a run shares it.
const probed = new Map<string, string | undefined>();
const probeOnce = (dir: string): string | undefined => {
  if (!probed.has(dir)) probed.set(dir, environmentProblem(dir));
  return probed.get(dir);
};

/**
 * Whether a T2 or T3 suite runs: skipped below its tier, failing when its environment is missing. A T2 environment
 * must also be live: `probe` (default: one `docker inspect` of the containers `up` recorded) names what is wrong with
 * a stale .testenv/, such as containers removed by a prune or a reboot.
 */
export const environmentGate = (
  tier: 2 | 3,
  env: Env = process.env,
  exists: (path: string) => boolean = existsSync,
  probe: (dir: string) => string | undefined = probeOnce,
): Gate => {
  if (!tierEnabled(tier, env)) return { run: false, reason: "tier" };
  const dir = testenvDir(env);
  if (tier === 2) {
    const marker = join(dir, "env.json");
    if (exists(marker)) {
      const problem = probe(dir);
      if (problem === undefined) return { run: true };
      return {
        run: false,
        reason: "missing",
        message:
          `the T2 environment in ${dir} is stale: ${problem}. ` +
          "Run `scripts/testenv down`, then `scripts/testenv up`, then `bun run test:t2`.",
      };
    }
    return {
      run: false,
      reason: "missing",
      message: `no T2 environment: ${marker} is missing. Run \`scripts/testenv up\`, then \`bun run test:t2\`.`,
    };
  }
  const marker = join(dir, "t3.env");
  if (exists(marker)) return { run: true };
  return {
    run: false,
    reason: "missing",
    message:
      `no T3 environment: ${marker} is missing. It holds the op:// references for the R2 and B2 test buckets ` +
      "(docs/plans/M2-remote-stores.md, Task 28); create it, then run `bun run test:t3`.",
  };
};

const describeGated = (tier: 2 | 3, name: string, fn: () => void): void => {
  const gate = environmentGate(tier);
  const title = `[t${tier}] ${name}`;
  if (gate.run) describe(title, fn);
  else if (gate.reason === "tier") describe.skip(title, fn);
  else
    describe(title, () => {
      test("has its environment", () => {
        throw new Error(gate.message);
      });
    });
};

/** A suite that needs real binaries. Skipped in T0; its name starts with "[t1]" so `-t '\[t1\]'` selects it. */
export const describeT1 = (name: string, fn: () => void): void => {
  describe.skipIf(!tierEnabled(1))(`[t1] ${name}`, fn);
};

/** A suite that needs the T2 containers (`scripts/testenv up`). Its name starts with "[t2]". */
export const describeT2 = (name: string, fn: () => void): void => describeGated(2, name, fn);

/** A suite that needs the T3 buckets and hosts. Its name starts with "[t3]". */
export const describeT3 = (name: string, fn: () => void): void => describeGated(3, name, fn);

/**
 * The restic the restic matrix (CI's `restic-matrix` job) puts under test: PLAINPORT_RESTIC_MATRIX=<version> names
 * the binary `bun scripts/fetch-tools.ts --restic <version>` installed. Unset, suites use the pinned restic.
 */
export const resticUnderTest = (env: Env = process.env): { version: string; path: string } | undefined => {
  const version = env.PLAINPORT_RESTIC_MATRIX;
  if (!version) return undefined;
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`PLAINPORT_RESTIC_MATRIX must be a restic version X.Y.Z, not ${JSON.stringify(version)}`);
  }
  return {
    version,
    path: join(checkout, ".tools", "matrix", `restic-${version}`, String(hostTarget()), "restic"),
  };
};
