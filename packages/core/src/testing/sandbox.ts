// A sandboxed home folder for tests: plainport's paths resolved under a fresh temp directory, and small helpers to
// lay out folders, files and git repositories in it. Used only by *.test.ts files; cleanup() removes everything.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type PlainportPaths, resolvePaths } from "../paths.ts";

/**
 * Removes a test folder, also when a detached child of the code under test (an offload's delete) is still writing
 * into it: the removal is repeated until the folder has stayed gone for a whole settle window. Only for tests that
 * start such a child; the wait yields, so in-process work keeps running.
 */
export const removeSettled = async (dir: string, settleMs = 150): Promise<void> => {
  const deadline = Date.now() + 15_000;
  let goneSince: number | undefined;
  while (Date.now() < deadline) {
    if (existsSync(dir)) {
      goneSince = undefined;
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
    if (!existsSync(dir)) {
      goneSince ??= Date.now();
      if (Date.now() - goneSince >= settleMs) return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`could not remove ${dir}`);
};

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
  /** cleanup() for suites that offload: repeats the removal while a detached delete may still write (removeSettled). */
  cleanupSettled(): Promise<void>;
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
    cleanup: () => rmSync(home, { recursive: true, force: true, maxRetries: 3 }),
    cleanupSettled: () => removeSettled(home),
  };
};
