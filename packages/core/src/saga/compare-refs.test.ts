// The theirs refs (compare-refs.ts; M2 Task 26) against real git in temp folders: another copy's HEAD, branches,
// staged index and working tree, written into this repository as sibling refs without leaking an ignored file,
// running a filter, or touching this repository's index, branches, stash, config or status.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "@plainport/contract";
import { InjectedFault } from "../ports/host.ts";
import { type GitFixture, makeGitFixture, QUIET_GIT_ENV } from "../testing/git-fixture.ts";
import { testHost } from "../testing/host.ts";
import {
  buildTheirs,
  type CompareGitContext,
  cleanTheirs,
  readTheirs,
  type TheirsInput,
} from "./compare-refs.ts";

const SNAPSHOT = "01JA0000000000000000000001";
const AT = "2026-10-02T10:00:00.000Z";
const CANARY = "CANARY-7f3e9a1c5b2d4e6f8a0b1c2d3e4f5a6b";

let fx: GitFixture;
let ours: string;
let theirs: string;
let scratch: number;

beforeEach(() => {
  fx = makeGitFixture("plainport-theirs-");
  ours = fx.repo("ours");
  fx.write("ours/.gitignore", ".env\nbuild/\n");
  fx.write("ours/notes.txt", "one\n");
  fx.write("ours/config.local", "mine\n");
  fx.git(ours, "add", ".gitignore", "notes.txt", "config.local");
  fx.git(ours, "commit", "-q", "-m", "second");
  fx.git(fx.root, "clone", "-q", "--no-hardlinks", ours, "theirs");
  theirs = join(fx.root, "theirs");
  scratch = 0;
});

afterEach(() => fx.cleanup());

const ctx = (host = testHost()): CompareGitContext => ({ host, env: { ...fx.env, ...QUIET_GIT_ENV } });

const input = (snapshot = SNAPSHOT): TheirsInput => ({
  repo: ours,
  theirs,
  snapshot,
  at: AT,
  index: join(fx.root, `index-${++scratch}`),
});

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

const refsIn = (repo: string): string[] =>
  fx.git(repo, "for-each-ref", "--format=%(refname)", "refs/plainport").split("\n").filter(Boolean);

const ref = (leaf: string, snapshot = SNAPSHOT) => `refs/plainport/theirs/${snapshot}/${leaf}`;

describe("buildTheirs", () => {
  test("a canary in their .env, a repository clean filter and a tracked file now ignored: nothing leaks", async () => {
    fx.write("theirs/.env", `TOKEN=${CANARY}\n`);
    // A clean filter that would put .env into a tracked blob, and leave a marker, in both repositories' config.
    for (const repo of [ours, theirs]) {
      fx.git(repo, "config", "filter.leak.clean", `sh -c 'cat .env; touch ${join(fx.root, "LEAKED")}'`);
      fx.git(repo, "config", "filter.leak.required", "true");
    }
    fx.write("theirs/.gitattributes", "*.txt filter=leak\n*.local filter=leak\n");
    fx.write("theirs/notes.txt", "one\ntheirs\n");
    // Tracked, now matched by .gitignore, and edited: it stays tracked with their edit.
    fx.write("theirs/.gitignore", ".env\nbuild/\nconfig.local\n");
    fx.write("theirs/config.local", "theirs\n");
    fx.write("theirs/new.txt", "untracked, not ignored\n");
    fx.write("theirs/build/out.js", "ignored output\n");

    const set = value(await buildTheirs(ctx(), input()));

    expect(existsSync(join(fx.root, "LEAKED"))).toBe(false);
    const all = Bun.spawnSync(["git", "cat-file", "--batch-all-objects", "--batch"], {
      cwd: ours,
      env: fx.env,
    });
    expect(all.stdout.toString()).not.toContain(CANARY);
    const tree = fx.git(ours, "ls-tree", "-r", "--name-only", ref("worktree")).split("\n").filter(Boolean);
    expect(tree).toContain("config.local");
    expect(tree).toContain("new.txt");
    expect(tree).not.toContain(".env");
    expect(tree).not.toContain("build/out.js");
    expect(fx.git(ours, "show", `${ref("worktree")}:config.local`)).toBe("theirs\n");
    expect(fx.git(ours, "show", `${ref("worktree")}:notes.txt`)).toBe("one\ntheirs\n");
    // The documented comparison works, and does not record config.local as deleted.
    const diff = fx.git(ours, "diff", "--name-status", "HEAD", ref("worktree"));
    expect(diff).toContain("M\tconfig.local");
    expect(diff).not.toContain("D\tconfig.local");
    // Ignored files that differ are listed: their .env and build/ output, which this copy lacks.
    expect(set.ignored).toEqual([".env", "build/out.js"]);
    expect(set.ignoredTotal).toBe(2);
  });

  test("an ignored file with the same bytes in both copies is not listed; one only here is, as its folder", async () => {
    fx.write("theirs/.env", "SAME=1\n");
    fx.write("ours/.env", "SAME=1\n");
    fx.write("ours/build/a.js", "a\n");
    fx.write("ours/build/b.js", "b\n");
    const set = value(await buildTheirs(ctx(), input()));
    expect(set.ignored).toEqual(["build/"]);
  });

  test("a detached unpushed HEAD is reachable, a staged-only blob shows in index, fsck passes", async () => {
    fx.git(theirs, "checkout", "-q", "--detach");
    fx.write("theirs/notes.txt", "one\ndetached\n");
    fx.git(theirs, "commit", "-q", "-am", "unpushed on a detached HEAD");
    const detachedHead = fx.git(theirs, "rev-parse", "HEAD").trim();
    fx.write("theirs/staged.txt", "staged v1\n");
    fx.git(theirs, "add", "staged.txt");
    fx.write("theirs/staged.txt", "working v2\n");

    const set = value(await buildTheirs(ctx(), input()));

    expect(set.detached).toBe(true);
    expect(set.head).toBe(detachedHead);
    expect(fx.git(ours, "rev-parse", ref("HEAD")).trim()).toBe(detachedHead);
    expect(fx.git(ours, "log", "-1", "--format=%s", ref("HEAD")).trim()).toBe("unpushed on a detached HEAD");
    expect(fx.git(ours, "show", `${ref("index")}:staged.txt`)).toBe("staged v1\n");
    expect(fx.git(ours, "show", `${ref("worktree")}:staged.txt`)).toBe("working v2\n");
    expect(fx.git(ours, "rev-parse", `${ref("worktree")}^`).trim()).toBe(detachedHead);
    expect(fx.git(ours, "rev-parse", `${ref("index")}^`).trim()).toBe(detachedHead);
    expect(fx.gitStatus(ours, "fsck", "--connectivity-only", "--no-dangling")).toBe(0);
  });

  test("an unmerged index gives no index leaf, lists its paths, and still produces worktree", async () => {
    fx.git(theirs, "checkout", "-q", "-b", "side");
    fx.write("theirs/notes.txt", "side\n");
    fx.git(theirs, "commit", "-q", "-am", "side");
    fx.git(theirs, "checkout", "-q", "main");
    fx.write("theirs/notes.txt", "main\n");
    fx.git(theirs, "commit", "-q", "-am", "main");
    expect(fx.gitStatus(theirs, "merge", "-q", "side")).not.toBe(0);

    const set = value(await buildTheirs(ctx(), input()));

    expect(set.index).toBeUndefined();
    expect(set.unmerged).toEqual(["notes.txt"]);
    expect(refsIn(ours)).not.toContain(ref("index"));
    expect(refsIn(ours)).toContain(ref("worktree"));
    expect(fx.git(ours, "show", `${ref("worktree")}:notes.txt`)).toContain("<<<<<<<");
    expect(value(await readTheirs(ctx(), ours))).toEqual([
      expect.objectContaining({ snapshot: SNAPSHOT, complete: true }),
    ]);
  });

  test("all four leaves coexist with branches named index and worktree", async () => {
    fx.git(theirs, "branch", "index");
    fx.git(theirs, "branch", "worktree");
    const set = value(await buildTheirs(ctx(), input()));
    const expected = [
      ref("HEAD"),
      ref("heads/index"),
      ref("heads/main"),
      ref("heads/worktree"),
      ref("index"),
      ref("worktree"),
    ];
    expect(refsIn(ours)).toEqual(expected);
    expect(set.refs).toEqual(expected);
    expect(set.branches).toEqual(["index", "main", "worktree"]);
    expect(refsIn(ours)).not.toContain(`refs/plainport/theirs/${SNAPSHOT}`);
  });

  test("this repository's index bytes, HEAD, branches, stash, config and status are identical", async () => {
    fx.write("ours/notes.txt", "one\nstashed\n");
    fx.git(ours, "stash", "-q");
    fx.write("ours/notes.txt", "one\nstaged\n");
    fx.git(ours, "add", "notes.txt");
    fx.write("ours/notes.txt", "one\nstaged\nunstaged\n");
    fx.write("ours/untracked.txt", "u\n");
    fx.git(ours, "branch", "feature");
    fx.write("theirs/notes.txt", "theirs\n");
    fx.git(theirs, "commit", "-q", "-am", "theirs");
    const capture = () => ({
      index: readFileSync(join(ours, ".git/index")),
      head: readFileSync(join(ours, ".git/HEAD"), "utf8"),
      refs: fx.git(ours, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/stash"),
      stash: fx.git(ours, "stash", "list"),
      config: readFileSync(join(ours, ".git/config"), "utf8"),
      status: fx.git(ours, "--no-optional-locks", "status", "--porcelain=v2", "--branch"),
    });
    const before = capture();
    value(await buildTheirs(ctx(), input()));
    const after = capture();
    expect(after.index.equals(before.index)).toBe(true);
    expect(after).toEqual(before);
  });

  test("untracked files, symlinks and the executable bit are taken as they are; gitlinks are kept and listed", async () => {
    fx.write("theirs/tool.sh", "#!/bin/sh\n");
    chmodSync(join(theirs, "tool.sh"), 0o755);
    symlinkSync("notes.txt", join(theirs, "link"));
    const head = fx.git(theirs, "rev-parse", "HEAD").trim();
    fx.git(theirs, "update-index", "--add", "--cacheinfo", `160000,${head},vendor/lib`);
    fx.git(theirs, "commit", "-q", "-m", "a gitlink");
    fx.git(fx.root, "init", "-q", join(theirs, "inner"));
    writeFileSync(join(theirs, "inner/file"), "x\n");

    const set = value(await buildTheirs(ctx(), input()));

    const listed = fx.git(ours, "ls-tree", "-r", ref("worktree"));
    expect(listed).toMatch(/^100755 blob [0-9a-f]+\ttool\.sh$/m);
    expect(listed).toMatch(/^120000 blob [0-9a-f]+\tlink$/m);
    expect(listed).toMatch(new RegExp(`^160000 commit ${head}\\tvendor/lib$`, "m"));
    expect(fx.git(ours, "show", `${ref("worktree")}:link`)).toBe("notes.txt");
    expect(set.submodules).toEqual(["vendor/lib"]);
    expect(set.nested).toEqual(["inner"]);
    expect(listed).not.toContain("inner");
    expect(fx.gitStatus(ours, "fsck", "--connectivity-only", "--no-dangling")).toBe(0);
  });

  test("a deleted tracked file is recorded as deleted", async () => {
    // Tracked in the index, gone from the working tree.
    rmSync(join(theirs, "config.local"));
    const set = value(await buildTheirs(ctx(), input()));
    const tree = fx.git(ours, "ls-tree", "-r", "--name-only", ref("worktree")).split("\n");
    expect(tree).not.toContain("config.local");
    expect(fx.git(ours, "ls-tree", "-r", "--name-only", ref("index")).split("\n")).toContain("config.local");
    expect(set.changed).toBe(true);
  });
});

describe("publishing", () => {
  test("a crash before the transaction leaves no new refs; a rerun writes the set", async () => {
    const crashed = buildTheirs(ctx(testHost({ faults: { at: "compare.publish" } })), input());
    await expect(crashed).rejects.toBeInstanceOf(InjectedFault);
    expect(refsIn(ours)).toEqual([]);
    const set = value(await buildTheirs(ctx(), input()));
    expect(set.changed).toBe(true);
    expect(value(await readTheirs(ctx(), ours))).toEqual([
      {
        snapshot: SNAPSHOT,
        leaves: ["HEAD", "heads/main", "index", "worktree"],
        complete: true,
        missing: [],
        extra: [],
      },
    ]);
  });

  test("a set missing a leaf, or holding one it should not, is incomplete; a rerun replaces it whole", async () => {
    value(await buildTheirs(ctx(), input()));
    // As a death inside git's commit can leave it: one leaf not written, and a stale one from an earlier run.
    const main = fx.git(ours, "rev-parse", ref("heads/main")).trim();
    fx.git(ours, "update-ref", "-d", ref("heads/main"));
    fx.git(ours, "update-ref", ref("heads/old"), main);
    expect(value(await readTheirs(ctx(), ours))).toEqual([
      {
        snapshot: SNAPSHOT,
        leaves: ["HEAD", "heads/old", "index", "worktree"],
        complete: false,
        missing: ["heads/main"],
        extra: ["heads/old"],
      },
    ]);
    const set = value(await buildTheirs(ctx(), input()));
    expect(set.changed).toBe(true);
    expect(refsIn(ours)).toEqual([ref("HEAD"), ref("heads/main"), ref("index"), ref("worktree")]);
    expect(value(await readTheirs(ctx(), ours))[0]?.complete).toBe(true);
  });

  test("a set whose worktree leaf is missing is incomplete", async () => {
    value(await buildTheirs(ctx(), input()));
    fx.git(ours, "update-ref", "-d", ref("worktree"));
    expect(value(await readTheirs(ctx(), ours))).toEqual([
      expect.objectContaining({ complete: false, missing: ["worktree"] }),
    ]);
  });

  test("a rerun with no change is a no-op", async () => {
    value(await buildTheirs(ctx(), input()));
    const before = fx.git(ours, "for-each-ref", "--format=%(objectname) %(refname)", "refs/plainport");
    const again = value(await buildTheirs(ctx(), input()));
    expect(again.changed).toBe(false);
    expect(fx.git(ours, "for-each-ref", "--format=%(objectname) %(refname)", "refs/plainport")).toBe(before);
  });

  test("a rerun after their copy changed updates the leaves that moved and removes those gone", async () => {
    fx.git(theirs, "branch", "gone");
    value(await buildTheirs(ctx(), input()));
    fx.git(theirs, "branch", "-D", "gone");
    fx.write("theirs/notes.txt", "later\n");
    const set = value(await buildTheirs(ctx(), input()));
    expect(set.changed).toBe(true);
    expect(refsIn(ours)).not.toContain(ref("heads/gone"));
    expect(fx.git(ours, "show", `${ref("worktree")}:notes.txt`)).toBe("later\n");
  });

  test("sets of two snapshots coexist", async () => {
    const other = "01JA0000000000000000000002";
    value(await buildTheirs(ctx(), input()));
    value(await buildTheirs(ctx(), input(other)));
    expect(value(await readTheirs(ctx(), ours)).map((s) => [s.snapshot, s.complete])).toEqual([
      [SNAPSHOT, true],
      [other, true],
    ]);
  });
});

describe("cleanTheirs", () => {
  test("removes only refs/plainport/theirs/**", async () => {
    value(await buildTheirs(ctx(), input()));
    const head = fx.git(ours, "rev-parse", "HEAD").trim();
    fx.git(ours, "update-ref", "refs/plainport/mine", head);
    const removed = value(await cleanTheirs(ctx(), ours));
    expect(removed).toEqual([ref("HEAD"), ref("heads/main"), ref("index"), ref("worktree")]);
    expect(refsIn(ours)).toEqual(["refs/plainport/mine"]);
    expect(fx.git(ours, "rev-parse", "main").trim()).toBe(head);
    expect(value(await cleanTheirs(ctx(), ours))).toEqual([]);
  });
});
