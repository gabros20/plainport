import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const version = readFileSync(join(repoRoot, "VERSION"), "utf8").trim();
let outDir = "";
let binary = "";

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), "plainport-build-"));
  binary = join(outDir, "plainport");
  const build = Bun.spawnSync([process.execPath, join(repoRoot, "scripts/build.ts"), "--outfile", binary], {
    cwd: repoRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr.toString()}`);
}, 120_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

test("the compiled binary prints `plainport <VERSION>` and exits 0", () => {
  // Run from an unrelated directory: the version must be baked into the binary, not read at run time.
  const run = Bun.spawnSync([binary, "--version"], { cwd: outDir, stdout: "pipe", stderr: "pipe" });
  expect(run.stdout.toString()).toBe(`plainport ${version}\n`);
  expect(run.exitCode).toBe(0);
});
