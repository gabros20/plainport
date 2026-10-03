import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { type Finding, fail, finding, ok } from "@plainport/contract";
import { testHost } from "../../../host-macos/src/testing.ts";
import type { HostChecks, ProcessUse } from "../ports/checks.ts";
import { scanProject } from "../scan/index.ts";
import { type GitFixture, makeGitFixture } from "../testing/git-fixture.ts";
import { type PreflightReport, preflight, scanFindings } from "./index.ts";

const host = testHost();
let fx: GitFixture;

beforeEach(() => {
  fx = makeGitFixture("plainport-preflight-");
});
afterEach(() => {
  Bun.spawnSync(["/bin/chmod", "-R", "u+rwx", fx.root]);
  fx.cleanup();
});

const quiet: HostChecks = {
  processesUsing: async () => ok([]),
  dataless: async () => ok([]),
  dockerMounts: async () => ok({ available: true, mounts: [] }),
};

const run = async (dir: string, checks: Partial<HostChecks> = {}): Promise<PreflightReport> => {
  const result = await preflight(host, { ...quiet, ...checks }, dir, { env: fx.env });
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

const codes = (findings: Finding[]) => findings.map((f) => `${f.severity} ${f.code}`);

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
    expect(await run(dir)).toEqual({ findings: [], notes: [], fsmonitor: [] });
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

  test("git's fsmonitor daemon is not a blocker: it is listed to be stopped", async () => {
    const dir = fx.repo("web");
    const report = await run(dir, {
      processesUsing: async () =>
        ok([
          use({
            pid: 321,
            command: "git",
            cwd: true,
            files: [join(dir, ".git", "fsmonitor--daemon.ipc")],
            fileCount: 1,
          }),
        ]),
    });
    expect(report.findings).toEqual([]);
    expect(report.fsmonitor).toEqual([321]);
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
    const report = await run(dir, { dataless: async () => ok(["assets/video.mov"]) });
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
      dataless: async () => fail(finding("process.timeout", { message: "find ran too long" })),
    });
    expect(codes(report.findings)).toEqual([
      "block git.locked",
      "block proc.open-files",
      "block process.timeout",
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
    const result = await scanProject(host, dir, { env: fx.env });
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
    expect(found[0]?.fix).toBe("git push");
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
