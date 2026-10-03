import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { type Finding, fail, finding, ok } from "@plainport/contract";
import type { HostChecks, ProcessUse } from "../ports/checks.ts";
import type { HostPorts } from "../ports/host.ts";
import type { GitFacts } from "../scan/git.ts";
import { scanProject } from "../scan/index.ts";
import { type GitFixture, makeGitFixture } from "../testing/git-fixture.ts";
import { testHost } from "../testing/host.ts";
import { type PreflightReport, preflight, scanFindings, unpushedFinding } from "./index.ts";

const host = testHost();
let fx: GitFixture;
let servers: Server[] = [];

beforeEach(() => {
  fx = makeGitFixture("plainport-preflight-");
});
afterEach(async () => {
  for (const server of servers) await new Promise((done) => server.close(done));
  servers = [];
  Bun.spawnSync(["/bin/chmod", "-R", "u+rwx", fx.root]);
  fx.cleanup();
});

const quiet: HostChecks = {
  processesUsing: async () => ok([]),
  dataless: async () => found(),
  dockerMounts: async () => ok({ available: true, mounts: [] }),
};

const run = async (dir: string, checks: Partial<HostChecks> = {}): Promise<PreflightReport> => {
  const result = await preflight(host, { ...quiet, ...checks }, dir, { env: fx.env });
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

const codes = (findings: Finding[]) => findings.map((f) => `${f.severity} ${f.code}`);
const found = (...placeholders: string[]) => ok({ placeholders, unsearchable: [] });
const DAEMON = "git fsmonitor--daemon run --detach --ipc-threads=8";

const use = (over: Partial<ProcessUse>): ProcessUse => ({
  pid: 4242,
  ppid: 1,
  command: "node",
  ancestor: false,
  cwd: false,
  files: [],
  fileCount: 0,
  ...over,
});

describe("preflight: a clean folder", () => {
  test("a pushed repository nobody is using has no findings", async () => {
    const dir = fx.repo("web");
    fx.origin(dir);
    expect(await run(dir)).toEqual({ findings: [], notes: [], fsmonitor: [], safeToRead: true });
  });

  test("a folder without git is checked for processes, containers and placeholders only", async () => {
    const dir = join(fx.root, "plain");
    mkdirSync(dir);
    expect((await run(dir)).findings).toEqual([]);
  });
});

describe("preflight: git", () => {
  test("git.locked: .git/index.lock blocks, naming the lock file and how to clear it", async () => {
    const dir = fx.repo("web");
    const lock = fx.write(join(dir, ".git", "index.lock"));
    const [found] = (await run(dir)).findings;
    expect(found).toMatchObject({ code: "git.locked", severity: "block", paths: [lock] });
    expect(found?.fix).toContain(lock);
  });

  test("git.worktrees: a linked worktree elsewhere blocks; one inside the folder or a pruned one does not", async () => {
    const dir = fx.repo("web");
    const elsewhere = join(fx.root, "web-feature");
    fx.git(dir, "worktree", "add", "-q", "-b", "feature", elsewhere);
    fx.git(dir, "worktree", "add", "-q", "-b", "inner", join(dir, ".worktrees", "inner"));
    const gone = join(fx.root, "web-gone");
    fx.git(dir, "worktree", "add", "-q", "-b", "gone", gone);
    rmSync(gone, { recursive: true, force: true });
    const report = await run(dir);
    expect(codes(report.findings)).toEqual(["block git.worktrees"]);
    expect(report.findings[0]?.paths).toEqual([elsewhere]);
    expect(report.notes.join("\n")).toContain(gone);
  });

  test("git.is-worktree: a linked worktree itself blocks: its .git is only a pointer", async () => {
    const dir = fx.repo("web");
    const linked = join(fx.root, "web-feature");
    fx.git(dir, "worktree", "add", "-q", "-b", "feature", linked);
    const report = await run(linked);
    expect(codes(report.findings)).toEqual(["block git.is-worktree"]);
    expect(report.findings[0]?.message).toContain(join(dir, ".git"));
  });
});

describe("preflight: processes", () => {
  test("proc.cwd: another process working inside the folder blocks", async () => {
    const dir = fx.repo("web");
    const report = await run(dir, {
      processesUsing: async () => ok([use({ pid: 501, command: "zsh", cwd: true })]),
    });
    expect(codes(report.findings)).toEqual(["block proc.cwd"]);
    expect(report.findings[0]?.message).toContain("zsh (501)");
  });

  test("proc.cwd-shell: the shell or agent that started plainport only warns, and says cd ..", async () => {
    const dir = fx.repo("web");
    const report = await run(dir, {
      processesUsing: async () => ok([use({ pid: 77, command: "zsh", cwd: true, ancestor: true })]),
    });
    expect(codes(report.findings)).toEqual(["warn proc.cwd-shell"]);
    expect(report.findings[0]?.fix).toContain("cd ..");
  });

  test("proc.open-files: a process holding files open blocks and names them", async () => {
    const dir = fx.repo("web");
    const open = join(dir, "server.log");
    const report = await run(dir, {
      processesUsing: async () =>
        ok([use({ pid: 900, command: "Code Helper", files: [open], fileCount: 1 })]),
    });
    expect(codes(report.findings)).toEqual(["block proc.open-files"]);
    expect(report.findings[0]).toMatchObject({ paths: [open] });
    expect(report.findings[0]?.message).toContain("Code Helper (900)");
  });

  const listen = async (path: string): Promise<void> => {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((done) => server.listen(path, done));
  };

  test("git's fsmonitor daemon is not a blocker: it is listed to be stopped", async () => {
    const dir = fx.repo("web");
    const socket = join(dir, ".git", "fsmonitor--daemon.ipc");
    await listen(socket);
    const report = await run(dir, {
      processesUsing: async () =>
        ok([use({ pid: 321, command: "git", args: DAEMON, files: [socket], fileCount: 1 })]),
    });
    expect(report.findings).toEqual([]);
    expect(report.fsmonitor).toEqual([321]);
  });

  test("the daemon as lsof really shows it, holding the folder it watches, is exempt too", async () => {
    const dir = fx.repo("web");
    await listen(join(dir, ".git", "fsmonitor--daemon.ipc"));
    const report = await run(dir, {
      processesUsing: async () =>
        ok([use({ pid: 322, command: "git", args: DAEMON, files: [dir], fileCount: 1 })]),
    });
    expect(report.findings).toEqual([]);
    expect(report.fsmonitor).toEqual([322]);
  });

  test("the fsmonitor exemption needs git's daemon holding this repository's own socket", async () => {
    const dir = fx.repo("web");
    const socket = join(dir, ".git", "fsmonitor--daemon.ipc");
    const nested = join(dir, "vendor", "lib", ".git", "fsmonitor--daemon.ipc");
    await listen(socket);
    const report = await run(dir, {
      processesUsing: async () =>
        ok([
          use({ pid: 1, command: "node", args: DAEMON, files: [socket], fileCount: 1 }),
          use({ pid: 2, command: "git", args: DAEMON, files: [nested], fileCount: 1 }),
          use({ pid: 3, command: "git", args: `git hash-object ${socket}`, files: [socket], fileCount: 1 }),
          use({ pid: 4, command: "git", files: [socket], fileCount: 1 }),
        ]),
    });
    expect(codes(report.findings)).toEqual(["block proc.open-files"]);
    for (const p of ["node (1)", "git (2)", "git (3)", "git (4)"])
      expect(report.findings[0]?.message).toContain(p);
    expect(report.fsmonitor).toEqual([]);
  });

  test("a plain file at the socket's path is not the daemon's socket, whoever holds it", async () => {
    const dir = fx.repo("web");
    const file = fx.write(join(dir, ".git", "fsmonitor--daemon.ipc"), "not a socket");
    const report = await run(dir, {
      processesUsing: async () =>
        ok([use({ pid: 5, command: "git", args: DAEMON, files: [file], fileCount: 1 })]),
    });
    expect(codes(report.findings)).toEqual(["block proc.open-files"]);
    expect(report.fsmonitor).toEqual([]);
  });
});

describe("preflight: what plainport cannot read", () => {
  test("a project folder plainport may not read is fs.unreadable, and the host checks still run", async () => {
    const dir = fx.repo("web");
    let asked = false;
    chmodSync(dir, 0o000);
    const report = await run(dir, {
      dataless: async () => {
        asked = true;
        return found();
      },
    });
    chmodSync(dir, 0o755);
    expect(codes(report.findings)).toEqual(["block fs.unreadable"]);
    expect(report.findings[0]?.fix).toBe(`chmod u+rx ${dir}`);
    expect(asked).toBe(true);
  });

  test("an unreadable .git pointer file is fs.unreadable", async () => {
    const dir = fx.repo("web");
    const linked = join(fx.root, "web-feature");
    fx.git(dir, "worktree", "add", "-q", "-b", "feature", linked);
    chmodSync(join(linked, ".git"), 0o000);
    const [found] = (await run(linked)).findings;
    expect(found?.code).toBe("fs.unreadable");
    expect(found?.fix).toBe(`chmod u+r ${join(linked, ".git")}`);
  });
});

describe("preflight: fixes are commands that can be pasted", () => {
  test("paths with spaces and quotes are shell-quoted in the fix", async () => {
    const dir = fx.repo("my web's app");
    const lock = fx.write(join(dir, ".git", "index.lock"));
    const elsewhere = join(fx.root, "a tree; rm -rf x");
    fx.git(dir, "worktree", "add", "-q", "-b", "feature", elsewhere);
    const [locked, worktrees] = (await run(dir)).findings;
    expect(locked?.fix).toContain(`rm '${lock.replaceAll("'", "'\\''")}'`);
    expect(worktrees?.fix).toContain(`git worktree remove '${elsewhere}'`);
  });

  test("a container's name in the docker stop fix is quoted too", async () => {
    const dir = fx.repo("web");
    const report = await run(dir, {
      dockerMounts: async () =>
        ok({ available: true, mounts: [{ container: "c1", name: "odd name", source: dir }] }),
    });
    expect(report.findings[0]?.fix).toContain("docker stop 'odd name'");
  });
});

describe("preflight: containers and placeholders", () => {
  test("env.docker-mount: a running container bind-mounting the folder blocks", async () => {
    const dir = fx.repo("web");
    const report = await run(dir, {
      dockerMounts: async () =>
        ok({
          available: true,
          mounts: [{ container: "abc123", name: "web-db-1", source: join(dir, "data") }],
        }),
    });
    expect(codes(report.findings)).toEqual(["block env.docker-mount"]);
    expect(report.findings[0]?.fix).toContain("docker stop web-db-1");
  });

  test("docker absent or not running is a note, not a finding", async () => {
    const dir = fx.repo("web");
    const report = await run(dir, {
      dockerMounts: async () => ok({ available: false, reason: "docker is not installed" }),
    });
    expect(report.findings).toEqual([]);
    expect(report.notes).toEqual(["docker is not installed, so no container can mount the folder"]);
  });

  test("fs.dataless: placeholder files block, named relative to the folder", async () => {
    const dir = fx.repo("web");
    const report = await run(dir, { dataless: async () => found("assets/video.mov") });
    expect(codes(report.findings)).toEqual(["block fs.dataless"]);
    expect(report.findings[0]?.paths).toEqual(["assets/video.mov"]);
  });
});

describe("preflight: a check that cannot answer", () => {
  test("its failure is reported as a blocker, and the other checks still run", async () => {
    const dir = fx.repo("web");
    fx.write(join(dir, ".git", "index.lock"));
    const report = await run(dir, {
      processesUsing: async () =>
        fail(finding("proc.open-files", { message: "could not list open files: lsof failed" })),
      dockerMounts: async () => fail(finding("process.timeout", { message: "docker ran too long" })),
    });
    expect(codes(report.findings)).toEqual([
      "block proc.open-files",
      "block process.timeout",
      "block git.locked",
    ]);
  });

  test("a cancelled check ends preflight as cancelled", async () => {
    const dir = fx.repo("web");
    const result = await preflight(
      host,
      { ...quiet, processesUsing: async () => fail(finding("process.cancelled", { message: "stopped" })) },
      dir,
      { env: fx.env },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.exitCode).toBe(130);
  });
});

describe("preflight: findings from the scan", () => {
  const scanned = async (dir: string) => {
    const result = await scanProject(host, dir, { env: fx.env }, { safeToRead: true });
    if (!result.ok) throw new Error(result.finding.message);
    return scanFindings(result.value);
  };

  test("a clean, pushed repository has none", async () => {
    const dir = fx.repo("web");
    fx.origin(dir);
    expect(await scanned(dir)).toEqual([]);
  });

  test("fs.unreadable blocks, naming the files", async () => {
    const dir = fx.repo("web");
    fx.origin(dir);
    chmodSync(fx.write(join(dir, "secret.pem"), "k"), 0o000);
    const found = await scanned(dir);
    expect(codes(found)).toEqual(["block fs.unreadable"]);
    expect(found[0]?.paths).toEqual(["secret.pem"]);
  });

  test("fs.link-outside warns about links whose targets are not captured", async () => {
    const dir = fx.repo("web");
    fx.origin(dir);
    symlinkSync("/etc/hosts", join(dir, "hosts"));
    const found = await scanned(dir);
    expect(codes(found)).toEqual(["warn fs.link-outside"]);
    expect(found[0]?.paths).toEqual(["hosts"]);
    expect(found[0]?.fix).toContain("copy");
  });

  test("git.unpushed warns with the branches and counts, as the plan shows it", async () => {
    const dir = fx.repo("web");
    fx.origin(dir);
    fx.git(dir, "switch", "-q", "-c", "feature/pricing");
    for (const n of [1, 2]) {
      fx.write(join(dir, `p${n}.txt`), `${n}\n`);
      fx.git(dir, "add", ".");
      fx.git(dir, "commit", "-q", "-m", `p${n}`);
    }
    const found = await scanned(dir);
    expect(codes(found)).toEqual(["warn git.unpushed"]);
    expect(found[0]?.message).toBe("2 commits on feature/pricing are not on any remote");
    expect(found[0]?.fix).toBe("git push -u origin feature/pricing");
  });

  test("git.unpushed's fix pushes each branch to its own remote, even when another branch is checked out", async () => {
    const dir = fx.repo("web");
    fx.origin(dir);
    fx.git(dir, "switch", "-q", "-c", "feature");
    fx.git(dir, "push", "-q", "-u", "origin", "feature");
    fx.write(join(dir, "f.txt"), "f\n");
    fx.git(dir, "add", ".");
    fx.git(dir, "commit", "-q", "-m", "f");
    fx.git(dir, "switch", "-q", "main");
    const found = await scanned(dir);
    expect(found[0]?.message).toBe("1 commit on feature is not on any remote");
    expect(found[0]?.fix).toBe("git push origin feature");
  });

  test("git.unpushed covers a local-only branch even when its commits are all pushed", async () => {
    const dir = fx.repo("web");
    fx.origin(dir);
    fx.git(dir, "branch", "--no-track", "release", "origin/main");
    const found = await scanned(dir);
    expect(codes(found)).toEqual(["warn git.unpushed"]);
    expect(found[0]?.message).toBe("branch release is on no remote");
    expect(found[0]?.fix).toBe("git push -u origin release");
  });

  test("git.unpushed names commits on a detached HEAD as well as on branches", async () => {
    const dir = fx.repo("web");
    fx.origin(dir);
    fx.write(join(dir, "m.txt"), "m\n");
    fx.git(dir, "commit", "-q", "-am", "x", "--allow-empty");
    fx.git(dir, "switch", "-q", "--detach", "origin/main");
    fx.write(join(dir, "d.txt"), "d\n");
    fx.git(dir, "add", "d.txt");
    fx.git(dir, "commit", "-q", "-m", "detached");
    const found = await scanned(dir);
    expect(found[0]?.message).toBe(
      "1 commit on main and 1 commit on the detached HEAD are not on any remote",
    );
  });

  test("a remote that is configured but never fetched is not called missing", async () => {
    const dir = fx.repo("web");
    fx.git(dir, "remote", "add", "origin", join(fx.root, "nowhere.git"));
    const found = await scanned(dir);
    expect(codes(found)).toEqual(["warn git.unpushed"]);
    expect(found[0]?.message).not.toContain("no remote");
    expect(found[0]?.message).toContain("origin");
    expect(found[0]?.fix).toContain("git fetch origin");
  });

  test("git.unpushed also covers stashes, and a repository with no remote at all", async () => {
    const dir = fx.repo("web");
    fx.write(join(dir, "README.md"), "stash me\n");
    fx.git(dir, "stash", "-q");
    const found = await scanned(dir);
    expect(codes(found)).toEqual(["warn git.unpushed"]);
    expect(found[0]?.message).toBe(
      "the repository has no remote, so its 1 commit and 1 stash exist only in this folder",
    );
  });

  test("git.in-progress warns that the operation restores as it is", async () => {
    const dir = fx.repo("web");
    fx.origin(dir);
    fx.git(dir, "bisect", "start");
    const found = await scanned(dir);
    expect(codes(found)).toEqual(["warn git.in-progress"]);
    expect(found[0]?.message).toContain("bisect");
  });
});

describe("preflight: fails closed", () => {
  /** The host with every child run and every file read recorded. */
  const watched = () => {
    const runs: string[] = [];
    const reads: string[] = [];
    const spy: HostPorts = {
      ...host,
      run: async (spec) => {
        runs.push(spec.command);
        return host.run(spec);
      },
      fs: {
        ...host.fs,
        readText: async (path) => {
          reads.push(path);
          return host.fs.readText(path);
        },
      },
    };
    return { spy, runs, reads };
  };
  const runWith = async (
    spy: HostPorts,
    dir: string,
    checks: Partial<HostChecks> = {},
  ): Promise<PreflightReport> => {
    const result = await preflight(spy, { ...quiet, ...checks }, dir, { env: fx.env });
    if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
    return result.value;
  };

  test("placeholders are checked before git: with any present, no git command runs and nothing is read", async () => {
    const dir = fx.repo("web");
    fx.write(join(dir, ".git", "index.lock"));
    const { spy, runs, reads } = watched();
    const report = await runWith(spy, dir, { dataless: async () => found("assets/a.mov") });
    expect(codes(report.findings)).toEqual(["block fs.dataless"]);
    expect(runs).toEqual([]);
    expect(reads).toEqual([]);
    expect(report.notes.join("\n")).toContain("git was not checked");
  });

  test("when the placeholder check cannot answer, git is not run either", async () => {
    const dir = fx.repo("web");
    const { spy, runs } = watched();
    const report = await runWith(spy, dir, {
      dataless: async () => fail(finding("fs.dataless", { message: "find failed" })),
    });
    expect(codes(report.findings)).toEqual(["block fs.dataless"]);
    expect(runs).toEqual([]);
  });

  test("a linked worktree's .git pointer is read only once the placeholder check has passed", async () => {
    const dir = fx.repo("web");
    const linked = join(fx.root, "web-feature");
    fx.git(dir, "worktree", "add", "-q", "-b", "feature", linked);
    const { spy, reads } = watched();
    const report = await runWith(spy, linked, { dataless: async () => found(".git") });
    expect(codes(report.findings)).toEqual(["block fs.dataless"]);
    expect(reads).toEqual([]);
  });

  test("a FIFO named .git is never opened: it blocks, with a fix", async () => {
    const dir = join(fx.root, "piped");
    mkdirSync(dir);
    Bun.spawnSync(["/usr/bin/mkfifo", join(dir, ".git")]);
    const { spy, runs, reads } = watched();
    const [found] = (await runWith(spy, dir)).findings;
    expect(found).toMatchObject({ code: "fs.unreadable", severity: "block", paths: [join(dir, ".git")] });
    expect(found?.message).toContain("fifo");
    expect(found?.fix).toBeDefined();
    expect(reads).toEqual([]);
    expect(runs).toEqual([]);
  });

  test("a socket named .git blocks the same way", async () => {
    const dir = join(fx.root, "socketed");
    mkdirSync(dir);
    const server = createServer();
    servers.push(server);
    await new Promise<void>((done) => server.listen(join(dir, ".git"), done));
    const { spy, reads } = watched();
    const [found] = (await runWith(spy, dir)).findings;
    expect(found).toMatchObject({ code: "fs.unreadable", severity: "block" });
    expect(found?.message).toContain("socket");
    expect(reads).toEqual([]);
  });

  test("a .git file that is not a gitdir pointer is git.failed, with git's own words", async () => {
    const dir = join(fx.root, "odd");
    mkdirSync(dir);
    fx.write(join(dir, ".git"), "not a pointer\n");
    const [found] = (await run(dir)).findings;
    expect(found).toMatchObject({ code: "git.failed", severity: "block" });
    expect(found?.message).toContain("gitfile");
  });

  test("a .git file too large to be a pointer is not read by plainport", async () => {
    const dir = join(fx.root, "huge");
    mkdirSync(dir);
    fx.write(join(dir, ".git"), `gitdir: ${"x".repeat(70_000)}\n`);
    const { spy, reads } = watched();
    const [found] = (await runWith(spy, dir)).findings;
    expect(found?.code).toBe("git.failed");
    expect(reads).toEqual([]);
  });

  test("the fsmonitor exemption needs every file the daemon holds to be known, not only the sample", async () => {
    const dir = fx.repo("web");
    const server = createServer();
    servers.push(server);
    await new Promise<void>((done) => server.listen(join(dir, ".git", "fsmonitor--daemon.ipc"), done));
    const report = await run(dir, {
      processesUsing: async () =>
        ok([
          use({
            pid: 6,
            command: "git",
            args: "git fsmonitor--daemon run --detach --ipc-threads=8",
            files: [dir],
            fileCount: 51,
          }),
        ]),
    });
    expect(codes(report.findings)).toEqual(["block proc.open-files"]);
    expect(report.fsmonitor).toEqual([]);
  });

  test("a folder with an unusable .git inside another repository is git.failed, never the parent's facts", async () => {
    const parent = fx.repo("parent");
    const dir = join(parent, "sub");
    mkdirSync(join(dir, ".git"), { recursive: true });
    const report = await run(dir);
    expect(codes(report.findings)).toEqual(["block git.failed"]);
  });
});

describe("preflight: git.unpushed fixes cover everything reported", () => {
  const scanned = async (dir: string) => {
    const result = await scanProject(host, dir, { env: fx.env }, { safeToRead: true });
    if (!result.ok) throw new Error(result.finding.message);
    return scanFindings(result.value);
  };
  const stash = (dir: string) => {
    fx.write(join(dir, "README.md"), "stash me\n");
    fx.git(dir, "stash", "-q");
  };
  const detach = (dir: string) => {
    fx.git(dir, "switch", "-q", "--detach");
    fx.write(join(dir, "d.txt"), "d\n");
    fx.git(dir, "add", "d.txt");
    fx.git(dir, "commit", "-q", "-m", "detached");
  };

  test("with no remote: the stashes and the detached commits are covered, not only the branches", async () => {
    const dir = fx.repo("web");
    stash(dir);
    detach(dir);
    const [found] = await scanned(dir);
    expect(found?.code).toBe("git.unpushed");
    expect(found?.fix).toContain("git remote add");
    expect(found?.fix).toContain("git stash list");
    expect(found?.fix).toContain("git switch -c");
  });

  test("with a remote never fetched: the same", async () => {
    const dir = fx.repo("web");
    fx.git(dir, "remote", "add", "origin", join(fx.root, "nowhere.git"));
    stash(dir);
    detach(dir);
    const [found] = await scanned(dir);
    expect(found?.fix).toContain("git fetch origin");
    expect(found?.fix).toContain("git stash list");
    expect(found?.fix).toContain("git switch -c");
  });

  test("stashes alongside unpushed commits are not left out of the fix", async () => {
    const dir = fx.repo("web");
    fx.origin(dir);
    fx.write(join(dir, "m.txt"), "m\n");
    fx.git(dir, "add", "m.txt");
    fx.git(dir, "commit", "-q", "-m", "m");
    stash(dir);
    const [found] = await scanned(dir);
    expect(found?.message).toContain("1 stash");
    expect(found?.fix).toContain("git push origin main");
    expect(found?.fix).toContain("git stash list");
  });
});

describe("preflight: fails closed (r4)", () => {
  test("with placeholders present, nothing inside the folder is looked up, not even the daemon's socket", async () => {
    const dir = fx.repo("web");
    const looked: string[] = [];
    const spy: HostPorts = {
      ...host,
      fs: {
        ...host.fs,
        lstat: async (path) => {
          looked.push(path);
          return host.fs.lstat(path);
        },
        realpath: async (path) => {
          looked.push(path);
          return host.fs.realpath(path);
        },
      },
    };
    const result = await preflight(
      spy,
      {
        ...quiet,
        dataless: async () => found("assets/a.mov"),
        processesUsing: async () =>
          ok([use({ pid: 9, command: "git", args: DAEMON, files: [dir], fileCount: 1 })]),
      },
      dir,
      { env: fx.env },
    );
    expect(result.ok && codes(result.value.findings)).toEqual(["block fs.dataless", "block proc.open-files"]);
    expect(looked).toEqual([]);
  });

  test("folders the placeholder check could not search block as fs.unreadable here, with a fix", async () => {
    const dir = fx.repo("web");
    const report = await run(dir, {
      dataless: async () => ok({ placeholders: [], unsearchable: ["vendor/locked"] }),
    });
    expect(codes(report.findings)).toEqual(["block fs.unreadable"]);
    expect(report.findings[0]?.paths).toEqual([join(dir, "vendor/locked")]);
    expect(report.findings[0]?.fix).toBe(`chmod u+rx ${join(dir, "vendor/locked")}`);
    expect(report.safeToRead).toBe(false);
  });

  test("the scan refuses to run without a preflight that cleared the folder for reading", async () => {
    const dir = fx.repo("web");
    const result = await scanProject(host, dir, { env: fx.env }, { safeToRead: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.finding.code).toBe("fs.dataless");
  });

  test("only the daemon itself (fsmonitor--daemon run) is exempt; a git client naming it is not", async () => {
    const dir = fx.repo("web");
    const server = createServer();
    servers.push(server);
    await new Promise<void>((done) => server.listen(join(dir, ".git", "fsmonitor--daemon.ipc"), done));
    const report = await run(dir, {
      processesUsing: async () =>
        ok([
          use({ pid: 11, command: "git", args: "git fsmonitor--daemon status", cwd: true }),
          use({ pid: 12, command: "git", args: "git log --grep fsmonitor--daemon", cwd: true }),
          use({
            pid: 13,
            command: "git",
            args: "/usr/bin/git fsmonitor--daemon run --detach",
            files: [dir],
            fileCount: 1,
          }),
        ]),
    });
    expect(codes(report.findings)).toEqual(["block proc.cwd"]);
    expect(report.findings[0]?.message).toContain("git (11)");
    expect(report.findings[0]?.message).toContain("git (12)");
    expect(report.fsmonitor).toEqual([13]);
  });

  test("a daemon working inside the folder is still proc.cwd, exempt only for what it holds", async () => {
    const dir = fx.repo("web");
    const server = createServer();
    servers.push(server);
    await new Promise<void>((done) => server.listen(join(dir, ".git", "fsmonitor--daemon.ipc"), done));
    const report = await run(dir, {
      processesUsing: async () =>
        ok([use({ pid: 14, command: "git", args: DAEMON, cwd: true, files: [dir], fileCount: 1 })]),
    });
    expect(codes(report.findings)).toEqual(["block proc.cwd"]);
    expect(report.fsmonitor).toEqual([14]);
  });
});

describe("preflight: exceptions mean bugs (q1)", () => {
  test("a host whose realpath throws something other than a system error makes preflight throw", async () => {
    const dir = fx.repo("web");
    const broken: HostPorts = {
      ...host,
      fs: {
        ...host.fs,
        realpath: async () => {
          throw new TypeError("a fake went wrong");
        },
      },
    };
    await expect(preflight(broken, quiet, dir, { env: fx.env })).rejects.toThrow(TypeError);
  });
});

describe("preflight: the git.unpushed finding, by case (q1)", () => {
  const facts = (over: Partial<GitFacts>): GitFacts => ({
    gitDir: "/p/.git",
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
    ...over,
  });
  const cases: [string, Partial<GitFacts>, string | undefined, string[]][] = [
    ["nothing to report", {}, undefined, []],
    [
      "no remote",
      {
        remotes: [],
        remoteBranches: false,
        unpushed: { commits: 2, branches: [{ name: "main", commits: 2 }], detachedHead: 0 },
        localOnly: ["main"],
      },
      "the repository has no remote, so its 2 commits exist only in this folder",
      ["git remote add origin <url>"],
    ],
    [
      "remote never fetched, with a stash",
      {
        remoteBranches: false,
        stashes: 1,
        unpushed: { commits: 1, branches: [{ name: "main", commits: 1 }], detachedHead: 0 },
        localOnly: ["main"],
      },
      "none of the branches of origin have been fetched, so its 1 commit and 1 stash are not known to be on a remote",
      ["git fetch origin", "git stash list"],
    ],
    [
      "ahead of its upstream",
      {
        unpushed: {
          commits: 1,
          branches: [{ name: "feature", commits: 1, remote: "origin" }],
          detachedHead: 0,
        },
      },
      "1 commit on feature is not on any remote",
      ["git push origin feature"],
    ],
    [
      "local-only branch with pushed commits, plus a detached commit",
      {
        localOnly: ["release"],
        unpushed: { commits: 1, branches: [], detachedHead: 1 },
        branch: undefined,
        detached: true,
      },
      "1 commit on the detached HEAD is not on any remote; branch release is on no remote",
      ["git push -u origin release", "git switch -c <branch>"],
    ],
    ["only a stash", { stashes: 2 }, "2 stashes exist only in this folder", ["git stash list"]],
  ];
  for (const [name, over, message, fixes] of cases) {
    test(name, () => {
      const found = unpushedFinding(facts(over));
      expect(found?.message).toBe(message);
      for (const fix of fixes) expect(found?.fix).toContain(fix);
    });
  }
});
