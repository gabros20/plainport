import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { nodeLocalIo } from "../node-io.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { rootCandidates } from "./candidates.ts";

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
    expect(found.candidates).toEqual([{ path: join(box.home, "Projects"), key: "projects", projects: 1 }]);
    expect(found.notes.map((n) => n.path).sort()).toEqual([join(box.home, "code"), join(box.home, "work")]);
    for (const note of found.notes) expect(note.reason.length).toBeGreaterThan(0);
  });

  test("a likely folder that does not exist is skipped silently", async () => {
    expect(await rootCandidates(nodeLocalIo, box.home)).toEqual({ candidates: [], notes: [] });
  });
});
