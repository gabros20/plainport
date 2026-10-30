// The race schedules (test/support/schedules.ts) against the checkout's binary on a local store: each schedule that
// runs is a T1 test on macOS; each that waits for its feature is a test.todo naming the task that turns it on. The
// gate test lists the todos and fails at the M2 gate (PLAINPORT_M2_GATE=1) while any remains.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeProjectTemplate } from "../crash-matrix/fixture.ts";
import { onMac } from "../platform.ts";
import { describeT1, tierEnabled } from "../tiers.ts";
import { SCHEDULES, todoSchedules } from "./schedules.ts";
import { Devices, type Harness, makeHarness, removeHarness } from "./two-devices.ts";

const runs = tierEnabled(1) && onMac;

describeT1("schedules: devices racing on one local store", () => {
  let harness: Harness | undefined;
  let world: Devices | undefined;

  beforeAll(() => {
    if (runs) harness = makeHarness(makeProjectTemplate());
  }, 180_000);
  afterEach(async () => {
    await world?.cleanup();
    world = undefined;
  });
  afterAll(async () => {
    if (harness !== undefined) await removeHarness(harness);
  });

  // The seams reach the binary's detached delete too: its environment carries the hook's variables (test-hooks.ts).
  test.skipIf(!onMac)(
    "the pause seam trash.delete.checked stops the detached delete with its trash still there",
    async () => {
      world = await Devices.create(harness as Harness);
      const a = world.device("dev-a");
      world.project(a);
      const offload = a.start(["offload", "work:web", "--yes", "--json"], {
        pauseAt: "trash.delete.checked",
      });
      expect((await offload.done).code).toBe(0);
      const deadline = Date.now() + 30_000;
      while (!existsSync(offload.pauseFile) && Date.now() < deadline) await Bun.sleep(10);
      const trash = join(a.root, ".plainport-trash");
      expect(existsSync(offload.pauseFile)).toBe(true);
      expect(readdirSync(trash).some((n) => n.endsWith(".claim"))).toBe(true);
      offload.resume();
      await a.settled();
      expect(existsSync(trash)).toBe(false);
    },
    180_000,
  );

  for (const schedule of SCHEDULES) {
    const name = `${schedule.id} ${schedule.title}`;
    const { run } = schedule;
    if (schedule.runInProcess !== undefined) continue;
    if (run === undefined) test.todo(`${name} (Task ${schedule.owner})`, () => {});
    else
      test.skipIf(!onMac)(
        name,
        async () => {
          world = await Devices.create(harness as Harness, schedule.devices);
          await run(world);
        },
        180_000,
      );
  }
});

// The schedules a binary on a local store cannot stage, in process on the semantic fake (T0: no binary, no restic).
describe("schedules: devices racing in process on a fake store", () => {
  for (const schedule of SCHEDULES) {
    const { runInProcess } = schedule;
    if (runInProcess !== undefined) test(`${schedule.id} ${schedule.title}`, runInProcess, 60_000);
  }
});

describe("schedules: the gate", () => {
  test("every schedule names its devices' outcomes, and each todo its owning task", () => {
    for (const s of SCHEDULES) {
      expect(Object.keys(s.outcomes).sort()).toEqual([...s.devices].sort());
      expect(s.run === undefined && s.runInProcess === undefined).toBe(s.owner !== undefined);
    }
    expect(todoSchedules().map((s) => [s.id, s.owner])).toEqual([
      ["S2", 23],
      ["S3", 23],
      ["S5", 23],
      ["S7", 25],
      ["S8", 24],
    ]);
  });

  // At the M2 gate every schedule runs: a todo left is a feature the gate cannot judge yet.
  test.skipIf(process.env.PLAINPORT_M2_GATE !== "1")("no schedule is still a todo at the M2 gate", () => {
    expect(todoSchedules().map((s) => `${s.id} (Task ${s.owner})`)).toEqual([]);
  });
});
