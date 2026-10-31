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
// 1. Objects. Everything their HEAD and branches reach (rev-list --objects) and every blob their index names, staged-
//    only blobs no commit reaches included, go as one pack from `pack-objects` in their copy into `unpack-objects`
//    here. Nothing is fetched by ref, so no ref appears yet.
// 2. Index. A temporary index (GIT_INDEX_FILE, never this repository's own) is seeded from their index's entries, so
//    staged state and tracked-but-now-ignored files stay tracked. Without unmerged entries its tree is committed for
//    `index`; with them `index` is left out, the unmerged paths are listed, and each one is taken from the working
//    tree in the next step.
// 3. Working tree. Each tracked path, and each untracked one their ignore rules do not ignore, is hashed with
//    `hash-object --no-filters -w` and entered with `update-index --index-info`, so no clean or smudge filter or
//    attribute driver ever runs; the tree is committed for `worktree` with their HEAD as its parent. Gitlinks stay as
//    they are and are listed; ignored files are never committed, and those that differ from this copy are listed.
// 4. Publish. One `update-ref --stdin` transaction (start, each create, update or delete with its expected old
//    value, prepare, commit) writes the whole set and removes the leaves of an earlier run this one did not produce.
//    A crash before it leaves no new ref (only unreachable objects, which git gc prunes). git's files backend can
//    still leave a set partly written when the process dies inside the commit: the worktree commit's message names
//    every leaf of its set with its value, so a set that lacks one, holds another or has no worktree is incomplete,
//    and the next run replaces it whole.
//
// Every git call runs through the one runner with hooks off (core.hooksPath=/dev/null, also for update-ref's
// reference-transaction hook), signing off, core.attributesFile=/dev/null, no system config or attributes, git-lfs's
// filters off, no fsmonitor, no split index, no auto gc, and GIT_CEILING_DIRECTORIES at the folder's parent (D33,
// D34). Their copy is read with GIT_DIR and GIT_WORK_TREE set, so a core.worktree in their config points nowhere else.
// The commits carry plainport as author and committer at the snapshot's time, so a rerun of the same snapshot makes
// the same commits, and a rerun with nothing changed publishes nothing.

import { dirname, join } from "node:path";
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
/** A pack of everything their refs reach is held in memory between the two gits. */
const PACK_BYTES = 2 * 1024 * 1024 * 1024;
const CAPTURE_BYTES = 256 * 1024 * 1024;
const IGNORED_LISTED = 100;
const NUL = 0;
const NL = 10;
const ZERO = "0".repeat(40);
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
      ...call.env,
    },
    capture: { maxBytes: call.maxBytes ?? CAPTURE_BYTES },
    idleTimeoutMs: 600_000,
    timeoutMs: 3_600_000,
    ...(call.stdin === undefined ? {} : { stdin: call.stdin }),
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

/** One index entry, as `ls-files -s` prints it. */
interface IndexEntry {
  mode: string;
  oid: string;
  stage: number;
  path: string;
}

const parseIndex = (bytes: Uint8Array): IndexEntry[] =>
  records(bytes, NUL).map((record) => {
    const tab = record.indexOf("\t");
    const [mode, oid, stage] = record.slice(0, tab).split(" ");
    return { mode: mode as string, oid: oid as string, stage: Number(stage), path: record.slice(tab + 1) };
  });

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

  // Their index, every stage.
  const indexRead = await there(["ls-files", "-s", "-z"]);
  if (!indexRead.ok) return indexRead;
  const entries = parseIndex(indexRead.value);
  const unmerged = [...new Set(entries.filter((e) => e.stage > 0).map((e) => e.path))].sort();
  const staged = entries.filter((e) => e.stage === 0);
  const gitlinks = staged.filter((e) => e.mode === "160000");

  // 1. Objects: what the refs reach, and every blob the index names that their copy holds, as one pack.
  const tips = [...new Set([...(head === undefined ? [] : [head]), ...branches.values()])];
  const wanted: string[] = [];
  const seen = new Set<string>();
  if (tips.length > 0) {
    const reached = await there(["rev-list", "--objects", ...tips]);
    if (!reached.ok) return reached;
    for (const line of lines(reached.value)) {
      const oid = line.split(" ", 1)[0] as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      wanted.push(line);
    }
  }
  const blobs = [...new Set(entries.filter((e) => e.mode !== "160000").map((e) => e.oid))].filter(
    (oid) => !seen.has(oid),
  );
  if (blobs.length > 0) {
    // An entry whose blob their copy lacks (git add -N's empty blob) is not packed; the empty blob is made here.
    const present = await there(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
      stdin: `${blobs.join("\n")}\n`,
    });
    if (!present.ok) return present;
    for (const line of lines(present.value)) {
      const [oid, type] = line.split(" ");
      if (type === "missing" || oid === undefined || seen.has(oid)) continue;
      seen.add(oid);
      wanted.push(oid);
    }
  }
  if (wanted.length > 0) {
    const pack = await there(["pack-objects", "--stdout", "-q"], {
      stdin: `${wanted.join("\n")}\n`,
      maxBytes: PACK_BYTES,
    });
    if (!pack.ok) return pack;
    const unpacked = await here(["unpack-objects", "-q"], { stdin: pack.value });
    if (!unpacked.ok) return unpacked;
  }
  const empty = await here(["hash-object", "-w", "--stdin"], { stdin: "" });
  if (!empty.ok) return empty;

  // 2. The temporary index, seeded from theirs: stage 0 only, so unmerged paths come from the working tree.
  const scratch = { GIT_INDEX_FILE: input.index };
  const identity = {
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_AUTHOR_DATE: gitDate(input.at),
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
    GIT_COMMITTER_DATE: gitDate(input.at),
  };
  if (staged.length > 0) {
    const seeded = await here(["update-index", "-z", "--index-info"], {
      env: scratch,
      stdin: staged.map((e) => `${e.mode} ${e.oid}\t${e.path}\0`).join(""),
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

  // 3. The working tree: every tracked path (unmerged ones included) and every untracked one not ignored.
  const othersRead = await there(["ls-files", "-z", "--others", "--exclude-standard"]);
  if (!othersRead.ok) return othersRead;
  const nested: string[] = [];
  const others: string[] = [];
  for (const path of records(othersRead.value, NUL)) {
    if (path.endsWith("/")) nested.push(path.slice(0, -1));
    else others.push(path);
  }
  const linked = new Set(gitlinks.map((e) => e.path));
  const tracked = new Set([...staged.filter((e) => !linked.has(e.path)).map((e) => e.path), ...unmerged]);
  const removals: string[] = [];
  const files: { path: string; mode: string }[] = [];
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
    if (kind === "file") files.push({ path, mode: mode & 0o100 ? "100755" : "100644" });
    else if (kind === "symlink") links.push({ path, target: await host.fs.readlink(join(S, path)) });
    else if (tracked.has(path)) removals.push(path);
  }
  const info: string[] = removals.map((path) => `0 ${ZERO}\t${path}\0`);
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
