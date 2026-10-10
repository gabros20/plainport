// Preflight (DESIGN.md "Offload process" step 2, "Edge cases"): turns what the host, git and the scan found into
// findings with stable codes. preflight() runs the checks that come before the scan: git's lock and worktrees,
// processes using the folder, containers mounting it, placeholder files. scanFindings() reads the scan's own
// results: unreadable files, links leading outside, unpushed work and git operations in progress.
//
// Nothing here changes anything: git's fsmonitor daemons, which DESIGN says are stopped rather than blocking (the
// project's own and those of repositories nested inside it), are only reported (fsmonitor, fsmonitorRepos) for the
// planner to stop before it scans (D52).
//
// Every check fails closed: what cannot be shown safe blocks. The placeholder check runs first, and the git checks
// (which read .git and run git, so they would download a placeholder) run only once it has passed with none found.
// The process and container checks read nothing in the folder, so they always run.

import { join, resolve } from "node:path";
import { type Failure, type Finding, fail, finding, ok, type Result, shellWord } from "@plainport/contract";
import { systemErrorCode } from "../io.ts";
import type { CheckContext, HostChecks, ProcessUse } from "../ports/checks.ts";
import type { HostPorts } from "../ports/host.ts";
import type { GitFacts } from "../scan/git.ts";
import { dotGit, exists, gitPointer, gitWorktrees } from "../scan/git.ts";
import type { ProjectScan } from "../scan/index.ts";

export interface PreflightReport {
  /** Blockers and warnings, in check order. */
  findings: Finding[];
  /** Said in passing, never a finding: docker not installed or not running, a pruned worktree. */
  notes: string[];
  /** Pids of git fsmonitor daemons watching the folder or a repository inside it: stopped, never a blocker. */
  fsmonitor: number[];
  /** The repositories those daemons serve (the folder, or one nested in it), each once, as the daemons named them. */
  fsmonitorRepos: string[];
  /**
   * The placeholder check answered, found none, and could search every folder, so reading the folder downloads
   * nothing. The git checks ran only if this holds, and scanProject() refuses to run without it.
   */
  safeToRead: boolean;
}

/** A repository's fsmonitor socket, after the repository's folder. */
const SOCKET_TAIL = "/.git/fsmonitor--daemon.ipc";

/** At most this many paths go into a finding; its message gives the full count. */
const MAX_PATHS = 100;

const capped = (paths: readonly string[]): string[] => paths.slice(0, MAX_PATHS);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const andList = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const named = (p: ProcessUse): string => `${p.command} (${p.pid})`;

const words = (items: readonly string[]): string => items.map(shellWord).join(" ");

const gitChecks = async (
  host: HostPorts,
  dir: string,
  ctx: CheckContext,
  report: PreflightReport,
): Promise<Failure | undefined> => {
  const kind = await dotGit(host, dir);
  if (!kind.ok) return kind;
  if (kind.value === "none") return undefined;
  if (kind.value === "file") {
    const pointer = await gitPointer(host, dir, ctx);
    if (!pointer.ok) return pointer;
    report.findings.push(
      finding("git.is-worktree", {
        message: `${dir} is a linked git worktree or a submodule's checkout: its .git only points to ${pointer.value}, which stays behind`,
        paths: [join(dir, ".git")],
        fix: "offload the repository that holds it instead; git worktree list, run here, names it",
      }),
    );
    return undefined;
  }
  const lock = join(dir, ".git", "index.lock");
  const locked = await exists(host, lock);
  if (!locked.ok) return locked;
  if (locked.value) {
    report.findings.push(
      finding("git.locked", {
        message: `${lock} exists: a git command is running in the repository, or one crashed`,
        paths: [lock],
        fix: `wait for the git command to finish; if none is running, remove the stale lock: rm ${shellWord(lock)}`,
      }),
    );
  }
  const worktrees = await gitWorktrees(host, dir, ctx);
  if (!worktrees.ok) return worktrees;
  for (const worktree of worktrees.value) {
    if (worktree.prunable)
      report.notes.push(`worktree ${worktree.path} no longer exists; git worktree prune forgets it`);
  }
  const outside = worktrees.value.filter((w) => !w.inside && !w.prunable).map((w) => w.path);
  if (outside.length > 0) {
    report.findings.push(
      finding("git.worktrees", {
        message: `${plural(outside.length, "linked worktree")} of this repository ${outside.length === 1 ? "lives" : "live"} outside the folder and would be orphaned: ${outside.join(", ")}`,
        paths: capped(outside),
        fix: `commit and push their work, then remove them: ${outside.map((p) => `git worktree remove ${shellWord(p)}`).join(" && ")}`,
      }),
    );
  }
  return undefined;
};

const processFindings = (
  uses: readonly ProcessUse[],
  dir: string,
  /**
   * What an fsmonitor daemon may hold open inside the folder, and the repository each path belongs to: a repository's
   * folder and its socket, under each spelling, for the folder's own repository and for repositories nested in it
   * whose socket is really there. A repository without its socket is not in it, so nothing of it is exempt.
   */
  daemonPaths: ReadonlyMap<string, string>,
  report: PreflightReport,
): void => {
  const others: ProcessUse[] = [];
  for (const use of uses) {
    // Exempt only git's fsmonitor daemon (by its command line) for one repository, the folder's own or one nested in
    // it: that repository's socket is a real socket, and the daemon holds nothing inside the folder but the
    // repository's folder (it watches it) and that socket. Anything else, git included, is an ordinary process with
    // files open. `files` is a sample: a process holding more than
    // it lists is not known to hold only the daemon's paths, so it is not exempt either. Only the daemon's own
    // subcommand (`git fsmonitor--daemon run`) counts, not a client (`… status`) or a git given the word as an
    // argument; and the exemption covers what the daemon holds, never its working directory.
    const daemon = use.command === "git" && /^\S*git\s+fsmonitor--daemon\s+run(\s|$)/.test(use.args ?? "");
    const repos = new Set(use.files.map((path) => daemonPaths.get(path)));
    const [repo] = repos;
    const known = use.fileCount === use.files.length && repos.size === 1 && repo !== undefined;
    if (daemon && known) {
      report.fsmonitor.push(use.pid);
      if (!report.fsmonitorRepos.includes(repo)) report.fsmonitorRepos.push(repo);
      if (use.cwd) others.push({ ...use, files: [], fileCount: 0 });
    } else others.push(use);
  }
  const holding = others.filter((p) => p.fileCount > 0);
  if (holding.length > 0) {
    const files = holding.flatMap((p) => p.files);
    report.findings.push(
      finding("proc.open-files", {
        message: `${andList(holding.map((p) => `${named(p)} holds ${plural(p.fileCount, "file")}`))} open inside ${dir}`,
        paths: capped(files),
        fix: `quit them (the editor, the dev server), or stop them with: kill ${holding.map((p) => p.pid).join(" ")}; then re-run`,
      }),
    );
  }
  const working = others.filter((p) => p.cwd && !p.ancestor);
  if (working.length > 0) {
    report.findings.push(
      finding("proc.cwd", {
        message: `${andList(working.map(named))} ${working.length === 1 ? "is" : "are"} working inside ${dir}`,
        fix: `cd out of the folder in ${working.length === 1 ? "that shell or app" : "those shells or apps"}, or quit ${working.length === 1 ? "it" : "them"}; then re-run`,
      }),
    );
  }
  const own = others.filter((p) => p.cwd && p.ancestor);
  if (own.length > 0) {
    report.findings.push(
      finding("proc.cwd-shell", {
        message: `the shell or agent that started plainport (${andList(own.map(named))}) is working inside ${dir}; it will be left in a folder that no longer exists`,
        fix: "cd .. before running the command again",
      }),
    );
  }
};

/**
 * A host lookup that throws instead of answering (a path the policy refuses, a port's bug) blocks under its check's
 * own code: preflight fails closed and never throws, so an offload never ends with internal.unexpected after its
 * journal began (rule 7). The message carries the error, so a bug is still visible.
 */
const asked = async <T>(
  code: "fs.dataless" | "proc.open-files" | "env.docker-mount" | "git.failed",
  what: string,
  dir: string,
  lookup: () => Promise<Result<T>>,
): Promise<Result<T>> => {
  try {
    return await lookup();
  } catch (error) {
    return fail(
      finding(code, {
        message: `could not check ${what} for ${dir}: ${error instanceof Error ? error.message : String(error)}`,
        paths: [dir],
        fix: `check that plainport can look up ${what} (the message names what failed), then re-run`,
      }),
    );
  }
};

/**
 * The checks before the scan. A check that fails is reported as a blocker under its own code and the others still
 * run, so one run shows every blocker; only a cancellation ends preflight early. The one exception is git, which
 * is checked only once the folder is known to hold no placeholder, since reading .git could download one.
 */
export const preflight = async (
  host: HostPorts,
  checks: HostChecks,
  dir: string,
  ctx: CheckContext,
): Promise<Result<PreflightReport>> => {
  const report: PreflightReport = {
    findings: [],
    notes: [],
    fsmonitor: [],
    fsmonitorRepos: [],
    safeToRead: false,
  };
  const failed = (failure: Failure): Failure | undefined => {
    if (failure.exitCode === 130) return failure;
    report.findings.push(failure.finding);
    return undefined;
  };

  const dataless = await asked("fs.dataless", "placeholder files", dir, () => checks.dataless(dir, ctx));
  if (!dataless.ok) {
    if (failed(dataless)) return dataless;
  } else {
    const { placeholders, unsearchable } = dataless.value;
    if (placeholders.length > 0) {
      report.findings.push(
        finding("fs.dataless", {
          message: `${plural(placeholders.length, "file")} in ${dir} ${placeholders.length === 1 ? "is a placeholder" : "are placeholders"} (iCloud Drive or Dropbox): ${placeholders.length === 1 ? "its" : "their"} data is not on this disk, and reading ${placeholders.length === 1 ? "it" : "them"} would download or fail`,
          paths: capped(placeholders),
          fix: "download them first (in Finder: Download Now, or open each one), then re-run",
        }),
      );
    }
    if (unsearchable.length > 0) {
      const paths = unsearchable.map((p) => join(dir, p));
      report.findings.push(
        finding("fs.unreadable", {
          message: `plainport cannot search ${plural(paths.length, "folder")} in ${dir}, so what ${paths.length === 1 ? "it holds" : "they hold"} is unknown: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", …" : ""}`,
          paths: capped(paths),
          fix: `chmod u+rx ${words(paths)}`,
        }),
      );
    }
    report.safeToRead = placeholders.length === 0 && unsearchable.length === 0;
  }

  const processes = await asked("proc.open-files", "the processes using the folder", dir, () =>
    checks.processesUsing(dir, ctx),
  );
  if (!processes.ok) {
    if (failed(processes)) return processes;
  } else {
    // Sockets are looked up inside .git only once the folder is known safe to read; otherwise nothing is exempt,
    // which can only add blockers. The candidates are the folder's own repository and every repository a daemon's
    // listed paths point at inside the folder (its socket, or the folder it watches).
    const daemonPaths = new Map<string, string>();
    if (report.safeToRead) {
      const spellings = [resolve(dir)];
      try {
        spellings.push(await host.fs.realpath(dir));
      } catch (error) {
        // The spelling given is all there is: fewer paths are exempt, never more.
        systemErrorCode(error);
      }
      const spelledBy = (path: string) => spellings.find((s) => path === s || path.startsWith(`${s}/`));
      const inside = (path: string) => spelledBy(path) !== undefined;
      /** One name per repository, under the folder's spelling as given, whichever spelling a path used. */
      const canonical = (repo: string) => {
        const spelling = spelledBy(repo) ?? (spellings[0] as string);
        return `${spellings[0]}${repo.slice(spelling.length)}`;
      };
      const candidates = new Set(spellings);
      for (const use of processes.value)
        for (const path of use.files) {
          const repo = path.endsWith(SOCKET_TAIL) ? path.slice(0, -SOCKET_TAIL.length) : path;
          if (inside(repo)) candidates.add(repo);
        }
      for (const repo of candidates) {
        const socket = `${repo}${SOCKET_TAIL}`;
        try {
          if ((await host.fs.lstat(socket)).kind === "socket")
            daemonPaths.set(socket, canonical(repo)).set(repo, canonical(repo));
        } catch (error) {
          // No socket there, or none that can be looked at: nothing of that repository is exempt.
          systemErrorCode(error);
        }
      }
    }
    processFindings(processes.value, dir, daemonPaths, report);
  }

  const docker = await asked("env.docker-mount", "the containers mounting the folder", dir, () =>
    checks.dockerMounts(dir, ctx),
  );
  if (!docker.ok) {
    if (failed(docker)) return docker;
  } else if (!docker.value.available) {
    report.notes.push(`${docker.value.reason}, so no container can mount the folder`);
  } else if (docker.value.mounts.length > 0) {
    const { mounts } = docker.value;
    const names = [...new Set(mounts.map((m) => m.name))];
    report.findings.push(
      finding("env.docker-mount", {
        message: `${plural(names.length, "running container")} bind-${names.length === 1 ? "mounts" : "mount"} ${dir}: ${mounts.map((m) => `${m.name} (${m.source})`).join(", ")}`,
        paths: capped([...new Set(mounts.map((m) => m.source))]),
        fix: `stop ${names.length === 1 ? "it" : "them"} first: docker stop ${words(names)}`,
      }),
    );
  }

  if (report.safeToRead) {
    const git = await asked("git.failed", "the repository's state", dir, async () =>
      ok(await gitChecks(host, dir, ctx, report)),
    );
    const problem = git.ok ? git.value : git;
    if (problem !== undefined && failed(problem)) return problem;
  } else {
    report.notes.push(
      "git was not checked: the placeholder check must pass first, since reading .git could download one",
    );
  }

  return ok(report);
};

const IN_PROGRESS_NAMES: Readonly<Record<string, string>> = {
  rebase: "a rebase",
  merge: "a merge",
  "cherry-pick": "a cherry-pick",
  revert: "a revert",
  bisect: "a bisect",
};

/** How many tags the message names, and how many the finding lists as paths (the rest are counted). */
const TAGS_NAMED = 5;
const TAG_PATHS = 100;

/** The steps a push of the branches leaves undone: commits on a detached HEAD and stashes each need one of their own. */
const unpushedBesides = (git: GitFacts): string[] => {
  const { unpushed, stashes } = git;
  return [
    ...(unpushed.detachedHead > 0
      ? [
          `git switch -c <branch> to keep the ${plural(unpushed.detachedHead, "detached commit")}, then push it`,
        ]
      : []),
    ...(stashes > 0
      ? [
          `git stash list shows the ${plural(stashes, "stash", "stashes")}; keep each as a branch (git stash branch <name> stash@{0}) and push it, or drop it`,
        ]
      : []),
  ];
};

/**
 * git.unpushed for a repository with work on no remote: with no remote at all, with a remote never fetched, or
 * with commits, local-only branches or stashes a remote does not have. undefined when everything is on a remote.
 * The fix covers each kind of work the message names.
 */
export const unpushedFinding = (git: GitFacts): Finding | undefined => {
  const { unpushed, stashes, unpushedTags: tags } = git;
  const stashText = plural(stashes, "stash", "stashes");
  const what = [
    ...(unpushed.commits > 0 ? [plural(unpushed.commits, "commit")] : []),
    ...(stashes > 0 ? [stashText] : []),
    ...(tags.length > 0 ? [plural(tags.length, "tag")] : []),
  ];
  /** One commit, stash or tag, and nothing else, takes a singular verb. */
  const one = unpushed.commits + stashes + tags.length === 1;
  const remote = git.remotes[0] ?? "origin";
  const besides = unpushedBesides(git);
  // The tags are the finding's paths, as refs (D69).
  const named = tags.length === 0 ? {} : { paths: tags.slice(0, TAG_PATHS).map((t) => `refs/tags/${t}`) };
  if (git.remotes.length === 0) {
    if (what.length === 0) return undefined;
    return finding("git.unpushed", {
      message: `the repository has no remote, so its ${andList(what)} ${one ? "exists" : "exist"} only in this folder`,
      fix: [
        "add a remote and push to keep a second copy: git remote add origin <url> && git push -u origin --all",
        ...(tags.length > 0 ? ["git push origin --tags"] : []),
        ...besides,
      ].join("; "),
      ...named,
    });
  }
  if (!git.remoteBranches) {
    if (what.length === 0) return undefined;
    return finding("git.unpushed", {
      message: `none of the branches of ${andList(git.remotes)} have been fetched, so its ${andList(what)} ${one ? "is" : "are"} not known to be on a remote`,
      fix: [
        `git fetch ${shellWord(remote)}, then push what is missing: git push -u ${shellWord(remote)} --all`,
        ...(tags.length > 0 ? [`git push ${shellWord(remote)} --tags`] : []),
        ...besides,
      ].join("; "),
      ...named,
    });
  }
  const counted = new Set(unpushed.branches.map((b) => b.name));
  const bare = git.localOnly.filter((name) => !counted.has(name));
  const onCommits = [
    ...unpushed.branches.map((b) => `${plural(b.commits, "commit")} on ${b.name}`),
    ...(unpushed.detachedHead > 0 ? [`${plural(unpushed.detachedHead, "commit")} on the detached HEAD`] : []),
  ];
  const parts: string[] = [];
  if (onCommits.length > 0) {
    const shown = unpushed.branches.reduce((n, b) => n + b.commits, 0) + unpushed.detachedHead;
    parts.push(
      `${andList(onCommits)} ${onCommits.length === 1 && shown === 1 ? "is" : "are"} not on any remote`,
    );
  }
  if (bare.length > 0)
    parts.push(
      `${bare.length === 1 ? "branch" : "branches"} ${andList(bare)} ${bare.length === 1 ? "is" : "are"} on no remote`,
    );
  if (stashes > 0) parts.push(`${stashText} ${stashes === 1 ? "exists" : "exist"} only in this folder`);
  if (tags.length > 0) {
    const shown = tags.slice(0, TAGS_NAMED);
    parts.push(
      `${plural(tags.length, "tag")} (${andList(shown)}${tags.length > shown.length ? ", …" : ""}) ${tags.length === 1 ? "is" : "are"} on no remote`,
    );
  }
  if (parts.length === 0) return undefined;
  const localOnly = new Set(git.localOnly);
  const toTrack = [...unpushed.branches.map((b) => b.name).filter((n) => localOnly.has(n)), ...bare];
  const fixes = [
    ...unpushed.branches
      .filter((b) => !localOnly.has(b.name) && b.remote !== undefined)
      .map((b) => `git push ${shellWord(b.remote as string)} ${shellWord(b.name)}`),
    ...(toTrack.length > 0 ? [`git push -u ${shellWord(remote)} ${words(toTrack)}`] : []),
    ...(tags.length > 0
      ? [
          tags.length > TAGS_NAMED
            ? `git push ${shellWord(remote)} --tags`
            : `git push ${shellWord(remote)} ${words(tags)}`,
        ]
      : []),
    ...besides,
  ];
  return finding("git.unpushed", { message: parts.join("; "), fix: fixes.join("; "), ...named });
};

/** Findings from the scan's results. */
export const scanFindings = (scan: ProjectScan): Finding[] => {
  const findings: Finding[] = [];
  const { tree, git } = scan;

  if (tree.unreadable.length > 0) {
    findings.push(
      finding("fs.unreadable", {
        message: `plainport cannot read ${plural(tree.unreadable.length, "path")} in ${tree.dir}, so a snapshot would be incomplete: ${tree.unreadable.slice(0, 5).join(", ")}${tree.unreadable.length > 5 ? ", …" : ""}`,
        paths: capped(tree.unreadable),
        fix: "make them readable (chmod u+r, or u+rx for a folder), or move them out of the project; then re-run",
      }),
    );
  }

  if (tree.linksOutside.length > 0) {
    findings.push(
      finding("fs.link-outside", {
        message: `${plural(tree.linksOutside.length, "symlink")} ${tree.linksOutside.length === 1 ? "points" : "point"} outside the project; the ${tree.linksOutside.length === 1 ? "link is" : "links are"} stored, the ${tree.linksOutside.length === 1 ? "target is" : "targets are"} not: ${tree.linksOutside
          .slice(0, 5)
          .map((l) => `${l.path} -> ${l.target}`)
          .join(", ")}`,
        paths: capped(tree.linksOutside.map((l) => l.path)),
        fix: "nothing to do if the targets exist wherever the project lands; otherwise copy the targets into the project and point the links at the copies",
      }),
    );
  }

  if (git !== undefined) {
    const unpushed = unpushedFinding(git);
    if (unpushed !== undefined) findings.push(unpushed);

    if (git.inProgress.length > 0) {
      const ops = git.inProgress.map((op) => IN_PROGRESS_NAMES[op] ?? op);
      findings.push(
        finding("git.in-progress", {
          message: `${andList(ops)} ${ops.length === 1 ? "is" : "are"} in progress in the repository; the snapshot keeps ${ops.length === 1 ? "it" : "them"} exactly as ${ops.length === 1 ? "it is" : "they are"}`,
          fix: "finish or abort it first if you would rather not resume it later (git status says how)",
        }),
      );
    }
  }

  return findings;
};
