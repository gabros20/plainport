// Preflight (DESIGN.md "Offload process" step 2, "Edge cases"): turns what the host, git and the scan found into
// findings with stable codes. preflight() runs the checks that come before the scan: git's lock and worktrees,
// processes using the folder, containers mounting it, placeholder files. scanFindings() reads the scan's own
// results: unreadable files, links leading outside, unpushed work and git operations in progress.
//
// Nothing here changes anything: git's fsmonitor daemon, which DESIGN says is stopped rather than blocking, is only
// reported (fsmonitor) for the offload saga to stop.

import { join } from "node:path";
import { type Failure, type Finding, finding, ok, type Result } from "@plainport/contract";
import { errorCode } from "../io.ts";
import type { CheckContext, HostChecks, ProcessUse } from "../ports/checks.ts";
import type { HostPorts } from "../ports/host.ts";
import { dotGit, gitWorktrees } from "../scan/git.ts";
import type { ProjectScan } from "../scan/index.ts";

export interface PreflightReport {
  /** Blockers and warnings, in check order. */
  findings: Finding[];
  /** Said in passing, never a finding: docker not installed or not running, a pruned worktree. */
  notes: string[];
  /** Pids of git fsmonitor daemons watching the folder: stopped before the snapshot, never a blocker. */
  fsmonitor: number[];
}

/** At most this many paths go into a finding; its message gives the full count. */
const MAX_PATHS = 100;
const FSMONITOR_IPC = "/.git/fsmonitor--daemon.ipc";

const capped = (paths: readonly string[]): string[] => paths.slice(0, MAX_PATHS);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const andList = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const named = (p: ProcessUse): string => `${p.command} (${p.pid})`;

const exists = async (host: HostPorts, path: string): Promise<boolean> => {
  try {
    await host.fs.lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return false;
    throw error;
  }
};

const gitChecks = async (
  host: HostPorts,
  dir: string,
  ctx: CheckContext,
  report: PreflightReport,
): Promise<Failure | undefined> => {
  const kind = await dotGit(host, dir);
  if (kind === "none") return undefined;
  if (kind === "file") {
    const pointer = (await host.fs.readText(join(dir, ".git"))).trim().replace(/^gitdir:\s*/, "");
    report.findings.push(
      finding("git.is-worktree", {
        message: `${dir} is a linked git worktree or a submodule's checkout: its .git only points to ${pointer}, which stays behind`,
        paths: [join(dir, ".git")],
        fix: "offload the repository that holds it instead; git worktree list, run here, names it",
      }),
    );
    return undefined;
  }
  const lock = join(dir, ".git", "index.lock");
  if (await exists(host, lock)) {
    report.findings.push(
      finding("git.locked", {
        message: `${lock} exists: a git command is running in the repository, or one crashed`,
        paths: [lock],
        fix: `wait for the git command to finish; if none is running, remove the stale lock: rm ${lock}`,
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
        fix: `commit and push their work, then remove them: ${outside.map((p) => `git worktree remove ${p}`).join(" && ")}`,
      }),
    );
  }
  return undefined;
};

const processFindings = (uses: readonly ProcessUse[], dir: string, report: PreflightReport): void => {
  const others: ProcessUse[] = [];
  for (const use of uses) {
    if (use.files.some((path) => path.endsWith(FSMONITOR_IPC))) report.fsmonitor.push(use.pid);
    else others.push(use);
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
 * The checks before the scan. A check that fails is reported as a blocker under its own code and the others still
 * run, so one run shows every blocker; only a cancellation ends preflight early.
 */
export const preflight = async (
  host: HostPorts,
  checks: HostChecks,
  dir: string,
  ctx: CheckContext,
): Promise<Result<PreflightReport>> => {
  const report: PreflightReport = { findings: [], notes: [], fsmonitor: [] };
  const failed = (failure: Failure): Failure | undefined => {
    if (failure.exitCode === 130) return failure;
    report.findings.push(failure.finding);
    return undefined;
  };

  const git = await gitChecks(host, dir, ctx, report);
  if (git !== undefined && failed(git)) return git;

  const processes = await checks.processesUsing(dir, ctx);
  if (!processes.ok) {
    if (failed(processes)) return processes;
  } else processFindings(processes.value, dir, report);

  const docker = await checks.dockerMounts(dir, ctx);
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
        fix: `stop ${names.length === 1 ? "it" : "them"} first: docker stop ${names.join(" ")}`,
      }),
    );
  }

  const dataless = await checks.dataless(dir, ctx);
  if (!dataless.ok) {
    if (failed(dataless)) return dataless;
  } else if (dataless.value.length > 0) {
    const paths = dataless.value;
    report.findings.push(
      finding("fs.dataless", {
        message: `${plural(paths.length, "file")} in ${dir} ${paths.length === 1 ? "is a placeholder" : "are placeholders"} (iCloud Drive or Dropbox): ${paths.length === 1 ? "its" : "their"} data is not on this disk, and reading ${paths.length === 1 ? "it" : "them"} would download or fail`,
        paths: capped(paths),
        fix: "download them first (in Finder: Download Now, or open each one), then re-run",
      }),
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
      }),
    );
  }

  if (git !== undefined) {
    const { unpushed, stashes } = git;
    const stashText = plural(stashes, "stash", "stashes");
    if (!git.remotes && (unpushed.commits > 0 || stashes > 0)) {
      const what = [
        ...(unpushed.commits > 0 ? [plural(unpushed.commits, "commit")] : []),
        ...(stashes > 0 ? [stashText] : []),
      ];
      findings.push(
        finding("git.unpushed", {
          message: `the repository has no remote, so its ${andList(what)} exist only in this folder`,
          fix: "add a remote and push to keep a second copy: git remote add origin <url> && git push -u origin --all",
        }),
      );
    } else if (unpushed.commits > 0 || stashes > 0) {
      const parts: string[] = [];
      if (unpushed.commits > 0) {
        const onBranches = unpushed.branches.map((b) => `${plural(b.commits, "commit")} on ${b.name}`);
        const counted = unpushed.branches.reduce((n, b) => n + b.commits, 0);
        const lead =
          onBranches.length > 0
            ? andList(onBranches)
            : `${plural(unpushed.commits, "commit")} on the detached HEAD`;
        const shown = onBranches.length > 0 ? counted : unpushed.commits;
        const single = onBranches.length <= 1 && shown === 1;
        parts.push(`${lead} ${single ? "is" : "are"} not on any remote`);
      }
      if (stashes > 0) parts.push(`${stashText} ${stashes === 1 ? "exists" : "exist"} only in this folder`);
      findings.push(
        finding("git.unpushed", {
          message: parts.join("; "),
          fix:
            unpushed.commits > 0
              ? "git push"
              : "git stash list shows them; commit and push what you want to keep",
        }),
      );
    }

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
