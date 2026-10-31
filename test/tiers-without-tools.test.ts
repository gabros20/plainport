// T0 never needs a pinned binary (ADR-0018): `bun test` on a fresh checkout, where nothing has run fetch-tools, must
// load every tiered suite and skip it cleanly. A tool lookup at a file's top level or in a top-level beforeAll runs even
// when every suite in the file is skipped, and fails the run as an "(unnamed)" test, which a checkout with .tools/
// never shows (CI run 41182891650). This runs those files at tier 0 in a copy of this checkout without .tools/.

import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { lazyTempDir } from "./lazy-temp.ts";

const repo = join(import.meta.dir, "..");
const scratch = lazyTempDir("plainport-tiers-no-tools-");

/** This working tree's files (tracked, and untracked but not ignored, so never .tools/) copied into `dir`. */
const copyWithoutTools = (dir: string): string[] => {
  const listed = Bun.spawnSync(
    ["git", "-C", repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (listed.exitCode !== 0) throw new Error(`git ls-files: ${listed.stderr.toString()}`);
  const files = listed.stdout
    .toString()
    .split("\0")
    .filter((path) => path !== "" && existsSync(join(repo, path)));
  for (const path of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(join(repo, path), join(dir, path), { verbatimSymlinks: true });
  }
  // The workspace packages' links are relative, so they resolve inside the copy, and through it to the shared store.
  symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"));
  for (const name of readdirSync(join(repo, "packages"))) {
    const modules = join(repo, "packages", name, "node_modules");
    if (existsSync(modules))
      cpSync(modules, join(dir, "packages", name, "node_modules"), {
        recursive: true,
        verbatimSymlinks: true,
      });
  }
  return files;
};

test("at tier 0, with no .tools/, every tiered suite loads and skips: no file needs a pinned binary to load", () => {
  const files = copyWithoutTools(scratch());
  expect(existsSync(join(scratch(), ".tools"))).toBe(false);
  // The files that are tiered as a whole (<name>.t1, .t2, .t3): at tier 0 nothing in them runs but their top level and
  // top-level hooks. A name filter (-t) would not do: it skips those hooks too. Files that mix T0 tests with tiered
  // suites run their top level in every T0 run already.
  const tiered = files.filter((path) => /\.t[123]\.test\.ts$/.test(path));
  expect(tiered).toContain("packages/cli/src/store-commands.t2.test.ts");
  const ran = Bun.spawnSync(["bun", "test", ...tiered.map((path) => `./${path}`)], {
    cwd: scratch(),
    env: { ...process.env, PLAINPORT_TEST_TIER: "0", PLAINPORT_TOOLS_DIR: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = ran.stdout.toString() + ran.stderr.toString();
  const failures = output.split("\n").filter((line) => /^\(fail\)|not found; looked for/.test(line));
  expect(failures).toEqual([]);
  expect(ran.exitCode).toBe(0);
}, 120_000);
