import { describe, expect, test } from "bun:test";
import { IMAGE, scanCommand, scanVerdict } from "./secrets.ts";

test("the main checkout mounts its working tree, which holds .git, at the same path", () => {
  const argv = scanCommand({ toplevel: "/src/plainport", commonDir: "/src/plainport/.git", staged: false });
  expect(argv).toEqual([
    "docker",
    "run",
    "--rm",
    "-v",
    "/src/plainport:/src/plainport:ro",
    IMAGE,
    "detect",
    "--source",
    "/src/plainport",
    "--no-banner",
    "--redact",
    "--verbose",
  ]);
});

test("a linked worktree also mounts the common git dir its .git file points into", () => {
  const argv = scanCommand({ toplevel: "/wt/task-5", commonDir: "/src/plainport/.git", staged: true });
  expect(argv).toEqual([
    "docker",
    "run",
    "--rm",
    "-v",
    "/wt/task-5:/wt/task-5:ro",
    "-v",
    "/src/plainport/.git:/src/plainport/.git:ro",
    IMAGE,
    "git",
    "--staged",
    "--no-banner",
    "--redact",
    "--verbose",
    "/wt/task-5",
  ]);
});

describe("scanVerdict: gitleaks can exit 0 without having scanned anything", () => {
  const ok = "INF 16 commits scanned.\nINF scanned ~296857 bytes (296.86 KB) in 193ms\nINF no leaks found\n";

  test("a clean full scan and a clean staged scan pass", () => {
    expect(scanVerdict({ exitCode: 0, output: ok, staged: false })).toEqual({ ok: true });
    const staged = "INF 0 commits scanned.\nINF scanned ~20 bytes (20 bytes) in 24.8ms\nINF no leaks found\n";
    expect(scanVerdict({ exitCode: 0, output: staged, staged: true })).toEqual({ ok: true });
  });

  test("an ERR line fails the scan even when gitleaks exits 0", () => {
    const output =
      "\u001b[90m9:47PM\u001b[0m \u001b[31mERR\u001b[0m [git] fatal: not a git repository: /x\nINF no leaks found\n";
    const verdict = scanVerdict({ exitCode: 0, output, staged: true });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toContain("fatal: not a git repository");
  });

  test("a full scan that covered 0 commits, or doesn't say, fails", () => {
    for (const output of ["INF 0 commits scanned.\nINF no leaks found\n", "INF no leaks found\n"]) {
      const verdict = scanVerdict({ exitCode: 0, output, staged: false });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.message).toContain("commits");
    }
  });

  test("a non-zero exit fails with its code", () => {
    expect(scanVerdict({ exitCode: 1, output: "WRN leaks found: 1\n", staged: true })).toEqual({
      ok: false,
      exitCode: 1,
      message: "gitleaks exited 1",
    });
  });
});
