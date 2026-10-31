import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { nodeLocalIo } from "../node-io.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { folderSize, rootCandidates } from "./candidates.ts";

let box: Sandbox;

beforeEach(() => {
  box = makeSandbox();
});
afterEach(() => box.cleanup());

describe("roots: init candidates", () => {
  test("a likely folder that is a file or a symlink loop is skipped with a note, never a crash", async () => {
    box.file("code", "not a folder");
    symlinkSync(join(box.home, "work"), join(box.home, "work"));
    box.repo("Projects/x");
    const found = await rootCandidates(nodeLocalIo, box.home);
    expect(found.candidates).toEqual([
      // .git/HEAD's 21 bytes.
      { path: join(box.home, "Projects"), key: "projects", projects: 1, bytes: 21, complete: true },
    ]);
    expect(found.notes.map((n) => n.path).sort()).toEqual([join(box.home, "code"), join(box.home, "work")]);
    for (const note of found.notes) expect(note.reason.length).toBeGreaterThan(0);
  });

  test("a likely folder that does not exist is skipped silently", async () => {
    expect(await rootCandidates(nodeLocalIo, box.home)).toEqual({ candidates: [], notes: [] });
  });

  test("each candidate's size leaves dependency folders out and never follows a symlink (D70)", async () => {
    box.repo("work/web");
    box.file("work/web/src/main.ts", "x".repeat(100));
    box.file("work/web/node_modules/big/index.js", "y".repeat(5000));
    box.file("work/api/.venv/lib/z.py", "z".repeat(5000));
    box.file("work/api/pyproject.toml", "a".repeat(10));
    symlinkSync("/", join(box.home, "work/web/root-link"));
    const found = await rootCandidates(nodeLocalIo, box.home);
    expect(found.candidates).toEqual([
      { path: join(box.home, "work"), key: "work", projects: 2, bytes: 21 + 100 + 10, complete: true },
    ]);
  });

  test("a walk that runs out of its two-second budget is cut off and says so", async () => {
    box.file("work/a/x", "x".repeat(10));
    box.file("work/b/y", "y".repeat(10));
    let clock = 0;
    const sized = await folderSize(nodeLocalIo, join(box.home, "work"), {
      budgetMs: 2_000,
      now: () => {
        clock += 1_500;
        return clock;
      },
    });
    expect(sized.complete).toBe(false);
    expect(sized.bytes).toBeLessThan(20);
  });
});
