// The crash matrix's rows are enumerated from the sagas' and recover's exports: every step and every after-effect
// seam of both sagas is a row, every row has a recover rule, and each branch's points are crashed under its setup.

import { describe, expect, test } from "bun:test";
import {
  OFFLOAD_AFTER_EFFECT,
  OFFLOAD_BRANCHES,
  OFFLOAD_STEPS,
} from "../../packages/core/src/saga/offload.ts";
import { ONLOAD_AFTER_EFFECT, ONLOAD_BRANCHES, ONLOAD_STEPS } from "../../packages/core/src/saga/onload.ts";
import { ALL_ROWS, OFFLOAD_ROWS, ONLOAD_ROWS } from "./matrix.ts";

describe("crash matrix rows", () => {
  test("every offload step and seam is crashed at least once", () => {
    const crashed = new Set(OFFLOAD_ROWS.map((r) => r.point));
    expect([...OFFLOAD_STEPS, ...Object.keys(OFFLOAD_AFTER_EFFECT)].filter((p) => !crashed.has(p))).toEqual(
      [],
    );
  });

  test("every onload step and seam is crashed at least once", () => {
    const crashed = new Set(ONLOAD_ROWS.map((r) => r.point));
    expect([...ONLOAD_STEPS, ...Object.keys(ONLOAD_AFTER_EFFECT)].filter((p) => !crashed.has(p))).toEqual([]);
  });

  test("each branch's points are crashed under that branch's setup, unless the plain run takes it", () => {
    const plain = new Set(["firstOffloadOfRoot", "keepStub", "detached", "stub"]);
    for (const [name, branch] of [...Object.entries(OFFLOAD_BRANCHES), ...Object.entries(ONLOAD_BRANCHES)]) {
      const scenario = plain.has(name) ? "plain" : name;
      for (const point of branch.reaches)
        expect(ALL_ROWS.some((r) => r.scenario === scenario && r.point === point)).toBe(true);
    }
  });

  test("a retry's points are crashed at their second time", () => {
    const retry = OFFLOAD_ROWS.filter((r) => r.scenario === "retry");
    expect(retry.map((r) => r.point).sort()).toEqual([...OFFLOAD_BRANCHES.retry.reaches].sort());
    expect(retry.every((r) => r.occurrence === 2)).toBe(true);
  });

  test("a seam's row leaves the journal at the step it follows, and every row has outcomes to check", () => {
    for (const row of ALL_ROWS) {
      const seams: Record<string, string> = { ...OFFLOAD_AFTER_EFFECT, ...ONLOAD_AFTER_EFFECT };
      expect(row.step).toBe(seams[row.point] ?? row.point);
      expect(row.outcomes.length).toBeGreaterThan(0);
    }
  });

  test("rows are unique", () => {
    const names = ALL_ROWS.map((r) => `${r.saga} ${r.name}`);
    expect(new Set(names).size).toBe(names.length);
  });
});
