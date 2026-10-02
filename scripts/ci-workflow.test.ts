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

test("fetches the pinned tools and runs test:t1 on macOS and Linux", () => {
  for (const job of ["macos", "linux"]) {
    expect(runs(job)).toContain("bun scripts/fetch-tools.ts\n");
    expect(runs(job).indexOf("bun scripts/fetch-tools.ts")).toBeLessThan(
      runs(job).indexOf("bun run test:t1"),
    );
  }
});

test("the Linux job installs zsh, so the real-shell re-run test runs there too", () => {
  expect(runs("linux")).toContain("apt-get install -y zsh");
  expect(runs("linux").indexOf("apt-get install -y zsh")).toBeLessThan(runs("linux").indexOf("bun run test"));
});
