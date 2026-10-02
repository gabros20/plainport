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

test("the compiled binary answers --help and refuses an unknown command with exit 4", () => {
  const help = Bun.spawnSync([binary, "--help"], { cwd: outDir, stdout: "pipe", stderr: "pipe" });
  expect(help.stdout.toString()).toContain("Usage: plainport <command> [options]");
  expect(help.exitCode).toBe(0);
  const unknown = Bun.spawnSync([binary, "verison", "--json"], {
    cwd: outDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(JSON.parse(unknown.stdout.toString())).toMatchObject({ ok: false, error: { code: 4 } });
  expect(unknown.exitCode).toBe(4);
});
