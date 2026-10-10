// The deadline of a host call that may never return (D32), on a fake scheduler (AGENTS.md rule 5).

import { describe, expect, test } from "bun:test";
import { probeWithin, type Scheduler, STORE_PROBE_DEADLINE_MS, withinDeadline } from "./deadline.ts";

/** A scheduler whose timers fire only when the test says; it records each one's delay and whether it was cleared. */
const manual = () => {
  const timers: { fire: () => void; ms: number; cleared: boolean }[] = [];
  const scheduler: Scheduler = {
    setTimer: (fire, ms) => timers.push({ fire, ms, cleared: false }) - 1,
    clearTimer: (handle) => {
      const timer = timers[handle as number];
      if (timer !== undefined) timer.cleared = true;
    },
  };
  return { scheduler, timers };
};

describe("withinDeadline (D32)", () => {
  test("a call that never returns times out when its timer fires, and the timer is cleared", async () => {
    const { scheduler, timers } = manual();
    const waiting = withinDeadline(new Promise<never>(() => {}), 10_000, scheduler);
    await Promise.resolve();
    expect(timers.map((t) => t.ms)).toEqual([10_000]);
    timers[0]?.fire();
    expect(await waiting).toEqual({ timedOut: true });
    expect(timers[0]?.cleared).toBe(true);
  });

  test("a call that answers first gives its value and clears the timer, which never fires", async () => {
    const { scheduler, timers } = manual();
    expect(await withinDeadline(Promise.resolve(7), 10_000, scheduler)).toEqual({
      timedOut: false,
      value: 7,
    });
    expect(timers[0]?.cleared).toBe(true);
  });

  test("a rejection passes through; one that comes after the deadline is dropped, never unhandled", async () => {
    const { scheduler, timers } = manual();
    await expect(withinDeadline(Promise.reject(new Error("EIO")), 10, scheduler)).rejects.toThrow("EIO");
    let reject: (error: Error) => void = () => {};
    const late = new Promise<never>((_, r) => {
      reject = r;
    });
    const waiting = withinDeadline(late, 10, scheduler);
    timers.at(-1)?.fire();
    expect(await waiting).toEqual({ timedOut: true });
    reject(new Error("late"));
    await Promise.resolve();
  });

  test("a store probe's deadline is 10 seconds unless one is given", async () => {
    const { scheduler, timers } = manual();
    const waiting = probeWithin(new Promise<string>(() => {}), { scheduler }, (seconds) => `late ${seconds}`);
    await Promise.resolve();
    timers[0]?.fire();
    expect([await waiting, timers[0]?.ms]).toEqual(["late 10", STORE_PROBE_DEADLINE_MS]);
  });
});
