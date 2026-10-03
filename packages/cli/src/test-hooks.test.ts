// The crash matrix's hook in the binary (testFaultPlan): a planned SIGKILL, or a pause, at one saga step, read from
// the environment only by a binary built for the matrix and only in a test run that guards the real home.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testFaultPlan } from "./test-hooks.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-hooks-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const REAL = "/Users/someone";
const testRun = (extra: Record<string, string> = {}) => ({
  HOME: join(dir, "home"),
  PLAINPORT_TRIPWIRE_REAL_HOME: REAL,
  ...extra,
});

describe("testFaultPlan", () => {
  test("a binary not built for the matrix (every release, every source run) never plans a fault", () => {
    expect(testFaultPlan(testRun({ PLAINPORT_TEST_FAULT_AT: "offload.committed" }), false)).toBeUndefined();
  });

  test("a matrix build plans none outside a test run that guards the real home", () => {
    expect(
      testFaultPlan({ HOME: join(dir, "home"), PLAINPORT_TEST_FAULT_AT: "offload.committed" }, true),
    ).toBeUndefined();
  });

  test("nor with HOME at or inside the real home it guards", () => {
    for (const home of [REAL, `${REAL}/sub`])
      expect(
        testFaultPlan(testRun({ HOME: home, PLAINPORT_TEST_FAULT_AT: "offload.committed" }), true),
      ).toBeUndefined();
  });

  test("in a guarded test run of a matrix build: a SIGKILL at the step, the nth time it is reached", () => {
    const plan = testFaultPlan(
      testRun({ PLAINPORT_TEST_FAULT_AT: "offload.snapshot.done", PLAINPORT_TEST_FAULT_OCCURRENCE: "2" }),
      true,
    );
    expect(plan).toMatchObject({ at: "offload.snapshot.done", action: "kill", occurrence: 2 });
  });

  test("a step or occurrence that is not well formed plans nothing", () => {
    const malformed: Record<string, string>[] = [
      { PLAINPORT_TEST_FAULT_AT: "Offload Committed" },
      { PLAINPORT_TEST_FAULT_AT: "offload.committed", PLAINPORT_TEST_FAULT_OCCURRENCE: "0" },
      { PLAINPORT_TEST_FAULT_AT: "offload.committed", PLAINPORT_TEST_FAULT_OCCURRENCE: "x" },
      { PLAINPORT_TEST_PAUSE_AT: "offload.planned" },
    ];
    for (const extra of malformed) expect(testFaultPlan(testRun(extra), true)).toBeUndefined();
  });

  test("a pause writes its file at the step the first time, and goes on once the file is removed", async () => {
    const file = join(dir, "paused");
    const plan = testFaultPlan(
      testRun({ PLAINPORT_TEST_PAUSE_AT: "offload.snapshot.start", PLAINPORT_TEST_PAUSE_FILE: file }),
      true,
    );
    expect(plan?.at).toBeUndefined();
    plan?.onStep?.("offload.planned");
    expect(existsSync(file)).toBe(false);
    // The pause blocks this thread, so another process removes the file once it appears.
    const remover = Bun.spawn(
      ["/bin/sh", "-c", `while [ ! -e "$0" ]; do sleep 0.02; done; sleep 0.1; rm "$0"`, file],
      { env: { PATH: "/usr/bin:/bin" } },
    );
    const started = Date.now();
    plan?.onStep?.("offload.snapshot.start");
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(existsSync(file)).toBe(false);
    await remover.exited;
    // Not again: the second time the step is reached, nothing waits.
    const again = Date.now();
    plan?.onStep?.("offload.snapshot.start");
    expect(existsSync(file)).toBe(false);
    expect(Date.now() - again).toBeLessThan(100);
  });
});
