import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { nodeLocalIo } from "../node-io.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { findProjects, projectAt } from "./boundary.ts";

const io = nodeLocalIo;
let box: Sandbox;
let root: string;

beforeEach(() => {
  box = makeSandbox();
  root = box.dir("work");
});
afterEach(() => box.cleanup());

const found = async (options = {}) =>
  (await findProjects(io, root, options)).map((p) => `${p.path} ${p.marker}`).sort();

describe("roots: project boundaries", () => {
  test("grouping folders are path segments; the outermost marked folder is the project", async () => {
    box.repo("work/clients/acme/web");
    box.repo("work/clients/acme/api");
    box.file("work/clients/globex/site/package.json", "{}");
    box.file("work/tools/cli/Cargo.toml", "");
    box.file("work/py/svc/pyproject.toml", "");
    box.file("work/go/svc/go.mod", "");
    box.file("work/notes/readme.txt", "just a grouping folder");
    expect(await found()).toEqual([
      "clients/acme/api .git",
      "clients/acme/web .git",
      "clients/globex/site package.json",
      "go/svc go.mod",
      "py/svc pyproject.toml",
      "tools/cli Cargo.toml",
    ]);
  });

  test("nested repos and workspace packages belong to the outer project", async () => {
    box.repo("work/mono");
    box.repo("work/mono/vendor/lib");
    box.file("work/mono/packages/ui/package.json", "{}");
    box.file("work/app/package.json", "{}");
    box.repo("work/app/sub");
    expect(await found()).toEqual(["app package.json", "mono .git"]);
  });

  test("a .git directory wins over a marker in the same folder", async () => {
    box.repo("work/web");
    box.file("work/web/package.json", "{}");
    expect(await found()).toEqual(["web .git"]);
  });

  test("a .git file (a linked worktree's pointer) is not a repository", async () => {
    box.file("work/wt/.git", "gitdir: /elsewhere/.git/worktrees/wt\n");
    box.repo("work/wt/inner");
    expect(await found()).toEqual(["wt/inner .git"]);
  });

  test("hidden folders, node_modules and plainport's own folders are skipped; symlinks are not followed", async () => {
    box.repo("work/.cache/thing");
    box.repo("work/node_modules/pkg");
    box.repo("work/.plainport-trash/old");
    const outside = box.repo("elsewhere/linked");
    symlinkSync(join(outside, ".."), join(root, "link"));
    expect(await found()).toEqual([]);
  });

  test("depth limits how far below the root a project may sit; ignore patterns skip folders", async () => {
    box.repo("work/a/b/c/d/deep");
    box.repo("work/archive/old");
    box.repo("work/keep");
    expect(await found({ depth: 3 })).toEqual(["archive/old .git", "keep .git"]);
    expect(await found({ depth: 5 })).toEqual(["a/b/c/d/deep .git", "archive/old .git", "keep .git"]);
    expect(await found({ ignore: ["archive/**"] })).toEqual(["keep .git"]);
  });

  test("projectAt finds the project a path inside a root belongs to", async () => {
    box.repo("work/clients/acme/web");
    box.dir("work/clients/acme/web/src/lib");
    expect(await projectAt(io, root, "clients/acme/web/src/lib")).toEqual({
      path: "clients/acme/web",
      marker: ".git",
    });
    expect(await projectAt(io, root, "clients/acme/web")).toEqual({
      path: "clients/acme/web",
      marker: ".git",
    });
    box.dir("work/plain/folder");
    expect(await projectAt(io, root, "plain/folder")).toBeUndefined();
  });
});
