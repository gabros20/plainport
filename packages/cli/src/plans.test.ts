import { describe, expect, test } from "bun:test";
import { type LocalIo, nodeLocalIo } from "@plainport/core";
import { preloadPlans } from "./plans.ts";

const NOW = new Date("2026-10-03T12:00:00Z");
const failingReaddir = (error: Error): LocalIo => ({
  ...nodeLocalIo,
  fs: {
    ...nodeLocalIo.fs,
    readdir: async () => {
      throw error;
    },
  },
});
const coded = (code: string) => Object.assign(new Error(code), { code });

describe("plan store preload", () => {
  test("a plans folder that cannot be read approves nothing", async () => {
    const store = await preloadPlans(failingReaddir(coded("EACCES")), { HOME: "/nowhere" }, NOW);
    expect(store.approved("offload", "01J9Z6KB2B8D4F6H8K0M2P4R6T")).toBe(false);
  });

  test("a bug is not swallowed (AGENTS.md rule 7)", async () => {
    expect(preloadPlans(failingReaddir(new TypeError("bug")), { HOME: "/nowhere" }, NOW)).rejects.toThrow(
      "bug",
    );
  });

  test("no usable HOME approves nothing", async () => {
    expect((await preloadPlans(nodeLocalIo, {}, NOW)).approved("offload", "x")).toBe(false);
  });
});
