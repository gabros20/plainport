// Git facts for the scan (DESIGN.md "Offload process" step 3, "Edge cases → Git state"): dirty and untracked
// files, unpushed commits, stashes, local-only branches and operations in progress, plus the worktree list
// preflight checks. Everything is read through the one runner with an explicit env, in capture mode, so a listing
// is parsed whole or not at all.
//
// plainport's git calls only read. --no-optional-locks (and GIT_OPTIONAL_LOCKS=0) stops `git status` from
// refreshing and rewriting the index, so reading git state never changes the fingerprint. -c core.fsmonitor=false
// keeps git from starting its fsmonitor daemon: a daemon left behind would outlive the call and fail the capture
// (process.output-incomplete), and would hold the folder open. core.untrackedCache=false keeps git from updating
// that cache. git-lfs's clean filter, which `git status` would run on a racily-clean entry and which writes under
// .git/lfs, is switched off (filter.lfs.* empty, not required); a repository's own other filters still run their
// clean command on such entries, which is the one write these calls cannot rule out. The system config
// (/etc/gitconfig, Xcode's, Homebrew's) is not read; the user's own config is.
//
// git runs only when the folder has a .git of its own, and GIT_CEILING_DIRECTORIES stops it at the folder's parent:
// a .git that git cannot use (an empty folder, a broken pointer) is git.failed, never the facts of a repository
// that holds the project. A .git that is not a folder or a regular file (a FIFO, a socket, a device, a dangling
// link) is never opened: it is fs.unreadable, since neither plainport nor git can read a repository from it.

import { dirname, join, resolve } from "node:path";
import { type Failure, fail, finding, ok, type Result, shellWord } from "@plainport/contract";
import { type LinkStat, systemErrorCode } from "../io.ts";
import type { HostPorts } from "../ports/host.ts";
import { capturedOutput, splitRecords } from "../runner/runner.ts";
import type { RunOutcome } from "../runner/types.ts";

export type InProgress = "rebase" | "merge" | "cherry-pick" | "revert" | "bisect";

export interface GitFacts {
  /** The repository's git folder, absolute. */
  gitDir: string;
  /** The checked-out branch; absent when HEAD is detached. */
  branch?: string;
  detached: boolean;
  /** Tracked paths with staged or unstaged changes, conflicts included. */
  dirty: number;
  /** Untracked files, each file in a new folder counted. Ignored files are not counted. */
  untracked: number;
  /** Up to 20 of the dirty and untracked paths, for messages. */
  changed: string[];
  /**
   * Commits on no remote-tracking branch: in total (HEAD included), per local branch that has some, and on a
   * detached HEAD but on no branch.
   */
  unpushed: {
    commits: number;
    /** `remote` is the remote of the branch's upstream; absent for a local-only branch. */
    branches: { name: string; commits: number; remote?: string }[];
    detachedHead: number;
  };
  /** Local branches with no upstream on a remote: none set, gone, or another local branch. */
  localOnly: string[];
  stashes: number;
  inProgress: InProgress[];
  /** The remotes configured, fetched or not. */
  remotes: string[];
  /** Whether any remote-tracking branch has been fetched. */
  remoteBranches: boolean;
}

export interface Worktree {
  /** As git records it, absolute. */
  path: string;
  /** Inside the project folder, so it travels with it. */
  inside: boolean;
  /** Its folder is gone; git would prune it. */
  prunable: boolean;
}

export interface GitContext {
  /** The environment children are given; PATH, HOME, XDG_CONFIG_HOME and TMPDIR are passed on to git. */
  env: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
}

const FLAGS = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "color.ui=false",
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.clean=",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.required=false",
];
const PASSED = ["PATH", "HOME", "XDG_CONFIG_HOME", "TMPDIR"];
const CAPTURE_BYTES = 256 * 1024 * 1024;
/** A gitdir pointer is one line holding a path; anything bigger is left for git to judge, unread. */
const MAX_POINTER_BYTES = 64 * 1024;
const CHANGED_SAMPLE = 20;
const NUL = 0;
const NL = 10;

const gitEnv = (env: GitContext["env"]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of PASSED) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return {
    ...out,
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
  };
};

const said = (outcome: RunOutcome): string => {
  const text = (outcome.stderr.text.trim() || outcome.stdout.text.trim()).split("\n").slice(-3).join(" / ");
  return text === "" ? "" : `: ${text}`;
};

const gitFailed =
  (args: readonly string[], dir: string) =>
  (outcome: RunOutcome): Failure =>
    fail(
      finding("git.failed", {
        message:
          outcome.exitCode === null
            ? `git ${args[0]} in ${dir} was ended by ${outcome.signal}${said(outcome)}`
            : `git ${args[0]} in ${dir} failed with exit code ${outcome.exitCode}${said(outcome)}`,
        paths: [dir],
        fix: "run the same git command in the folder to see what is wrong, fix the repository, then re-run",
      }),
    );

/**
 * Runs one read-only git command in the folder, by its real path; its whole stdout, only when git exited 0. git
 * may not look above the folder for a repository: the ceiling is the real parent.
 */
const git = async (
  host: HostPorts,
  dir: string,
  ctx: GitContext,
  args: readonly string[],
): Promise<Result<Uint8Array>> => {
  let real: string;
  try {
    real = await host.fs.realpath(dir);
  } catch (error) {
    systemErrorCode(error);
    return unreadable(dir, error);
  }
  // The ceiling is a colon-separated list, so a parent path holding ':' cannot be one; without it git could walk
  // up into a repository that holds the project, so git is not run at all (D33).
  const ceiling = dirname(real);
  if (ceiling.includes(":")) {
    return fail(
      finding("git.failed", {
        message: `git was not run in ${dir}: its parent path ${ceiling} contains ':', so git could not be kept from looking above the folder for a repository`,
        paths: [dir],
        fix: "move the project to a path whose folder names have no ':', then re-run",
      }),
    );
  }
  const ran = await host.run({
    command: "git",
    args: [...FLAGS, ...args],
    cwd: real,
    env: { ...gitEnv(ctx.env), GIT_CEILING_DIRECTORIES: ceiling },
    capture: { maxBytes: CAPTURE_BYTES },
    idleTimeoutMs: 120_000,
    timeoutMs: 600_000,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  if (!ran.ok) return ran;
  return capturedOutput(ran.value, gitFailed(args, dir));
};

const decoder = new TextDecoder();
const text = (bytes: Uint8Array): string => decoder.decode(bytes);
const records = (bytes: Uint8Array, separator: number): string[] =>
  splitRecords(bytes, separator)
    .map(text)
    .filter((record) => record !== "");

/**
 * fs.unreadable for a path plainport needed to look at and could not. `blocked` is what to fix: a file that cannot
 * be read (u+r), or, by default, the folder holding the path, which cannot be searched when lstat itself fails
 * (u+rx).
 */
export const unreadable = (
  path: string,
  error: unknown,
  blocked: { path: string; kind: "file" | "folder" } = { path: dirname(path), kind: "folder" },
): Failure =>
  fail(
    finding("fs.unreadable", {
      message: `plainport cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      paths: [blocked.path],
      fix: `chmod ${blocked.kind === "file" ? "u+r" : "u+rx"} ${shellWord(blocked.path)}`,
    }),
  );

/** Whether something is at the path (not followed); a path that cannot be looked at is fs.unreadable. */
export const exists = async (host: HostPorts, path: string): Promise<Result<boolean>> => {
  try {
    await host.fs.lstat(path);
    return ok(true);
  } catch (error) {
    const code = systemErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return ok(false);
    return unreadable(path, error);
  }
};

/** fs.unreadable for a .git that is neither a folder nor a regular file: never opened, so never a repository. */
const notARepository = (path: string, what: string): Failure =>
  fail(
    finding("fs.unreadable", {
      message: `${path} is ${what}, which plainport never opens, and git cannot read a repository from it`,
      paths: [path],
      fix: `remove it (rm ${shellWord(path)}) or move it out of the project, then re-run`,
    }),
  );

/**
 * What .git is in the folder: a folder (a repository), a regular file (a pointer: worktree or submodule), or
 * nothing. A symlink is followed to one of those; a FIFO, socket, device or dangling link is fs.unreadable.
 */
export const dotGit = async (host: HostPorts, dir: string): Promise<Result<"dir" | "file" | "none">> => {
  const path = join(dir, ".git");
  let kind: string;
  try {
    kind = (await host.fs.lstat(path)).kind;
  } catch (error) {
    const code = systemErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return ok("none");
    return unreadable(path, error);
  }
  if (kind === "symlink") {
    try {
      kind = (await host.fs.stat(path)).kind;
    } catch (error) {
      const code = systemErrorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return notARepository(path, "a symlink leading nowhere");
      return unreadable(path, error);
    }
    if (kind === "other") return notARepository(path, "a symlink to a special file");
  }
  if (kind === "dir" || kind === "file") return ok(kind);
  return notARepository(path, `a ${kind === "other" ? "special file" : kind}`);
};

/**
 * Where a .git pointer file points. A small regular file is read and parsed here; anything else (a symlink, a
 * file too big to be a pointer, or one not in `gitdir: <path>` form) is left to git, whose refusal is git.failed.
 */
export const gitPointer = async (host: HostPorts, dir: string, ctx: GitContext): Promise<Result<string>> => {
  const path = join(dir, ".git");
  let stat: LinkStat;
  try {
    stat = await host.fs.lstat(path);
  } catch (error) {
    systemErrorCode(error);
    return unreadable(path, error, { path, kind: "file" });
  }
  if (stat.kind === "file" && stat.size <= MAX_POINTER_BYTES) {
    let content: string;
    try {
      content = await host.fs.readText(path);
    } catch (error) {
      systemErrorCode(error);
      return unreadable(path, error, { path, kind: "file" });
    }
    const pointer = /^gitdir:[ \t]*(\S[^\r\n]*?)[ \t]*$/m.exec(content.split("\n")[0] ?? "")?.[1];
    if (pointer !== undefined && pointer !== "") return ok(pointer);
  }
  const answer = await git(host, dir, ctx, ["rev-parse", "--absolute-git-dir"]);
  return answer.ok ? ok(text(answer.value).trim()) : answer;
};

const IN_PROGRESS: readonly [string, InProgress][] = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
];

/** The operations in progress, from the marker files git leaves in its folder. */
export const inProgress = async (host: HostPorts, gitDir: string): Promise<Result<InProgress[]>> => {
  const found: InProgress[] = [];
  for (const [name, op] of IN_PROGRESS) {
    if (found.includes(op)) continue;
    const there = await exists(host, join(gitDir, name));
    if (!there.ok) return there;
    if (there.value) found.push(op);
  }
  return ok(found);
};

/** The facts for a folder with a .git; undefined when it has none. */
export const gitFacts = async (
  host: HostPorts,
  dir: string,
  ctx: GitContext,
): Promise<Result<GitFacts | undefined>> => {
  const kind = await dotGit(host, dir);
  if (!kind.ok) return kind;
  if (kind.value === "none") return ok(undefined);

  const gitDirOut = await git(host, dir, ctx, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDirOut.ok) return gitDirOut;
  const gitDir = text(gitDirOut.value).trim();

  const status = await git(host, dir, ctx, [
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--show-stash",
    "--untracked-files=all",
  ]);
  if (!status.ok) return status;
  let branch: string | undefined;
  let headOid: string | undefined;
  let stashes = 0;
  let dirty = 0;
  let untracked = 0;
  const changed: string[] = [];
  const note = (path: string) => {
    if (changed.length < CHANGED_SAMPLE) changed.push(path);
  };
  const lines = records(status.value, NUL);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.startsWith("# branch.head ")) {
      const name = line.slice("# branch.head ".length);
      branch = name === "(detached)" ? undefined : name;
    } else if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length);
      headOid = oid === "(initial)" ? undefined : oid;
    } else if (line.startsWith("# stash ")) {
      stashes = Number(line.slice("# stash ".length));
    } else if (line.startsWith("1 ")) {
      dirty++;
      note(line.split(" ").slice(8).join(" "));
    } else if (line.startsWith("2 ")) {
      dirty++;
      note(line.split(" ").slice(9).join(" "));
      i++; // The next record is the path it was renamed or copied from.
    } else if (line.startsWith("u ")) {
      dirty++;
      note(line.split(" ").slice(10).join(" "));
    } else if (line.startsWith("? ")) {
      untracked++;
      note(line.slice(2));
    }
  }

  const refs = await git(host, dir, ctx, [
    "for-each-ref",
    "--format=%(refname)%00%(upstream)%00%(upstream:track)%00%(upstream:remotename)",
    "refs/heads",
    "refs/remotes",
  ]);
  if (!refs.ok) return refs;
  let remoteBranches = false;
  const localOnly: string[] = [];
  const toCount: { name: string; remote?: string }[] = [];
  for (const line of records(refs.value, NL)) {
    const [ref = "", upstream = "", track = "", remoteName = ""] = line.split("\0");
    if (ref.startsWith("refs/remotes/")) {
      remoteBranches = true;
      continue;
    }
    const name = ref.slice("refs/heads/".length);
    // An upstream that is another local branch puts nothing on a remote.
    const remoteUpstream = upstream.startsWith("refs/remotes/") && !track.includes("gone");
    if (!remoteUpstream) localOnly.push(name);
    // A branch level with or behind a remote upstream has every commit on the remote already.
    if (!remoteUpstream) toCount.push({ name });
    else if (track.includes("ahead")) toCount.push({ name, remote: remoteName });
  }

  const remoteList = await git(host, dir, ctx, ["remote"]);
  if (!remoteList.ok) return remoteList;
  const remotes = records(remoteList.value, NL);

  const count = async (revisions: readonly string[]): Promise<Result<number>> => {
    const out = await git(host, dir, ctx, ["rev-list", "--count", ...revisions, "--not", "--remotes", "--"]);
    return out.ok ? ok(Number(text(out.value).trim())) : out;
  };
  const branches: GitFacts["unpushed"]["branches"] = [];
  for (const { name, remote } of toCount) {
    const commits = await count([`refs/heads/${name}`]);
    if (!commits.ok) return commits;
    if (commits.value > 0) branches.push({ name, commits: commits.value, ...(remote ? { remote } : {}) });
  }
  const total = await count([...(headOid === undefined ? [] : ["HEAD"]), "--branches"]);
  if (!total.ok) return total;
  let detachedHead = 0;
  if (branch === undefined && headOid !== undefined) {
    const out = await git(host, dir, ctx, [
      "rev-list",
      "--count",
      "HEAD",
      "--not",
      "--branches",
      "--remotes",
      "--",
    ]);
    if (!out.ok) return out;
    detachedHead = Number(text(out.value).trim());
  }
  const operations = await inProgress(host, gitDir);
  if (!operations.ok) return operations;

  return ok({
    gitDir,
    ...(branch === undefined ? {} : { branch }),
    detached: branch === undefined,
    dirty,
    untracked,
    changed,
    unpushed: { commits: total.value, branches, detachedHead },
    localOnly,
    stashes,
    inProgress: operations.value,
    remotes,
    remoteBranches,
  });
};

/** The repository's linked worktrees (the main one left out). */
export const gitWorktrees = async (
  host: HostPorts,
  dir: string,
  ctx: GitContext,
): Promise<Result<Worktree[]>> => {
  const out = await git(host, dir, ctx, ["worktree", "list", "--porcelain", "-z"]);
  if (!out.ok) return out;
  let real = resolve(dir);
  try {
    real = await host.fs.realpath(dir);
  } catch (error) {
    // A path the file system refuses: compare against the spelling given, which can only count more as outside.
    systemErrorCode(error);
  }
  const roots = [resolve(dir), real];
  const inside = (path: string) => roots.some((root) => path === root || path.startsWith(`${root}/`));
  const worktrees: Worktree[] = [];
  let current: Worktree | undefined;
  // Records are NUL-terminated lines; an empty one ends a worktree.
  for (const line of splitRecords(out.value, NUL).map(text)) {
    if (line.startsWith("worktree ")) {
      const path = line.slice("worktree ".length);
      current = { path, inside: inside(resolve(path)), prunable: false };
      worktrees.push(current);
    } else if (line.startsWith("prunable") && current !== undefined) {
      current.prunable = true;
    }
  }
  return ok(worktrees.slice(1));
};

/**
 * Which of the given paths (relative to the repository's top folder, "/"-separated) git tracks: a path is tracked
 * when it is a tracked file or a folder holding one. Asks the index (`git ls-files`), literally, so a path holding
 * glob characters is never read as a pattern.
 */
export const gitTracked = async (
  host: HostPorts,
  repo: string,
  ctx: GitContext,
  paths: readonly string[],
): Promise<Result<Set<string>>> => {
  const tracked = new Set<string>();
  if (paths.length === 0) return ok(tracked);
  const out = await git(host, repo, ctx, [
    "ls-files",
    "-z",
    "--cached",
    "--",
    ...paths.map((p) => `:(literal)${p}`),
  ]);
  if (!out.ok) return out;
  const wanted = new Set(paths);
  for (const file of records(out.value, NUL)) {
    // The file itself and every folder above it that was asked about.
    for (let at = file; at !== ""; at = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : "") {
      if (wanted.has(at)) tracked.add(at);
    }
  }
  return ok(tracked);
};
