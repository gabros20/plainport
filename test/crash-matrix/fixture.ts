// The crash matrix's project: a Node project in a git repository with everything plainport must carry and never
// lose (AGENTS.md rule 2): a .env and a local database that git ignores, an untracked file, an uncommitted edit, a
// stash, commits not yet pushed, symlinks (to a file and to a folder), an executable script, and node_modules, the
// one thing it strips. Built once per test file as a template (git is slow to run per row); each row copies it.
// On a case-sensitive volume the copy also gets a case pair (README.md beside readme.md).

import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync as copy,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { makeGitFixture } from "../../packages/core/src/testing/git-fixture.ts";

/** Paths the Node plugin strips from this project (not in the snapshot; regenerable). */
export const STRIPPED = ["node_modules"] as const;

export interface ProjectTemplate {
  /** The project folder to copy. */
  dir: string;
  cleanup(): void;
}

export const makeProjectTemplate = (): ProjectTemplate => {
  const git = makeGitFixture("plainport-crash-template-");
  const dir = git.repo("web");
  git.write(join(dir, ".gitignore"), ".env\nnode_modules/\ndata/\n");
  git.write(join(dir, "package.json"), `${JSON.stringify({ name: "web", private: true })}\n`);
  git.write(join(dir, "package-lock.json"), `${JSON.stringify({ lockfileVersion: 3, packages: {} })}\n`);
  git.write(join(dir, "src/main.ts"), "export const main = 1;\n");
  git.write(join(dir, "bin/run.sh"), "#!/bin/sh\necho run\n");
  chmodSync(join(dir, "bin/run.sh"), 0o755);
  symlinkSync("src/main.ts", join(dir, "main-link"));
  symlinkSync("src", join(dir, "src-link"));
  git.git(dir, "add", "-A");
  git.git(dir, "commit", "-q", "-m", "app");
  git.origin(dir);
  // Committed after the push: unpushed.
  git.write(join(dir, "src/extra.ts"), "export const extra = 2;\n");
  git.git(dir, "add", "src/extra.ts");
  git.git(dir, "commit", "-q", "-m", "unpushed");
  // A stash, then an uncommitted edit on top.
  git.write(join(dir, "README.md"), "hello, stashed\n");
  git.git(dir, "stash", "push", "-q", "-m", "wip");
  git.write(join(dir, "src/main.ts"), "export const main = 1; // edited, not committed\n");
  // Untracked, and ignored but precious.
  git.write(join(dir, "notes/todo.txt"), "untracked notes\n");
  git.write(join(dir, ".env"), "TOKEN=op://vault/item/token\n");
  git.write(join(dir, "data/local.db"), "SQLite format 3\u0000local rows\n");
  // Regenerable: the strip set.
  git.write(join(dir, "node_modules/dep/index.js"), "x".repeat(400));
  git.write(join(dir, "node_modules/dep/package.json"), `${JSON.stringify({ name: "dep" })}\n`);
  // A refreshed index now, so the copies' git status has nothing left to rewrite.
  git.git(dir, "status", "--porcelain");
  return { dir, cleanup: git.cleanup };
};

/** Copies the template's project to `to` (modes, symlinks as links); a case pair too when asked. */
export const copyProject = (template: ProjectTemplate, to: string, options: { casePair?: boolean } = {}) => {
  mkdirSync(dirname(to), { recursive: true });
  copy(template.dir, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  if (options.casePair) {
    mkdirSync(join(to, "docs"), { recursive: true });
    writeFileSync(join(to, "docs/README.md"), "upper\n", { flag: "wx" });
    writeFileSync(join(to, "docs/readme.md"), "lower\n", { flag: "wx" });
  }
};

/** Every entry below a folder, with its bytes' hash (files), its target (links) and its mode: byte identity. */
export type TreeHash = Map<string, string>;

export const hashTree = (dir: string, skip: readonly string[] = []): TreeHash => {
  const out: TreeHash = new Map();
  const walk = (relative: string) => {
    for (const name of readdirSync(relative === "" ? dir : join(dir, relative)).sort()) {
      const path = relative === "" ? name : `${relative}/${name}`;
      if (skip.some((s) => path === s || path.startsWith(`${s}/`))) continue;
      const full = join(dir, path);
      const stat = lstatSync(full);
      const mode = (stat.mode & 0o7777).toString(8);
      if (stat.isSymbolicLink()) out.set(path, `link ${readlinkSync(full)}`);
      else if (stat.isDirectory()) {
        out.set(path, `dir ${mode}`);
        walk(path);
      } else out.set(path, `file ${mode} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  walk("");
  return out;
};

/** The paths whose hash differs between two trees, or that only one has. */
export const treeDiff = (a: TreeHash, b: TreeHash): string[] =>
  [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p)).sort();

export const removeTree = (path: string) => rmSync(path, { recursive: true, force: true });
