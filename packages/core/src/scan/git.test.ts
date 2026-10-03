import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testHost } from "../../../host-macos/src/testing.ts";
import { type GitFixture, makeGitFixture } from "../testing/git-fixture.ts";
import { type GitFacts, gitFacts } from "./git.ts";
import { scanTree } from "./walk.ts";

const host = testHost();
let fx: GitFixture;

beforeEach(() => {
  fx = makeGitFixture();
});
afterEach(() => fx.cleanup());

const facts = async (dir: string): Promise<GitFacts | undefined> => {
  const result = await gitFacts(host, dir, { env: fx.env });
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

describe("scan: git facts", () => {
  test("a folder without .git has none", async () => {
    const dir = join(fx.root, "plain");
    mkdirSync(dir);
    expect(await facts(dir)).toBeUndefined();
  });

  test("a clean, pushed repository has nothing to report", async () => {
    const dir = fx.repo("web");
    fx.origin(dir);
    expect(await facts(dir)).toEqual({
      gitDir: join(dir, ".git"),
      branch: "main",
      detached: false,
      dirty: 0,
      untracked: 0,
      changed: [],
      unpushed: { commits: 0, branches: [], detachedHead: 0 },
      localOnly: [],
      stashes: 0,
      inProgress: [],
      remotes: ["origin"],
      remoteBranches: true,
    });
  });

  test("dirty and untracked files are counted, staged, unstaged, renamed and new folders alike", async () => {
    const dir = fx.repo("web");
    fx.write(join(dir, "a.txt"), "a\n");
    fx.write(join(dir, "b.txt"), "b\n");
    fx.git(dir, "add", ".");
    fx.git(dir, "commit", "-q", "-m", "two");
    fx.write(join(dir, "README.md"), "changed\n");
    fx.git(dir, "mv", "a.txt", "renamed.txt");
    fx.write(join(dir, "b.txt"), "staged\n");
    fx.git(dir, "add", "b.txt");
    fx.write(join(dir, "new.txt"), "n\n");
    fx.write(join(dir, "newdir/x.txt"), "x\n");
    fx.write(join(dir, "newdir/y.txt"), "y\n");
    const got = await facts(dir);
    expect(got?.dirty).toBe(3);
    // Files, not folders: newdir/ holds two.
    expect(got?.untracked).toBe(3);
    expect(got?.changed.sort()).toEqual([
      "README.md",
      "b.txt",
      "new.txt",
      "newdir/x.txt",
      "newdir/y.txt",
      "renamed.txt",
    ]);
  });

  test("unpushed commits, local-only branches and stashes are found", async () => {
    const dir = fx.repo("web");
    fx.origin(dir);
    fx.write(join(dir, "c1.txt"), "1\n");
    fx.git(dir, "add", ".");
    fx.git(dir, "commit", "-q", "-m", "ahead");
    fx.git(dir, "switch", "-q", "-c", "feature/pricing");
    for (const n of [2, 3]) {
      fx.write(join(dir, `c${n}.txt`), `${n}\n`);
      fx.git(dir, "add", ".");
      fx.git(dir, "commit", "-q", "-m", `c${n}`);
    }
    fx.git(dir, "switch", "-q", "--no-track", "-c", "merged-only", "origin/main");
    fx.git(dir, "switch", "-q", "main");
    fx.write(join(dir, "README.md"), "stash me\n");
    fx.git(dir, "stash", "-q");
    const got = await facts(dir);
    expect(got?.unpushed).toEqual({
      commits: 3,
      branches: [
        { name: "feature/pricing", commits: 3 },
        { name: "main", commits: 1, remote: "origin" },
      ],
      detachedHead: 0,
    });
    expect(got?.localOnly).toEqual(["feature/pricing", "merged-only"]);
    expect(got?.stashes).toBe(1);
    expect(got?.dirty).toBe(0);
  });

  test("without a remote every commit is unpushed", async () => {
    const dir = fx.repo("web");
    const got = await facts(dir);
    expect(got?.remotes).toEqual([]);
    expect(got?.remoteBranches).toBe(false);
    expect(got?.unpushed).toEqual({ commits: 1, branches: [{ name: "main", commits: 1 }], detachedHead: 0 });
    expect(got?.localOnly).toEqual(["main"]);
  });

  test("a detached HEAD's own commits count as unpushed", async () => {
    const dir = fx.repo("web");
    fx.origin(dir);
    fx.git(dir, "switch", "-q", "--detach");
    fx.write(join(dir, "d.txt"), "d\n");
    fx.git(dir, "add", ".");
    fx.git(dir, "commit", "-q", "-m", "detached");
    const got = await facts(dir);
    expect(got?.detached).toBe(true);
    expect(got?.branch).toBeUndefined();
    expect(got?.unpushed.commits).toBe(1);
    expect(got?.unpushed.detachedHead).toBe(1);
  });

  test("a branch whose upstream is another local branch is local-only, and its commits are counted", async () => {
    const dir = fx.repo("web");
    fx.origin(dir);
    fx.git(dir, "switch", "-q", "--track", "-c", "child", "main");
    fx.write(join(dir, "c.txt"), "c\n");
    fx.git(dir, "add", ".");
    fx.git(dir, "commit", "-q", "-m", "child");
    fx.git(dir, "switch", "-q", "--track", "-c", "level", "main");
    const got = await facts(dir);
    expect(got?.localOnly).toEqual(["child", "level"]);
    expect(got?.unpushed.branches).toEqual([{ name: "child", commits: 1 }]);
  });

  test("a configured remote with nothing fetched is still a remote", async () => {
    const dir = fx.repo("web");
    fx.git(dir, "remote", "add", "origin", join(fx.root, "nowhere.git"));
    const got = await facts(dir);
    expect(got?.remotes).toEqual(["origin"]);
    expect(got?.remoteBranches).toBe(false);
  });

  test("a project folder plainport may not read is fs.unreadable, never an exception", async () => {
    const dir = fx.repo("web");
    chmodSync(dir, 0o000);
    try {
      const result = await gitFacts(host, dir, { env: fx.env });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.finding.code).toBe("fs.unreadable");
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test("a merge with conflicts and a bisect are in progress", async () => {
    const dir = fx.repo("web");
    fx.git(dir, "switch", "-q", "-c", "other");
    fx.write(join(dir, "README.md"), "theirs\n");
    fx.git(dir, "commit", "-q", "-am", "theirs");
    fx.git(dir, "switch", "-q", "main");
    fx.write(join(dir, "README.md"), "ours\n");
    fx.git(dir, "commit", "-q", "-am", "ours");
    expect(fx.gitStatus(dir, "merge", "-q", "other")).not.toBe(0);
    fx.git(dir, "bisect", "start");
    const got = await facts(dir);
    expect(got?.inProgress).toEqual(["merge", "bisect"]);
    expect(got?.dirty).toBe(1);
  });

  test("an empty repository with no commits yet", async () => {
    const dir = join(fx.root, "empty");
    mkdirSync(dir);
    fx.git(dir, "init", "-q");
    const got = await facts(dir);
    expect(got).toMatchObject({
      branch: "main",
      detached: false,
      unpushed: { commits: 0, branches: [], detachedHead: 0 },
    });
  });

  test("reading git state writes nothing: the fingerprint is the same before and after", async () => {
    const dir = fx.repo("web");
    // Touch a tracked file without changing it: a plain `git status` would now refresh and rewrite the index.
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(dir, "README.md"), later, later);
    const before = await scanTree(host.fs, dir);
    await facts(dir);
    const after = await scanTree(host.fs, dir);
    expect(before.ok && after.ok).toBe(true);
    if (before.ok && after.ok) expect(after.value.fingerprint).toBe(before.value.fingerprint);
  });

  test("a repository configured for the fsmonitor daemon starts none, so no helper outlives plainport's git", async () => {
    const dir = fx.repo("web");
    fx.git(dir, "config", "core.fsmonitor", "true");
    expect(await facts(dir)).toBeDefined();
    // Exit 1: no daemon is watching the folder.
    expect(fx.gitStatus(dir, "-c", "core.fsmonitor=false", "fsmonitor--daemon", "status")).toBe(1);
  });

  test("a broken repository is git.failed, with git's own message", async () => {
    const dir = fx.repo("web");
    writeFileSync(join(dir, ".git", "HEAD"), "garbage\n");
    const result = await gitFacts(host, dir, { env: fx.env });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.finding.code).toBe("git.failed");
      expect(result.exitCode).toBe(1);
      expect(result.finding.message).toContain("git");
    }
  });
});

describe("scan: git facts fail closed", () => {
  test("a FIFO named .git is not opened: the facts block instead", async () => {
    const dir = join(fx.root, "piped");
    mkdirSync(dir);
    Bun.spawnSync(["/usr/bin/mkfifo", join(dir, ".git")]);
    const result = await gitFacts(host, dir, { env: fx.env });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.finding.code).toBe("fs.unreadable");
  });

  test("a folder with an unusable .git inside another repository is git.failed, never the parent's facts", async () => {
    const parent = fx.repo("parent");
    const dir = join(parent, "sub");
    mkdirSync(join(dir, ".git"), { recursive: true });
    const result = await gitFacts(host, dir, { env: fx.env });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.finding.code).toBe("git.failed");
  });
});
