// The theirs refs (DESIGN.md "CLI design" → compare; M2 Task 26, astra R2-4): another copy of the project, restored
// into a staging folder, written into this repository as refs you can diff and cherry-pick from, without touching
// this repository's index, branches, working tree or config, and without running a filter or hook of either copy.
//
//   refs/plainport/theirs/<snapshot>/HEAD       their HEAD commit, detached or not
//   refs/plainport/theirs/<snapshot>/heads/*    their branches
//   refs/plainport/theirs/<snapshot>/index      a commit of their staged index (absent when the index is unmerged)
//   refs/plainport/theirs/<snapshot>/worktree   a commit of their working tree, parent = their HEAD
//
// Sibling leaves only, so every ref coexists with the others (a branch named `index` is heads/index); no ref is named
// refs/plainport/theirs/<snapshot> itself. Objects are built first and the refs published last:
//
// 0. Refusals (compare.unsupported-repo), before anything is written: two object formats (sha1 and sha256), their copy
//    shallow, either a partial clone, their copy with replace refs or a grafts file, or files their index tracks with
//    Git LFS (its pointers and its smudged files would not match, and its contents do not belong in this object store).
// 1. Objects. Everything their HEAD and branches reach and every blob their index names (staged-only blobs no commit
//    reaches included), less what this repository's refs already reach, is packed by `pack-objects --revs` here with
//    their object store as an alternate, into a file in plainport's staging, and that file is fed to `unpack-objects`:
//    the pack is never held in memory. Nothing is fetched by ref, so no ref appears yet.
// 2. Index. A temporary index (GIT_INDEX_FILE, never this repository's own) is seeded from their index's entries, so
//    staged state and tracked-but-now-ignored files stay tracked. Without unmerged entries its tree is committed for
//    `index`; with them `index` is left out, the unmerged paths are listed, and each one is taken from the working
//    tree in the next step.
// 3. Working tree. Each tracked path, and each untracked one their ignore rules do not ignore, is hashed with
//    `hash-object --no-filters -w` and entered with `update-index --index-info`, so no clean or smudge filter or
//    attribute driver ever runs; the tree is committed for `worktree` with their HEAD as its parent. Gitlinks stay as
//    they are and are listed; ignored files are never committed, and those that differ from this copy are listed.
//    Skip-worktree entries (a sparse checkout) keep their index entry, since git does not look for them in the working
//    tree. Intent-to-add entries (git add -N) are no staged content: they are left out of `index` and listed, and
//    their files go into `worktree`. Files that look like secrets (`.env*`, key files) are never hashed into this
//    repository unless their index already holds those exact bytes: untracked ones are left out and listed, and
//    tracked ones whose bytes differ keep their index entry and are listed (`withheld`).
// 4. Publish. One `update-ref --stdin` transaction (start, each create, update or delete with its expected old
//    value, prepare, commit) writes the whole set and removes the leaves of an earlier run this one did not produce.
//    A crash before it leaves no new ref (only unreachable objects, which git gc prunes). git's files backend can
//    still leave a set partly written when the process dies inside the commit: the worktree commit's message names
//    every leaf of its set with its value, so a set that lacks one, holds another or has no worktree is incomplete,
//    and the next run replaces it whole. Before it, `rev-list --objects --quiet <leaves> --not --all` checks that every
//    object the new leaves reach is here, so a ref never points at a history this repository cannot read.
//
// Every git call runs through the one runner with hooks off (core.hooksPath=/dev/null, also for update-ref's
// reference-transaction hook), signing off, core.attributesFile=/dev/null, no system config or attributes, git-lfs's
// filters off, no fsmonitor, no split index, no auto gc, no lazy fetch of a promisor's objects (GIT_NO_LAZY_FETCH), no
// replace refs (GIT_NO_REPLACE_OBJECTS), and GIT_CEILING_DIRECTORIES at the folder's parent (D33, D34). Their copy is read with GIT_DIR and GIT_WORK_TREE set, so a core.worktree in their config points nowhere else.
// The commits carry plainport as author and committer at the snapshot's time, so a rerun of the same snapshot makes
// the same commits, and a rerun with nothing changed publishes nothing.

import { basename, dirname, join } from "node:path";
import { type Failure, fail, finding, ok, type Result, shellWord } from "@plainport/contract";
import { systemErrorCode } from "../io.ts";
import type { Env } from "../paths.ts";
import type { HostPorts } from "../ports/host.ts";
import { capturedOutput, splitRecords } from "../runner/runner.ts";
import type { RunOutcome } from "../runner/types.ts";

export const THEIRS_PREFIX = "refs/plainport/theirs/";

/** The ref of one leaf of a snapshot's set: HEAD, heads/<branch>, index or worktree. */
export const theirsRef = (snapshot: string, leaf: string): string => `${THEIRS_PREFIX}${snapshot}/${leaf}`;

export interface CompareGitContext {
  host: HostPorts;
  /** The environment children are given; PATH, HOME, XDG_CONFIG_HOME and TMPDIR are passed on to git. */
  env: Env;
  signal?: AbortSignal;
}

export interface TheirsInput {
  /** This project's folder: a git repository (its .git a folder, or a file pointing at one). */
  repo: string;
  /** Their copy, restored: a folder whose .git is a folder. */
  theirs: string;
  snapshot: string;
  /** The snapshot's time (ISO): the commits' author and committer date. */
  at: string;
  /** A file path for the temporary index, in plainport's staging; it must not exist yet. */
  index: string;
  /** A folder for the pack, in plainport's staging; made when needed. */
  spool: string;
  /** The project's address, for the fix of a refusal. */
  address: string;
}

export type TheirsSet = {
  snapshot: string;
  /** The refs the set holds now, sorted. */
  refs: string[];
  /** Their HEAD commit; absent when their HEAD has no commit yet. */
  head?: string;
  /** Their HEAD was detached. */
  detached: boolean;
  /** Their branches, short names, sorted. */
  branches: string[];
  /** The commit of their staged index; absent when it is unmerged. */
  index?: string;
  /** The commit of their working tree. */
  worktree: string;
  /** Paths their index holds unmerged, sorted: taken from the working tree for `worktree`. */
  unmerged: string[];
  /** Gitlinks (submodules), kept as their index records them, sorted. */
  submodules: string[];
  /** Untracked repositories inside their copy, not committed, sorted. */
  nested: string[];
  /** Intent-to-add entries (git add -N): not in `index`, their files in `worktree`, sorted. */
  intentToAdd: string[];
  /**
   * Files that look like secrets (`.env*`, key files) in their working tree whose bytes their index does not hold:
   * never committed, listed, sorted.
   */
  withheld: string[];
  /**
   * Ignored files that differ between the two copies (only in one, or other contents; a wholly ignored folder only
   * here as `dir/`): listed, never committed. The first 100, sorted.
   */
  ignored: string[];
  /** How many ignored paths differ in all. */
  ignoredTotal: number;
  /** The transaction changed refs; false when the set was already exactly this. */
  changed: boolean;
};

export type TheirsListed = {
  snapshot: string;
  /** The leaves it holds (HEAD, heads/…, index, worktree), sorted. */
  leaves: string[];
  /** Every leaf it should have holds its value, and it holds no other. */
  complete: boolean;
  /** Leaves its worktree commit names that are missing or hold another value, plus worktree when it is missing. */
  missing: string[];
  /** Leaves its worktree commit does not name. */
  extra: string[];
};

const FLAGS = [
  "--no-optional-locks",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.splitIndex=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
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
const IGNORED_LISTED = 100;
const NUL = 0;
const NL = 10;
/** Git LFS pointer files are small: a version line, an oid and a size (the spec caps them at 1024 bytes). */
const POINTER_MIN = 100;
const POINTER_MAX = 1024;
const POINTER = /^version https:\/\/(git-lfs|hawser)\.github\.com\/spec\/v1\n/;
/** CE_INTENT_TO_ADD in the flags `ls-files --debug` prints. */
const INTENT_TO_ADD = 0x20000000;
/** Names that look like secrets: never hashed into this repository from their working tree. */
const SECRET = /^(\.env.*|.*\.(pem|key|p12|pfx)|id_(rsa|dsa|ecdsa|ed25519)(\..*)?)$/;
const IDENTITY = { name: "plainport", email: "plainport@plainport.invalid" };
const decoder = new TextDecoder();
const text = (bytes: Uint8Array): string => decoder.decode(bytes);
const records = (bytes: Uint8Array, separator: number): string[] =>
  splitRecords(bytes, separator)
    .map(text)
    .filter((record) => record !== "");

const said = (outcome: RunOutcome): string => {
  const out = (outcome.stderr.text.trim() || outcome.stdout.text.trim()).split("\n").slice(-3).join(" / ");
  return out === "" ? "" : `: ${out}`;
};

interface GitCall {
  /** The folder git runs in, by its real path; the ceiling is its parent. */
  cwd: string;
  args: readonly string[];
  /** Added to the environment: GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, the identity. */
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
  /** The child reads its stdin from this file instead (a pack). */
  stdinFile?: string;
  /** An exit code that means "nothing" (rev-parse -q --verify's 1): an empty answer. */
  noneExit?: number;
  maxBytes?: number;
}

const git = async (ctx: CompareGitContext, call: GitCall): Promise<Result<Uint8Array>> => {
  const ceiling = dirname(call.cwd);
  if (ceiling.includes(":")) {
    return fail(
      finding("git.failed", {
        message: `git was not run in ${call.cwd}: its parent path ${ceiling} contains ':', so git could not be kept from looking above the folder for a repository`,
        paths: [call.cwd],
        fix: "move the project to a path whose folder names have no ':', then re-run",
      }),
    );
  }
  const base: Record<string, string> = {};
  for (const name of PASSED) {
    const value = ctx.env[name];
    if (value !== undefined) base[name] = value;
  }
  const ran = await ctx.host.run({
    command: "git",
    args: [...FLAGS, ...call.args],
    cwd: call.cwd,
    env: {
      ...base,
      LC_ALL: "C",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: ceiling,
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      ...call.env,
    },
    capture: { maxBytes: call.maxBytes ?? CAPTURE_BYTES },
    idleTimeoutMs: 600_000,
    timeoutMs: 3_600_000,
    ...(call.stdin === undefined ? {} : { stdin: call.stdin }),
    ...(call.stdinFile === undefined ? {} : { stdinFile: call.stdinFile }),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  if (!ran.ok) return ran;
  if (call.noneExit !== undefined && ran.value.exitCode === call.noneExit && ran.value.signal === null)
    return ok(new Uint8Array());
  return capturedOutput(
    ran.value,
    (outcome): Failure =>
      fail(
        finding("git.failed", {
          message:
            outcome.exitCode === null
              ? `git ${call.args[0]} in ${call.cwd} was ended by ${outcome.signal}${said(outcome)}`
              : `git ${call.args[0]} in ${call.cwd} failed with exit code ${outcome.exitCode}${said(outcome)}`,
          paths: [call.cwd],
          fix: "run the same git command in the folder to see what is wrong, fix the repository, then re-run plainport compare",
        }),
      ),
  );
};

const realOf = async (ctx: CompareGitContext, dir: string): Promise<Result<string>> => {
  try {
    return ok(await ctx.host.fs.realpath(dir));
  } catch (error) {
    return fail(
      finding("fs.unreadable", {
        message: `plainport cannot read ${dir} (${systemErrorCode(error)})`,
        paths: [dir],
        fix: `check that you can read ${shellWord(dir)} and the folder that holds it, then re-run`,
      }),
    );
  }
};

/** One index entry, as `ls-files -s -t` prints it. */
interface IndexEntry {
  /** ls-files -t's tag: S for skip-worktree (a sparse checkout), H for cached, M for unmerged. */
  tag: string;
  mode: string;
  oid: string;
  stage: number;
  path: string;
}

const parseIndex = (bytes: Uint8Array): IndexEntry[] =>
  records(bytes, NUL).map((record) => {
    const tab = record.indexOf("\t");
    const [tag, mode, oid, stage] = record.slice(0, tab).split(" ");
    return {
      tag: tag as string,
      mode: mode as string,
      oid: oid as string,
      stage: Number(stage),
      path: record.slice(tab + 1),
    };
  });

/** The paths `ls-files --debug -z` reports with the intent-to-add flag. */
const intentToAddIn = (bytes: Uint8Array): string[] => {
  // path NUL, then its debug lines, the last "  size: N\tflags: X\n", then the next path NUL.
  const chunks = text(bytes).split("\0");
  const out: string[] = [];
  let path = chunks[0] ?? "";
  for (const chunk of chunks.slice(1)) {
    const match = /\tflags: ([0-9a-f]+)\n/.exec(chunk);
    if (match === null) break;
    if ((Number.parseInt(match[1] as string, 16) & INTENT_TO_ADD) !== 0) out.push(path);
    path = chunk.slice(match.index + match[0].length);
  }
  return out;
};

/** `cat-file --batch` output: each object's bytes, by oid. */
const batchContents = (bytes: Uint8Array): Map<string, Uint8Array> => {
  const out = new Map<string, Uint8Array>();
  let at = 0;
  while (at < bytes.length) {
    const end = bytes.indexOf(NL, at);
    if (end === -1) break;
    const [oid, type, size] = text(bytes.subarray(at, end)).split(" ");
    if (type === "missing" || size === undefined) {
      at = end + 1;
      continue;
    }
    const length = Number(size);
    out.set(oid as string, bytes.subarray(end + 1, end + 1 + length));
    at = end + 1 + length + 1;
  }
  return out;
};

const lines = (bytes: Uint8Array): string[] => records(bytes, NL);

/** The leaf → value map of each snapshot's set in the repository. */
const listSets = async (
  ctx: CompareGitContext,
  repo: string,
  snapshot?: string,
): Promise<Result<Map<string, Map<string, string>>>> => {
  const listed = await git(ctx, {
    cwd: repo,
    args: [
      "for-each-ref",
      "--format=%(objectname) %(refname)",
      snapshot === undefined ? THEIRS_PREFIX : `${THEIRS_PREFIX}${snapshot}/`,
    ],
  });
  if (!listed.ok) return listed;
  const sets = new Map<string, Map<string, string>>();
  for (const line of lines(listed.value)) {
    const space = line.indexOf(" ");
    const ref = line.slice(space + 1);
    const rest = ref.slice(THEIRS_PREFIX.length);
    const slash = rest.indexOf("/");
    // A ref named refs/plainport/theirs/<x> itself is never one of plainport's; it is left alone.
    if (slash === -1) continue;
    const id = rest.slice(0, slash);
    const set = sets.get(id) ?? new Map<string, string>();
    set.set(rest.slice(slash + 1), line.slice(0, space));
    sets.set(id, set);
  }
  return ok(sets);
};

const MANIFEST = /^plainport-leaf: (\S+) ([0-9a-f]{40,64})$/;

/** The leaves a worktree commit says its set has, with their values; undefined when it names none. */
const manifestOf = async (
  ctx: CompareGitContext,
  repo: string,
  worktree: string,
): Promise<Result<Map<string, string> | undefined>> => {
  const shown = await git(ctx, { cwd: repo, args: ["cat-file", "commit", worktree] });
  if (!shown.ok) return shown;
  const message = text(shown.value).split("\n");
  if (!message.some((line) => line.startsWith("plainport-set: "))) return ok(undefined);
  const leaves = new Map<string, string>();
  for (const line of message) {
    const match = MANIFEST.exec(line);
    if (match !== null) leaves.set(match[1] as string, match[2] as string);
  }
  return ok(leaves);
};

const judge = async (
  ctx: CompareGitContext,
  repo: string,
  snapshot: string,
  set: Map<string, string>,
): Promise<Result<TheirsListed>> => {
  const leaves = [...set.keys()].sort();
  const worktree = set.get("worktree");
  if (worktree === undefined)
    return ok({ snapshot, leaves, complete: false, missing: ["worktree"], extra: [] });
  const manifest = await manifestOf(ctx, repo, worktree);
  if (!manifest.ok) return manifest;
  if (manifest.value === undefined)
    return ok({
      snapshot,
      leaves,
      complete: false,
      missing: [],
      extra: leaves.filter((l) => l !== "worktree"),
    });
  const named = manifest.value;
  const missing = [...named].filter(([leaf, oid]) => set.get(leaf) !== oid).map(([leaf]) => leaf);
  const extra = leaves.filter((leaf) => leaf !== "worktree" && !named.has(leaf));
  return ok({
    snapshot,
    leaves,
    complete: missing.length === 0 && extra.length === 0,
    missing: missing.sort(),
    extra,
  });
};

/** Every snapshot's set in the repository at `repo`, and whether each is complete. */
export const readTheirs = async (ctx: CompareGitContext, repo: string): Promise<Result<TheirsListed[]>> => {
  const real = await realOf(ctx, repo);
  if (!real.ok) return real;
  const sets = await listSets(ctx, real.value);
  if (!sets.ok) return sets;
  const out: TheirsListed[] = [];
  for (const [snapshot, set] of [...sets.value].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const judged = await judge(ctx, real.value, snapshot, set);
    if (!judged.ok) return judged;
    out.push(judged.value);
  }
  return ok(out);
};

/** One `update-ref --stdin` transaction; nothing when there is nothing to do. */
const transact = async (ctx: CompareGitContext, repo: string, commands: string[]): Promise<Result<void>> => {
  if (commands.length === 0) return ok(undefined);
  const done = await git(ctx, {
    cwd: repo,
    args: ["update-ref", "--stdin"],
    stdin: ["start", ...commands, "prepare", "commit", ""].join("\n"),
  });
  return done.ok ? ok(undefined) : done;
};

/** Removes every ref under refs/plainport/theirs/ in one transaction, and only those; the refs it removed. */
export const cleanTheirs = async (ctx: CompareGitContext, repo: string): Promise<Result<string[]>> => {
  const real = await realOf(ctx, repo);
  if (!real.ok) return real;
  const listed = await git(ctx, {
    cwd: real.value,
    args: ["for-each-ref", "--format=%(objectname) %(refname)", THEIRS_PREFIX],
  });
  if (!listed.ok) return listed;
  const refs = lines(listed.value).map((line) => {
    const space = line.indexOf(" ");
    return { oid: line.slice(0, space), ref: line.slice(space + 1) };
  });
  const done = await transact(
    ctx,
    real.value,
    refs.map((r) => `delete ${r.ref} ${r.oid}`),
  );
  if (!done.ok) return done;
  return ok(refs.map((r) => r.ref).sort());
};

/** Seconds since the epoch, as git takes a date. */
const gitDate = (at: string): string => `@${Math.floor(Date.parse(at) / 1000)} +0000`;

/** Builds and publishes one snapshot's set; see the file comment. */
export const buildTheirs = async (ctx: CompareGitContext, input: TheirsInput): Promise<Result<TheirsSet>> => {
  const { host } = ctx;
  const repoReal = await realOf(ctx, input.repo);
  if (!repoReal.ok) return repoReal;
  const theirsReal = await realOf(ctx, input.theirs);
  if (!theirsReal.ok) return theirsReal;
  const R = repoReal.value;
  const S = theirsReal.value;
  const there = (args: readonly string[], extra: Omit<GitCall, "cwd" | "args" | "env"> = {}) =>
    git(ctx, { cwd: S, args, env: { GIT_DIR: join(S, ".git"), GIT_WORK_TREE: S }, ...extra });
  const here = (args: readonly string[], extra: Omit<GitCall, "cwd" | "args"> = {}) =>
    git(ctx, { cwd: R, args, ...extra });

  const refuse = (reason: string, paths: readonly string[] = []): Failure =>
    fail(
      finding("compare.unsupported-repo", {
        message: `${reason}, so no refs were written for snapshot ${input.snapshot}`,
        fix: `read the other copy side by side: plainport restore ${shellWord(input.address)} --snapshot ${input.snapshot} --to <path>`,
        paths: paths.length === 0 ? [input.repo] : paths.map((p) => join(input.repo, p)),
      }),
    );

  // 0. What compare cannot carry as refs: refused before anything is written.
  const formats: string[] = [];
  for (const read of [there, here]) {
    const format = await read(["rev-parse", "--show-object-format"]);
    if (!format.ok) return format;
    formats.push(text(format.value).trim() || "sha1");
  }
  const [theirFormat, ourFormat] = formats as [string, string];
  if (theirFormat !== ourFormat)
    return refuse(
      `their copy's repository names objects with ${theirFormat} and this one with ${ourFormat}, and git cannot hold one in the other`,
    );
  const shallow = await there(["rev-parse", "--is-shallow-repository"]);
  if (!shallow.ok) return shallow;
  if (text(shallow.value).trim() === "true")
    return refuse(
      "their copy is a shallow clone: its oldest commits name parents it does not hold, which this repository's git gc, fsck and log --all would then fail on",
    );
  for (const [read, who] of [
    [there, "their copy"],
    [here, "this repository"],
  ] as const) {
    const partial = await read(["config", "--get", "extensions.partialClone"], { noneExit: 1 });
    if (!partial.ok) return partial;
    const remote = text(partial.value).trim();
    if (remote !== "")
      return refuse(
        `${who} is a partial clone (extensions.partialClone = ${remote}): the objects it lacks would be fetched from that remote`,
      );
  }
  const replaced = await there(["for-each-ref", "--count=1", "--format=%(refname)", "refs/replace/"]);
  if (!replaced.ok) return replaced;
  if (text(replaced.value).trim() !== "")
    return refuse("their copy has replace refs (refs/replace/), which change what its history shows");
  try {
    await host.fs.lstat(join(S, ".git", "info", "grafts"));
    return refuse("their copy has a grafts file (.git/info/grafts), which changes what its history shows");
  } catch (error) {
    const code = systemErrorCode(error);
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  const zero = "0".repeat(ourFormat === "sha256" ? 64 : 40);

  // Their HEAD and branches.
  const headRead = await there(["rev-parse", "-q", "--verify", "HEAD^{commit}"], { noneExit: 1 });
  if (!headRead.ok) return headRead;
  const head = text(headRead.value).trim() || undefined;
  const symbolic = await there(["symbolic-ref", "-q", "HEAD"], { noneExit: 1 });
  if (!symbolic.ok) return symbolic;
  const detached = head !== undefined && text(symbolic.value).trim() === "";
  const branchRead = await there([
    "for-each-ref",
    "--format=%(objectname) %(objecttype) %(refname)",
    "refs/heads/",
  ]);
  if (!branchRead.ok) return branchRead;
  const branches = new Map<string, string>();
  for (const line of lines(branchRead.value)) {
    const [oid, type, ref] = line.split(" ");
    if (type === "commit" && ref !== undefined) branches.set(ref.slice("refs/heads/".length), oid as string);
  }

  // Their index, every stage, with ls-files -t's tags.
  const indexRead = await there(["ls-files", "-s", "-t", "-z"]);
  if (!indexRead.ok) return indexRead;
  const entries = parseIndex(indexRead.value);
  const unmerged = [...new Set(entries.filter((e) => e.stage > 0).map((e) => e.path))].sort();
  const staged = entries.filter((e) => e.stage === 0);
  const gitlinks = staged.filter((e) => e.mode === "160000");

  // The blobs their index names: which their copy holds, and which are Git LFS pointers.
  const blobs = [...new Set(entries.filter((e) => e.mode !== "160000").map((e) => e.oid))];
  const held = new Set<string>();
  const small: string[] = [];
  if (blobs.length > 0) {
    // An entry whose blob their copy lacks (git add -N's empty blob) is not packed; the empty blob is made here.
    const present = await there(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
      stdin: `${blobs.join("\n")}\n`,
    });
    if (!present.ok) return present;
    for (const line of lines(present.value)) {
      const [oid, type, size] = line.split(" ");
      if (type !== "blob" || oid === undefined) continue;
      held.add(oid);
      if (Number(size) >= POINTER_MIN && Number(size) < POINTER_MAX) small.push(oid);
    }
  }
  if (small.length > 0) {
    const read = await there(["cat-file", "--batch"], { stdin: `${small.join("\n")}\n` });
    if (!read.ok) return read;
    const pointers = new Set(
      [...batchContents(read.value)].filter(([, bytes]) => POINTER.test(text(bytes))).map(([oid]) => oid),
    );
    const lfs = [...new Set(staged.filter((e) => pointers.has(e.oid)).map((e) => e.path))].sort();
    if (lfs.length > 0)
      return refuse(
        `their copy tracks ${lfs.length} file${lfs.length === 1 ? "" : "s"} with Git LFS (${lfs.slice(0, 5).join(", ")}${lfs.length > 5 ? ", …" : ""}), whose contents compare does not write as refs`,
        lfs.slice(0, 100),
      );
  }

  // Intent-to-add entries hold the empty blob; the flag says which of those are not staged content.
  const empty = await here(["hash-object", "-w", "--stdin"], { stdin: "" });
  if (!empty.ok) return empty;
  const emptyBlob = text(empty.value).trim();
  const emptyPaths = staged.filter((e) => e.oid === emptyBlob).map((e) => e.path);
  let intentToAdd: string[] = [];
  if (emptyPaths.length > 0) {
    const flagged = await git(ctx, {
      cwd: S,
      args: ["ls-files", "--debug", "-z", "--", ...emptyPaths],
      env: { GIT_DIR: join(S, ".git"), GIT_WORK_TREE: S, GIT_LITERAL_PATHSPECS: "1" },
    });
    if (!flagged.ok) return flagged;
    intentToAdd = intentToAddIn(flagged.value).sort();
  }
  const intended = new Set(intentToAdd);

  // 1. Objects: what their refs reach and every blob their index names that their copy holds, less what this
  // repository's refs reach, packed here with their objects as an alternate into a file, then unpacked from it.
  const tips = [...new Set([...(head === undefined ? [] : [head]), ...branches.values()])];
  const wanted = [...tips, ...blobs.filter((oid) => held.has(oid))];
  if (wanted.length > 0) {
    const ours = await here(["for-each-ref", "--format=%(objectname)"]);
    if (!ours.ok) return ours;
    const reached = [...new Set(lines(ours.value))].map((oid) => `^${oid}`);
    await host.fs.mkdirp(input.spool);
    const packed = await here(["pack-objects", "--revs", "-q", join(input.spool, "pack")], {
      env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: join(S, ".git", "objects") },
      stdin: `${[...wanted, ...reached].join("\n")}\n`,
    });
    if (!packed.ok) return packed;
    const unpacked = await here(["unpack-objects", "-q"], {
      stdinFile: join(input.spool, `pack-${text(packed.value).trim()}.pack`),
    });
    if (!unpacked.ok) return unpacked;
  }

  // 2. The temporary index, seeded from theirs: stage 0 only, so unmerged paths come from the working tree, and no
  // intent-to-add entry, which stages nothing.
  const scratch = { GIT_INDEX_FILE: input.index };
  const identity = {
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_AUTHOR_DATE: gitDate(input.at),
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
    GIT_COMMITTER_DATE: gitDate(input.at),
  };
  const seeds = staged.filter((e) => !intended.has(e.path));
  if (seeds.length > 0) {
    const seeded = await here(["update-index", "-z", "--index-info"], {
      env: scratch,
      stdin: seeds.map((e) => `${e.mode} ${e.oid}\t${e.path}\0`).join(""),
    });
    if (!seeded.ok) return seeded;
  }
  const commit = async (message: string): Promise<Result<{ commit: string; tree: string }>> => {
    const tree = await here(["write-tree"], { env: scratch });
    if (!tree.ok) return tree;
    const treeId = text(tree.value).trim();
    const made = await here(
      ["commit-tree", "--no-gpg-sign", treeId, ...(head === undefined ? [] : ["-p", head]), "-F", "-"],
      { env: identity, stdin: message },
    );
    if (!made.ok) return made;
    return ok({ commit: text(made.value).trim(), tree: treeId });
  };
  let index: string | undefined;
  if (unmerged.length === 0) {
    const made = await commit(`plainport compare: the staged index of snapshot ${input.snapshot}\n`);
    if (!made.ok) return made;
    index = made.value.commit;
  }

  // 3. The working tree: every tracked path (unmerged ones included, skip-worktree ones not) and every untracked one
  // not ignored, but no file that looks like a secret whose bytes their index does not hold.
  const othersRead = await there(["ls-files", "-z", "--others", "--exclude-standard"]);
  if (!othersRead.ok) return othersRead;
  const nested: string[] = [];
  const others: string[] = [];
  const withheld: string[] = [];
  for (const path of records(othersRead.value, NUL)) {
    if (path.endsWith("/")) nested.push(path.slice(0, -1));
    else if (SECRET.test(basename(path))) withheld.push(path);
    else others.push(path);
  }
  const linked = new Set(gitlinks.map((e) => e.path));
  const sparse = new Set(staged.filter((e) => e.tag === "S").map((e) => e.path));
  const indexed = new Map(staged.map((e) => [e.path, e.oid]));
  const tracked = new Set([
    ...staged.filter((e) => !linked.has(e.path) && !sparse.has(e.path)).map((e) => e.path),
    ...unmerged,
  ]);
  const removals: string[] = [];
  const files: { path: string; mode: string }[] = [];
  const secrets: { path: string; mode: string }[] = [];
  const links: { path: string; target: string }[] = [];
  for (const path of [...tracked, ...others]) {
    let kind: string | undefined;
    let mode = 0;
    try {
      const stat = await host.fs.lstat(join(S, path));
      kind = stat.kind;
      mode = stat.mode;
    } catch (error) {
      const code = systemErrorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    const file = { path, mode: mode & 0o100 ? "100755" : "100644" };
    if (kind === "file") (SECRET.test(basename(path)) ? secrets : files).push(file);
    else if (kind === "symlink") links.push({ path, target: await host.fs.readlink(join(S, path)) });
    else if (tracked.has(path)) removals.push(path);
  }
  const info: string[] = removals.map((path) => `0 ${zero}\t${path}\0`);
  // A tracked secret-looking file goes in only when its bytes are the ones their index holds (hashed without -w, so
  // nothing is written); otherwise it keeps its index entry, or stays out when it has none, and is listed.
  const plain = secrets.filter((f) => !f.path.includes("\n"));
  if (plain.length > 0) {
    const hashed = await here(["hash-object", "--no-filters", "--stdin-paths"], {
      stdin: `${plain.map((f) => join(S, f.path)).join("\n")}\n`,
    });
    if (!hashed.ok) return hashed;
    const oids = lines(hashed.value);
    plain.forEach((f, i) => {
      if (!intended.has(f.path) && indexed.get(f.path) === oids[i])
        info.push(`${f.mode} ${oids[i]}\t${f.path}\0`);
      else withheld.push(f.path);
    });
  }
  for (const f of secrets.filter((f) => f.path.includes("\n"))) withheld.push(f.path);
  // Paths are hashed by name, one per line; a name holding a newline is read here and hashed from stdin.
  const byName = files.filter((f) => !f.path.includes("\n"));
  if (byName.length > 0) {
    const hashed = await here(["hash-object", "-w", "--no-filters", "--stdin-paths"], {
      stdin: `${byName.map((f) => join(S, f.path)).join("\n")}\n`,
    });
    if (!hashed.ok) return hashed;
    const oids = lines(hashed.value);
    byName.forEach((f, i) => {
      info.push(`${f.mode} ${oids[i]}\t${f.path}\0`);
    });
  }
  for (const f of files.filter((f) => f.path.includes("\n"))) {
    const hashed = await here(["hash-object", "-w", "--no-filters", "--stdin"], {
      stdin: await host.fs.readBytes(join(S, f.path)),
    });
    if (!hashed.ok) return hashed;
    info.push(`${f.mode} ${text(hashed.value).trim()}\t${f.path}\0`);
  }
  for (const l of links) {
    const hashed = await here(["hash-object", "-w", "--no-filters", "--stdin"], { stdin: l.target });
    if (!hashed.ok) return hashed;
    info.push(`120000 ${text(hashed.value).trim()}\t${l.path}\0`);
  }
  if (info.length > 0) {
    const updated = await here(["update-index", "-z", "--index-info"], {
      env: scratch,
      stdin: info.join(""),
    });
    if (!updated.ok) return updated;
  }

  // The set this run publishes; the worktree commit names every other leaf with its value.
  const leaves = new Map<string, string>();
  if (head !== undefined) leaves.set("HEAD", head);
  for (const [name, oid] of branches) leaves.set(`heads/${name}`, oid);
  if (index !== undefined) leaves.set("index", index);
  const manifest = [...leaves].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const worktree = await commit(
    [
      `plainport compare: the working tree of snapshot ${input.snapshot}`,
      "",
      `plainport-set: ${input.snapshot}`,
      ...manifest.map(([leaf, oid]) => `plainport-leaf: ${leaf} ${oid}`),
      ...(unmerged.length === 0 ? [] : [`plainport-unmerged: ${unmerged.length}`]),
      "",
    ].join("\n"),
  );
  if (!worktree.ok) return worktree;
  leaves.set("worktree", worktree.value.commit);

  // 4. Publish, in one transaction, replacing whatever an earlier run left.
  const existing = await listSets(ctx, R, input.snapshot);
  if (!existing.ok) return existing;
  const before = existing.value.get(input.snapshot) ?? new Map<string, string>();
  const commands: string[] = [];
  for (const [leaf, oid] of [...before].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    if (!leaves.has(leaf)) commands.push(`delete ${theirsRef(input.snapshot, leaf)} ${oid}`);
  for (const [leaf, oid] of [...leaves].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const old = before.get(leaf);
    if (old === undefined) commands.push(`create ${theirsRef(input.snapshot, leaf)} ${oid}`);
    else if (old !== oid) commands.push(`update ${theirsRef(input.snapshot, leaf)} ${oid} ${old}`);
  }
  // Every object the new leaves reach is here (fetch's own connectivity check), before any ref points at them.
  const connected = await here([
    "rev-list",
    "--objects",
    "--quiet",
    ...new Set(leaves.values()),
    "--not",
    "--all",
  ]);
  if (!connected.ok)
    return refuse(`this repository would lack objects their history reaches (${connected.finding.message})`);
  host.faultAt("compare.publish");
  const published = await transact(ctx, R, commands);
  if (!published.ok) return published;

  // Ignored files that differ: only in one copy, or with other contents. Listed, never hashed into this repository.
  const ignored = await ignoredDiffering(ctx, R, S, there, here);
  if (!ignored.ok) return ignored;

  return ok({
    snapshot: input.snapshot,
    refs: [...leaves.keys()].map((leaf) => theirsRef(input.snapshot, leaf)).sort(),
    ...(head === undefined ? {} : { head }),
    detached,
    branches: [...branches.keys()].sort(),
    ...(index === undefined ? {} : { index }),
    worktree: worktree.value.commit,
    unmerged,
    submodules: gitlinks.map((e) => e.path).sort(),
    nested: nested.sort(),
    intentToAdd,
    withheld: withheld.sort(),
    ignored: ignored.value.slice(0, IGNORED_LISTED),
    ignoredTotal: ignored.value.length,
    changed: commands.length > 0,
  });
};

/**
 * Ignored files whose copies differ: theirs listed file by file, each compared with this copy's file at the same path
 * (missing, another kind, or other bytes by `hash-object --no-filters` without -w, which writes nothing); and this
 * copy's ignored entries (a wholly ignored folder as one, `dir/`) that are not in theirs at all. Sorted.
 */
const ignoredDiffering = async (
  ctx: CompareGitContext,
  R: string,
  S: string,
  there: (args: readonly string[]) => Promise<Result<Uint8Array>>,
  here: (args: readonly string[], extra?: Omit<GitCall, "cwd" | "args">) => Promise<Result<Uint8Array>>,
): Promise<Result<string[]>> => {
  const kindOf = async (path: string): Promise<{ kind: string; size: number } | undefined> => {
    try {
      const stat = await ctx.host.fs.lstat(path);
      return { kind: stat.kind, size: stat.size };
    } catch (error) {
      const code = systemErrorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw error;
    }
  };
  const theirsRead = await there(["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]);
  if (!theirsRead.ok) return theirsRead;
  const oursRead = await here([
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  if (!oursRead.ok) return oursRead;
  const differ = new Set<string>();
  const compared: string[] = [];
  for (const path of records(theirsRead.value, NUL)) {
    if (path.endsWith("/")) continue;
    const mine = await kindOf(join(R, path));
    const yours = await kindOf(join(S, path));
    if (mine === undefined || yours === undefined || mine.kind !== yours.kind) differ.add(path);
    else if (yours.kind === "symlink") {
      if ((await ctx.host.fs.readlink(join(R, path))) !== (await ctx.host.fs.readlink(join(S, path))))
        differ.add(path);
    } else if (yours.kind === "file") {
      if (mine.size !== yours.size || path.includes("\n")) differ.add(path);
      else compared.push(path);
    }
  }
  if (compared.length > 0) {
    const hashed = await here(["hash-object", "--no-filters", "--stdin-paths"], {
      stdin: `${compared.flatMap((p) => [join(R, p), join(S, p)]).join("\n")}\n`,
    });
    if (!hashed.ok) return hashed;
    const oids = lines(hashed.value);
    compared.forEach((path, i) => {
      if (oids[2 * i] !== oids[2 * i + 1]) differ.add(path);
    });
  }
  for (const path of records(oursRead.value, NUL)) {
    const bare = path.endsWith("/") ? path.slice(0, -1) : path;
    if ((await kindOf(join(S, bare))) === undefined) differ.add(path);
  }
  return ok([...differ].sort());
};
