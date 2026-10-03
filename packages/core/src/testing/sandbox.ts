// A sandboxed home folder for tests: plainport's paths resolved under a fresh temp directory, and small helpers to
// lay out folders, files and git repositories in it. Used only by *.test.ts files; cleanup() removes everything.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type PlainportPaths, resolvePaths } from "../paths.ts";

export interface Sandbox {
  home: string;
  paths: PlainportPaths;
  /** Creates a folder under home (and its parents); returns its absolute path. */
  dir(relative: string): string;
  /** Writes a file under home (and its parents); returns its absolute path. */
  file(relative: string, text?: string): string;
  /** A folder with a `.git` directory, as `git init` would leave it. */
  repo(relative: string): string;
  cleanup(): void;
}

export const makeSandbox = (prefix = "plainport-roots-"): Sandbox => {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const result = resolvePaths({ HOME: home }, { cwd: home });
  if (!result.ok) throw new Error(result.finding.message);
  const dir = (relative: string): string => {
    const path = join(home, relative);
    mkdirSync(path, { recursive: true });
    return path;
  };
  const file = (relative: string, text = ""): string => {
    const path = join(home, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  return {
    home,
    paths: result.value,
    dir,
    file,
    repo: (relative) => {
      file(join(relative, ".git", "HEAD"), "ref: refs/heads/main\n");
      return join(home, relative);
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
};
