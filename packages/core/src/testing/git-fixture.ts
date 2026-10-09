// Tiny git repositories for the scan and preflight tests, in a temp folder that cleanup() removes. git runs with a
// sandboxed HOME and no system config, so neither the real home's config nor its identity is read.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface GitFixture {
  /** The temp folder holding everything, symlinks resolved. */
  root: string;
  /** The env for plainport's own git calls: PATH and the sandboxed HOME. */
  env: Record<string, string>;
  /** Runs git in `cwd` (relative to root, or absolute) and returns stdout; throws on a non-zero exit. */
  git(cwd: string, ...args: string[]): string;
  /** Runs git and returns its exit code, for commands expected to fail (a conflicting merge). */
  gitStatus(cwd: string, ...args: string[]): number;
  /** Writes a file (relative to root, or absolute), creating folders. */
  write(path: string, text?: string): string;
  /** A repository with one commit on main (README.md), at root/<name>. */
  repo(name: string): string;
  /** A bare repository at root/<name>.git, added to `repo` as origin, with main pushed and tracked. */
  origin(repo: string, name?: string): string;
  cleanup(): void;
}

/**
 * git's background auto-maintenance and auto-gc never run in a test's repository: they write and remove files
 * (.git/objects/maintenance.lock, packs) under a tree a test walks or compares, at times no test controls (CI flake).
 * Set through the environment, so every git a test starts, and plainport's own git calls under it, see it.
 */
export const QUIET_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};

export const makeGitFixture = (prefix = "plainport-git-"): GitFixture => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(root, ".home");
  mkdirSync(home);
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home };
  const gitEnv = {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    ...QUIET_GIT_ENV,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    LC_ALL: "C",
  };
  const at = (path: string) => (path.startsWith("/") ? path : join(root, path));
  const spawn = (cwd: string, args: string[]) =>
    Bun.spawnSync(["git", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], {
      cwd: at(cwd),
      env: gitEnv,
    });
  const git = (cwd: string, ...args: string[]): string => {
    const ran = spawn(cwd, args);
    if (ran.exitCode !== 0)
      throw new Error(`git ${args.join(" ")} failed (${ran.exitCode}): ${ran.stderr.toString()}`);
    return ran.stdout.toString();
  };
  const write = (path: string, text = ""): string => {
    const full = at(path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
    return full;
  };
  return {
    root,
    env,
    git,
    gitStatus: (cwd, ...args) => spawn(cwd, args).exitCode,
    write,
    repo: (name) => {
      const dir = at(name);
      mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q");
      write(join(dir, "README.md"), "hello\n");
      git(dir, "add", "README.md");
      git(dir, "commit", "-q", "-m", "first");
      return dir;
    },
    origin: (repo, name = "origin") => {
      const bare = join(root, `${name}.git`);
      git(root, "init", "-q", "--bare", bare);
      git(repo, "remote", "add", "origin", bare);
      git(repo, "push", "-q", "-u", "origin", "main");
      return bare;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};
