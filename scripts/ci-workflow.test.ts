// Pins the parts of .github/workflows/ci.yml that ADR-0020 requires, so they can't silently drop out.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Step = { run?: string };
type Workflow = {
  on: { push: { branches?: string[]; tags?: string[] } };
  jobs: Record<string, { steps: Step[] }>;
};

const workflow = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "../.github/workflows/ci.yml"), "utf8"),
) as Workflow;
const runs = (job: string): string =>
  (workflow.jobs[job]?.steps ?? []).map((step) => step.run ?? "").join("\n");

test("runs on pushes to main and on v* tags", () => {
  expect(workflow.on.push.branches).toEqual(["main"]);
  expect(workflow.on.push.tags).toEqual(["v*"]);
});

test("compile-smokes all four targets and runs only the native binary", () => {
  expect(runs("linux")).toContain("bun scripts/build.ts --target all");
  expect(runs("linux")).toContain("./dist/plainport --version");
  expect(runs("macos")).toContain("./dist/plainport --version");
});

test("checks version consistency", () => {
  expect(runs("version")).toContain("bun run check:version");
});

test("fetches the pinned tools and runs test:t1 on macOS, and test:t2 (T1 and more) on Linux", () => {
  for (const [job, script] of [
    ["macos", "bun run test:t1"],
    ["linux", "bun run test:t2"],
  ] as const) {
    expect(runs(job)).toContain("bun scripts/fetch-tools.ts\n");
    expect(runs(job).indexOf("bun scripts/fetch-tools.ts")).toBeLessThan(runs(job).indexOf(script));
  }
});

test("the Linux job installs zsh, so the real-shell re-run test runs there too", () => {
  expect(runs("linux")).toContain("apt-get install -y zsh");
  expect(runs("linux").indexOf("apt-get install -y zsh")).toBeLessThan(runs("linux").indexOf("bun run test"));
});

test("fails when plainport.json, schemas/ or completions/ are stale (ADR-0007, AGENTS.md rule 4)", () => {
  expect(runs("macos")).toContain("bun run contract --check");
});

test("both test jobs install npm, pnpm and Yarn Classic, so the real offline installs run there (Task 13)", () => {
  for (const job of ["macos", "linux"]) {
    expect(
      workflow.jobs[job]?.steps.some((step) => (step as { uses?: string }).uses === "actions/setup-node@v4"),
    ).toBe(true);
    expect(runs(job)).toContain("npm install -g pnpm@10.32.1 yarn@1.22.22");
    expect(runs(job).indexOf("npm install -g pnpm@10.32.1 yarn@1.22.22")).toBeLessThan(
      runs(job).indexOf("bun run test"),
    );
  }
});

type Job = {
  "runs-on": string;
  strategy?: { matrix?: Record<string, unknown> };
  steps: (Step & Record<string, unknown>)[];
};
const job = (name: string): Job => (workflow.jobs as unknown as Record<string, Job>)[name] as Job;
const lock = JSON.parse(readFileSync(join(import.meta.dir, "../tools.lock.json"), "utf8")) as {
  tools: { restic: { version: string } };
  matrix: { restic: { version: string }[] };
};

test("the Linux job brings up the T2 containers, runs test:t2 (which includes T1) and always takes them down", () => {
  const linux = runs("linux");
  const up = linux.indexOf("scripts/testenv up");
  expect(up).toBeGreaterThan(linux.indexOf("bun scripts/fetch-tools.ts"));
  expect(linux.indexOf("bun run test:t2")).toBeGreaterThan(up);
  const down = job("linux").steps.find((step) => step.run?.includes("scripts/testenv down"));
  expect(down?.if).toBe("always()");
  expect(linux.indexOf("scripts/testenv down")).toBeGreaterThan(linux.indexOf("bun run test:t2"));
});

test("macOS runs no T2: GitHub's macOS runners have no Docker", () => {
  expect(runs("macos")).not.toContain("scripts/testenv");
  expect(runs("macos")).not.toContain("test:t2");
});

// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template.
const MATRIX_RESTIC = "${{ matrix.restic }}";

test("the restic matrix runs engine-restic's T1 suite on the latest 0.18 and the pinned restic (D93: 0.18.0 or later)", () => {
  const matrix = job("restic-matrix");
  expect(matrix["runs-on"]).toBe("ubuntu-24.04");
  const versions = matrix.strategy?.matrix?.restic as string[];
  expect(versions).toEqual([...lock.matrix.restic.map((entry) => entry.version), lock.tools.restic.version]);
  expect(versions[0]).toStartWith("0.18.");
  expect(versions.some((version) => version.startsWith("0.18."))).toBe(true);
  // A matrix row that fails does not cancel the others: each version's result is its own.
  expect((matrix.strategy as { "fail-fast"?: boolean })["fail-fast"]).toBe(false);
  const steps = runs("restic-matrix");
  expect(steps).toContain("bun install --frozen-lockfile");
  expect(steps).toContain(`bun scripts/fetch-tools.ts --restic ${MATRIX_RESTIC}`);
  const test = matrix.steps.find((step) => step.run?.includes("bun test packages/engine-restic"));
  expect(test?.env).toEqual({ PLAINPORT_TEST_TIER: "1", PLAINPORT_RESTIC_MATRIX: MATRIX_RESTIC });
});
