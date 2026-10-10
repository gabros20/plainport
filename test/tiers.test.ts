import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostTarget } from "../packages/core/src/tools.ts";
import { environmentGate, resticUnderTest, testenvDir, tierEnabled } from "./tiers.ts";

const checkout = join(import.meta.dir, "..");

test("T1 suites are skipped unless PLAINPORT_TEST_TIER is 1 or higher", () => {
  expect(tierEnabled(1, {})).toBe(false);
  expect(tierEnabled(1, { PLAINPORT_TEST_TIER: "0" })).toBe(false);
  expect(tierEnabled(1, { PLAINPORT_TEST_TIER: "1" })).toBe(true);
  expect(tierEnabled(1, { PLAINPORT_TEST_TIER: "2" })).toBe(true);
  expect(tierEnabled(2, { PLAINPORT_TEST_TIER: "1" })).toBe(false);
  expect(tierEnabled(1, { PLAINPORT_TEST_TIER: "yes" })).toBe(false);
});

describe("tiers: T2 and T3 gating", () => {
  const none = () => false;
  const all = () => true;

  test("the environment folder is .testenv/ in the checkout unless PLAINPORT_TESTENV_DIR names another", () => {
    expect(testenvDir({})).toBe(join(checkout, ".testenv"));
    expect(testenvDir({ PLAINPORT_TESTENV_DIR: "" })).toBe(join(checkout, ".testenv"));
    expect(testenvDir({ PLAINPORT_TESTENV_DIR: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
  });

  test("below its tier a T2 or T3 suite is skipped, whether or not its environment exists", () => {
    for (const exists of [none, all]) {
      expect(environmentGate(2, { PLAINPORT_TEST_TIER: "1" }, exists)).toEqual({
        run: false,
        reason: "tier",
      });
      expect(environmentGate(3, { PLAINPORT_TEST_TIER: "2" }, exists)).toEqual({
        run: false,
        reason: "tier",
      });
      expect(environmentGate(2, {}, exists)).toEqual({ run: false, reason: "tier" });
    }
  });

  test("at its tier, a suite without its environment fails and names the command to run", () => {
    const t2 = environmentGate(2, { PLAINPORT_TEST_TIER: "2", PLAINPORT_TESTENV_DIR: "/x" }, none);
    expect(t2).toMatchObject({ run: false, reason: "missing" });
    expect(t2.run === false && t2.reason === "missing" ? t2.message : "").toContain("/x/env.json");
    expect(t2.run === false && t2.reason === "missing" ? t2.message : "").toContain("scripts/testenv up");

    const t3 = environmentGate(3, { PLAINPORT_TEST_TIER: "3", PLAINPORT_TESTENV_DIR: "/x" }, none);
    expect(t3).toMatchObject({ run: false, reason: "missing" });
    expect(t3.run === false && t3.reason === "missing" ? t3.message : "").toContain("/x/t3.env");
  });

  test("at or above its tier, a suite whose environment exists runs", () => {
    const seen: string[] = [];
    const exists = (path: string) => {
      seen.push(path);
      return true;
    };
    expect(environmentGate(2, { PLAINPORT_TEST_TIER: "2", PLAINPORT_TESTENV_DIR: "/x" }, exists)).toEqual({
      run: true,
    });
    expect(environmentGate(2, { PLAINPORT_TEST_TIER: "3", PLAINPORT_TESTENV_DIR: "/x" }, exists)).toEqual({
      run: true,
    });
    expect(environmentGate(3, { PLAINPORT_TEST_TIER: "3", PLAINPORT_TESTENV_DIR: "/x" }, exists)).toEqual({
      run: true,
    });
    expect(seen).toEqual(["/x/env.json", "/x/env.json", "/x/t3.env"]);
  });

  // The real thing: a test file declaring a describeT2 and a describeT3 suite, run by `bun test` in a child.
  const scratch = mkdtempSync(join(tmpdir(), "plainport-tiers-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const file = join(scratch, "gated.test.ts");
  writeFileSync(
    file,
    [
      `import { expect, test } from "bun:test";`,
      `import { describeT2, describeT3 } from ${JSON.stringify(join(import.meta.dir, "tiers.ts"))};`,
      `describeT2("store", () => { test("ran-t2", () => expect(1).toBe(1)); });`,
      `describeT3("bucket", () => { test("ran-t3", () => expect(1).toBe(1)); });`,
      "",
    ].join("\n"),
  );
  const run = (tier: string, dir: string) => {
    const child = Bun.spawnSync(["bun", "test", file], {
      cwd: scratch,
      env: { ...process.env, PLAINPORT_TEST_TIER: tier, PLAINPORT_TESTENV_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: child.exitCode, output: child.stdout.toString() + child.stderr.toString() };
  };

  test("bun test: T2 and T3 suites are skipped below their tier", () => {
    const ran = run("1", join(scratch, "nothing"));
    expect(ran.exitCode).toBe(0);
    expect(ran.output).toContain("2 skip");
  });

  test("bun test: a T2 suite with no environment fails the run, naming scripts/testenv up", () => {
    const ran = run("2", join(scratch, "nothing"));
    expect(ran.exitCode).toBe(1);
    expect(ran.output).toContain("[t2] store");
    expect(ran.output).toContain("scripts/testenv up");
    expect(ran.output).not.toContain("ran-t2");
  });

  test("bun test: with the environment present the T2 suite runs and the T3 suite fails at tier 3 only", () => {
    const dir = join(scratch, "env");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "env.json"), "{}\n");
    const t2 = run("2", dir);
    expect(t2.exitCode).toBe(0);
    expect(t2.output).toContain("1 pass");
    expect(t2.output).toContain("1 skip");
    const t3 = run("3", dir);
    expect(t3.exitCode).toBe(1);
    expect(t3.output).toContain("[t3] bucket");
    expect(t3.output).toContain("t3.env");
  });
});

describe("tiers: the restic under test (restic matrix)", () => {
  test("without PLAINPORT_RESTIC_MATRIX the suites use the pinned restic as before", () => {
    expect(resticUnderTest({})).toBeUndefined();
    expect(resticUnderTest({ PLAINPORT_RESTIC_MATRIX: "" })).toBeUndefined();
  });

  test("PLAINPORT_RESTIC_MATRIX=<version> names the binary fetch-tools --restic installs, and its version", () => {
    expect(resticUnderTest({ PLAINPORT_RESTIC_MATRIX: "0.17.1" })).toEqual({
      version: "0.17.1",
      path: join(checkout, ".tools", "matrix", "restic-0.17.1", String(hostTarget()), "restic"),
    });
  });

  test("a malformed version is an error, not a silent fallback to the pinned restic", () => {
    expect(() => resticUnderTest({ PLAINPORT_RESTIC_MATRIX: "latest" })).toThrow("X.Y.Z");
  });
});
