// The crash matrix's hook in the binary (testFaultPlan): a planned SIGKILL, or a pause, at one saga step, read from
// the environment only in a test run that guards the real home. That only a matrix build calls it at all is checked
// on the release binary itself (scripts/build.test.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testFaultPlan } from "./test-hooks.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-hooks-")));
  mkdirSync(join(dir, "home"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const REAL = "/Users/someone";
const guard = { refuse: [REAL], readOnly: [] };
const testRun = (extra: Record<string, string> = {}) => ({
  HOME: join(dir, "home"),
  PLAINPORT_TRIPWIRE_REAL_HOME: REAL,
  ...extra,
});

describe("testFaultPlan", () => {
  test("none outside a test run that guards the real home", async () => {
    const env = { HOME: join(dir, "home"), PLAINPORT_TEST_FAULT_AT: "offload.committed" };
    expect(await testFaultPlan(env, guard)).toBeUndefined();
    expect(
      await testFaultPlan(testRun({ PLAINPORT_TEST_FAULT_AT: "offload.committed" }), undefined),
    ).toBeUndefined();
  });

  test("nor with HOME at or inside the real home it guards", async () => {
    for (const home of [REAL, `${REAL}/sub`])
      expect(
        await testFaultPlan(testRun({ HOME: home, PLAINPORT_TEST_FAULT_AT: "offload.committed" }), guard),
      ).toBeUndefined();
  });

  test("in a guarded test run: a SIGKILL at the step, the nth time it is reached", async () => {
    const plan = await testFaultPlan(
      testRun({ PLAINPORT_TEST_FAULT_AT: "offload.snapshot.done", PLAINPORT_TEST_FAULT_OCCURRENCE: "2" }),
      guard,
    );
    expect(plan).toMatchObject({ at: "offload.snapshot.done", action: "kill", occurrence: 2 });
  });

  test("a step or occurrence that is not well formed plans nothing", async () => {
    const malformed: Record<string, string>[] = [
      { PLAINPORT_TEST_FAULT_AT: "Offload Committed" },
      { PLAINPORT_TEST_FAULT_AT: "offload.committed", PLAINPORT_TEST_FAULT_OCCURRENCE: "0" },
      { PLAINPORT_TEST_FAULT_AT: "offload.committed", PLAINPORT_TEST_FAULT_OCCURRENCE: "x" },
      { PLAINPORT_TEST_PAUSE_AT: "offload.planned" },
    ];
    for (const extra of malformed) expect(await testFaultPlan(testRun(extra), guard)).toBeUndefined();
  });

  test("a pause file outside HOME, or one the guard refuses, plans nothing", async () => {
    const pause = { PLAINPORT_TEST_PAUSE_AT: "offload.snapshot.start" };
    expect(
      await testFaultPlan(testRun({ ...pause, PLAINPORT_TEST_PAUSE_FILE: join(dir, "elsewhere") }), guard),
    ).toBeUndefined();
    // A HOME inside a refused folder the rails do not know as the real home: the guard still refuses the write.
    const refused = { refuse: [join(dir, "home")], readOnly: [] };
    expect(
      await testFaultPlan(
        testRun({ ...pause, PLAINPORT_TEST_PAUSE_FILE: join(dir, "home/paused") }),
        refused,
      ),
    ).toBeUndefined();
  });

  test("a pause writes its file at the step the first time, and goes on once the file is removed", async () => {
    const file = join(dir, "home/paused");
    const plan = await testFaultPlan(
      testRun({ PLAINPORT_TEST_PAUSE_AT: "offload.snapshot.start", PLAINPORT_TEST_PAUSE_FILE: file }),
      guard,
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
