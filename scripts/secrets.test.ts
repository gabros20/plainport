import { expect, test } from "bun:test";
import { IMAGE, scanCommand } from "./secrets.ts";

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
