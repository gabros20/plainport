// Golden plans (DESIGN.md "Testing": planner rules and strip-set logic against fixture trees). A golden file is
// rewritten only by `bun packages/eco-node/scripts/golden.ts` and reviewed like code; tests never write to the
// checkout.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { GOLDEN_CASES, goldenFile, normalize, planCase, shown } from "./testing.ts";

describe("Node plugin: golden plans", () => {
  for (const c of GOLDEN_CASES) {
    test(`${c.name} plans as ${shown(goldenFile(c.name))} says`, async () => {
      const run = await planCase(c);
      try {
        expect(run.plan.estimate).toEqual({ uploadBytes: run.plan.include.bytes });
        const file = goldenFile(c.name);
        if (!existsSync(file)) throw new Error(`${shown(file)} is missing; write it with the golden script`);
        expect(normalize(run)).toEqual(JSON.parse(readFileSync(file, "utf8")));
      } finally {
        run.fx.cleanup();
      }
    });
  }

  test("a tracked build/ is never stripped", async () => {
    const yarn = GOLDEN_CASES.find((c) => c.name === "yarn-classic");
    if (yarn === undefined) throw new Error("no yarn-classic case");
    const run = await planCase({ ...yarn, tracked: ["build/index.html"] });
    try {
      expect(run.plan.strip.map((s) => s.path)).toEqual(["node_modules"]);
    } finally {
      run.fx.cleanup();
    }
  });

  test("Yarn Berry's committed zero-install cache is kept", async () => {
    const berry = GOLDEN_CASES.find((c) => c.name === "yarn-berry");
    if (berry === undefined) throw new Error("no yarn-berry case");
    const run = await planCase(berry);
    try {
      const paths = run.plan.strip.map((s) => s.path);
      expect(paths).not.toContain(".yarn/cache");
      expect(paths).not.toContain(".pnp.cjs");
      expect(paths).toContain(".yarn/install-state.gz");
    } finally {
      run.fx.cleanup();
    }
  });

  test("a monorepo strips every nested node_modules and installs once at the root", async () => {
    const mono = GOLDEN_CASES.find((c) => c.name === "monorepo");
    if (mono === undefined) throw new Error("no monorepo case");
    const run = await planCase(mono);
    try {
      expect(run.plan.strip.map((s) => s.path).filter((p) => p.endsWith("node_modules"))).toEqual([
        "node_modules",
        "apps/web/node_modules",
        "packages/ui/node_modules",
      ]);
      expect(run.plan.arrival).toEqual([
        { part: "deps", outcome: "hydrate", detail: "pnpm install --frozen-lockfile" },
      ]);
    } finally {
      run.fx.cleanup();
    }
  });
});
