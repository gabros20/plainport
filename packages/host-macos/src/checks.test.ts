import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { type Failure, fail, finding, ok } from "@plainport/contract";
import { type HostPorts, preflight, type RunOutcome, type RunSpec } from "@plainport/core";
import { macOnlyTests } from "../../../test/platform.ts";
import { makeGitFixture } from "../../core/src/testing/git-fixture.ts";
import { createMacosChecks, DOCKER_CLI_FOLDERS, parseLsof } from "./checks.ts";
import { testHost } from "./testing.ts";

/** Tests that need the real macOS tools; skipped on Linux, counted on a Mac (test/platform.ts). */
const testOnMac = macOnlyTests();

const host = testHost();
// Hermetic: no engine folder, no socket; docker is found only where a test puts it. HOME and DOCKER_HOST in `env`
// point into the sandbox, so no test reaches the machine's docker or the real ~/.docker.
const checks = createMacosChecks(host, { dockerCliFolders: [], dockerSockets: [] });
let dir: string;
let env: { PATH: string; HOME: string; DOCKER_HOST: string };
let children: Bun.Subprocess[];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-checks-")));
  env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: join(dir, "home"),
    DOCKER_HOST: `unix://${join(dir, "none.sock")}`,
  };
  children = [];
});
afterEach(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
    await child.exited;
  }
  rmSync(dir, { recursive: true, force: true });
});

const outcome = (over: Partial<RunOutcome> & { out?: string }): RunOutcome => {
  const { out = "", ...rest } = over;
  return {
    exitCode: 0,
    signal: null,
    stdout: { text: out, droppedBytes: 0 },
    stderr: { text: "", droppedBytes: 0 },
    captured: new TextEncoder().encode(out),
    leftoversStopped: false,
    durationMs: 1,
    ...rest,
  };
};

/** The real host, with run() answered by the script: one reply per call, recording each spec. */
const scripted = (...replies: (RunOutcome | Failure)[]): { host: HostPorts; specs: RunSpec[] } => {
  const specs: RunSpec[] = [];
  return {
    specs,
    host: {
      ...host,
      run: async (spec) => {
        specs.push(spec);
        const reply = replies.shift();
        if (reply === undefined) throw new Error(`unexpected run of ${spec.command}`);
        return "ok" in reply ? reply : ok(reply);
      },
    },
  };
};

/** A PATH holding a docker that is never run (scripted hosts answer instead), so docker counts as installed. */
const fakeDocker = (): Record<string, string> => {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 99\n");
  chmodSync(join(bin, "docker"), 0o755);
  return { PATH: bin };
};

const timedOut = fail(finding("process.timeout", { message: "ran past its deadline" }));
const cancelled = fail(finding("process.cancelled", { message: "stopped" }));

/**
 * Waits until lsof lists a process using the folder that `is` accepts, so a check is not racing a child's start; a
 * child that never shows up fails the test after the deadline rather than hanging it.
 */
const settle = async (folder: string, is: (p: Awaited<ReturnType<typeof parseLsof>>[number]) => boolean) => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const listed = await checks.processesUsing(folder, { env });
    if (listed.ok && listed.value.some(is)) return;
    if (Date.now() > deadline) throw new Error(`no process using ${folder} matched within 10 s`);
    await Bun.sleep(25);
  }
};
const byPid = (child: Bun.Subprocess | undefined) => (p: { pid: number }) => p.pid === child?.pid;

describe("macOS checks: processes using the folder (lsof)", () => {
  test("parses lsof's field output: cwd, open files, ancestors; leaves out plainport and its own lsof", () => {
    const root = "/w/web";
    const text = [
      ["p1", "R0", "claunchd", "fcwd", "n/"],
      ["p10", "R1", "czsh", "fcwd", `n${root}`, "f0", "n/dev/ttys001"],
      ["p20", "R10", "cbun", "fcwd", `n${root}`, "f5", `n${root}/notes.txt`],
      ["p30", "R20", "clsof", "fcwd", "n/"],
      [
        "p40",
        "R1",
        "cnode",
        "fcwd",
        "n/tmp",
        "ftxt",
        `n${root}/node_modules/.bin/vite`,
        "f12",
        `n${root}/a.log`,
      ],
      ["p50", "R1", "cvim", "fcwd", `n${root}/src`],
      ["p60", "R1", "cother", "fcwd", "n/w/web-sibling", "f3", "n/w/web-sibling/x"],
    ]
      .flat()
      .join("\n");
    expect(parseLsof(`${text}\n`, [root], 20)).toEqual([
      { pid: 10, ppid: 1, command: "zsh", ancestor: true, cwd: true, files: [], fileCount: 0 },
      {
        pid: 40,
        ppid: 1,
        command: "node",
        ancestor: false,
        cwd: false,
        files: [`${root}/node_modules/.bin/vite`, `${root}/a.log`],
        fileCount: 2,
      },
      { pid: 50, ppid: 1, command: "vim", ancestor: false, cwd: true, files: [], fileCount: 0 },
    ]);
  });

  testOnMac("a process working inside the folder is found", async () => {
    mkdirSync(join(dir, "src"));
    children.push(Bun.spawn(["/bin/sleep", "30"], { cwd: join(dir, "src") }));
    await settle(dir, byPid(children[0]));
    const result = await checks.processesUsing(dir, { env });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContainEqual(
        expect.objectContaining({ pid: children[0]?.pid, command: "sleep", cwd: true, ancestor: false }),
      );
    }
  });

  testOnMac(
    "a process holding a file open inside the folder is found, under the folder's real path",
    async () => {
      const file = join(dir, "data.db");
      writeFileSync(file, "x");
      children.push(Bun.spawn(["/bin/sh", "-c", 'exec 3<"$0"; exec /bin/sleep 30', file], { cwd: "/" }));
      await settle(dir, byPid(children[0]));
      // Given by its /var spelling: lsof reports /private/var.
      const spelled = dir.replace(/^\/private\/var\//, "/var/");
      const result = await checks.processesUsing(spelled, { env });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const found = result.value.find((p) => p.pid === children[0]?.pid);
        expect(found).toMatchObject({ cwd: false, files: [file], fileCount: 1 });
      }
    },
  );

  testOnMac(
    "a folder whose name lsof escapes (non-ASCII, tab, control, backslash, caret) is still matched",
    async () => {
      const odd = join(dir, "p \u00e1\tt\u0001x\\y^z");
      mkdirSync(odd);
      writeFileSync(join(odd, "f.txt"), "f");
      children.push(Bun.spawn(["/bin/sleep", "30"], { cwd: odd }));
      children.push(
        Bun.spawn(["/bin/sh", "-c", 'exec 3<"$0"; exec /bin/sleep 30', join(odd, "f.txt")], { cwd: "/" }),
      );
      await settle(odd, byPid(children[0]));
      await settle(odd, byPid(children[1]));
      const result = await checks.processesUsing(odd, { env });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.find((p) => p.pid === children[0]?.pid)).toMatchObject({ cwd: true });
        expect(result.value.find((p) => p.pid === children[1]?.pid)).toMatchObject({
          files: [join(odd, "f.txt")],
        });
      }
    },
  );

  testOnMac("a file below the folder whose name lsof escapes comes back with its real name", async () => {
    const name = "f\u0001\t\u00e1\\.txt";
    writeFileSync(join(dir, name), "f");
    children.push(
      Bun.spawn(["/bin/sh", "-c", 'exec 3<"$0"; exec /bin/sleep 30', join(dir, name)], { cwd: "/" }),
    );
    await settle(dir, byPid(children[0]));
    const result = await checks.processesUsing(dir, { env });
    expect(result.ok && result.value.find((p) => p.pid === children[0]?.pid)?.files).toEqual([
      join(dir, name),
    ]);
  });

  testOnMac(
    "git's fsmonitor daemon comes back with its command line, so preflight can tell it from other git",
    async () => {
      const fx = makeGitFixture("plainport-fsmonitor-");
      try {
        const repo = fx.repo("web");
        fx.git(repo, "fsmonitor--daemon", "start");
        try {
          await settle(repo, (p) => p.args?.includes("fsmonitor--daemon run") ?? false);
          const result = await checks.processesUsing(repo, { env });
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const daemon = result.value.find((p) => p.args?.includes("fsmonitor--daemon"));
          expect(daemon?.command).toBe("git");
          expect(daemon?.args).toContain("fsmonitor--daemon");
          // fx.env's PATH, without folders under the real home, which the guarded host refuses to search for docker.
          const PATH = (fx.env.PATH ?? "")
            .split(":")
            .filter((folder) => !folder.startsWith(`${userInfo().homedir}/`))
            .join(":");
          const report = await preflight(host, checks, repo, {
            env: { ...fx.env, PATH, DOCKER_HOST: env.DOCKER_HOST },
          });
          expect(report.ok && report.value.fsmonitor).toEqual([daemon?.pid as number]);
          expect(report.ok && report.value.findings).toEqual([]);
        } finally {
          fx.gitStatus(repo, "fsmonitor--daemon", "stop");
        }
      } finally {
        fx.cleanup();
      }
    },
  );

  test("lsof exiting 1 is not a whole listing, even with nothing on stderr", async () => {
    const { host: fake } = scripted(outcome({ exitCode: 1, out: "p1\nR0\nclaunchd\n" }));
    const result = await createMacosChecks(fake).processesUsing(dir, { env });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.finding.code).toBe("proc.open-files");
  });

  test("lsof not finishing is proc.open-files; a cancellation stays a cancellation", async () => {
    const late = await createMacosChecks(scripted(timedOut).host).processesUsing(dir, { env });
    expect(!late.ok && late.finding.code).toBe("proc.open-files");
    expect(!late.ok && late.finding.message).toContain("ran past its deadline");
    const stopped = await createMacosChecks(scripted(cancelled).host).processesUsing(dir, { env });
    expect(!stopped.ok && stopped.exitCode).toBe(130);
  });

  testOnMac("an idle folder has no processes", async () => {
    const result = await checks.processesUsing(dir, { env });
    expect(result).toEqual({ ok: true, value: [] });
  });

  test("lsof failing is proc.open-files: the folder is not known to be free", async () => {
    const { host: fake } = scripted(
      outcome({ exitCode: 1, stderr: { text: "lsof: boom", droppedBytes: 0 } }),
    );
    const result = await createMacosChecks(fake).processesUsing(dir, { env });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.finding.code).toBe("proc.open-files");
      expect(result.finding.message).toContain("lsof: boom");
    }
  });
});

describe("macOS checks: placeholder (dataless) files", () => {
  test("asks find for the dataless flag, pruned so a placeholder folder is never listed, and gives relative paths", async () => {
    const { host: fake, specs } = scripted(outcome({ out: `${dir}/movie.mov\0${dir}/photos\0` }));
    const result = await createMacosChecks(fake).dataless(dir, { env });
    expect(result).toEqual({ ok: true, value: { placeholders: ["movie.mov", "photos"], unsearchable: [] } });
    expect(specs[0]?.command).toBe("/usr/bin/find");
    expect(specs[0]?.args).toEqual([dir, "-flags", "+dataless", "-print0", "-prune"]);
  });

  test("a folder given through a symlink is searched at its real path", async () => {
    const real = join(dir, "real");
    mkdirSync(real);
    symlinkSync(real, join(dir, "link"));
    const { host: fake, specs } = scripted(outcome({ out: `${real}/a.mov\0` }));
    const result = await createMacosChecks(fake).dataless(join(dir, "link"), { env });
    expect(specs[0]?.args?.[0]).toBe(real);
    expect(result).toEqual({ ok: true, value: { placeholders: ["a.mov"], unsearchable: [] } });
  });

  test("find not finishing is fs.dataless; a cancellation stays a cancellation", async () => {
    const late = await createMacosChecks(scripted(timedOut).host).dataless(dir, { env });
    expect(!late.ok && late.finding.code).toBe("fs.dataless");
    const stopped = await createMacosChecks(scripted(cancelled).host).dataless(dir, { env });
    expect(!stopped.ok && stopped.exitCode).toBe(130);
  });

  testOnMac("an ordinary folder on APFS has none (find accepts the flag here)", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    mkdirSync(join(dir, "sub"));
    expect(await checks.dataless(dir, { env })).toEqual({
      ok: true,
      value: { placeholders: [], unsearchable: [] },
    });
  });

  test("folders find may not enter are the scan's fs.unreadable, not a failure here", async () => {
    const { host: fake } = scripted(
      outcome({
        exitCode: 1,
        out: `${dir}/a.mov\0`,
        stderr: { text: `find: ${dir}/locked: Permission denied\n`, droppedBytes: 0 },
      }),
    );
    expect(await createMacosChecks(fake).dataless(dir, { env })).toEqual({
      ok: true,
      value: { placeholders: ["a.mov"], unsearchable: ["locked"] },
    });
  });

  test("any other find failure is fs.dataless: the folder was not checked", async () => {
    const { host: fake } = scripted(
      outcome({ exitCode: 1, stderr: { text: "find: something else\n", droppedBytes: 0 } }),
    );
    const result = await createMacosChecks(fake).dataless(dir, { env });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.finding.code).toBe("fs.dataless");
  });
});

/** A docker inspect listing of one container with these mounts. */
const inspect = (mounts: { Type: string; Source: string }[], name = "/web-db-1", id = "abc123") =>
  JSON.stringify([{ Id: id, Name: name, Mounts: mounts, State: { Running: true } }]);

describe("macOS checks: docker bind mounts", () => {
  test("a running container bind-mounting the folder or a folder inside it is found; other mounts are not", async () => {
    const { host: fake, specs } = scripted(
      outcome({ out: "abc123\n" }),
      outcome({
        out: inspect([
          { Type: "bind", Source: join(dir, "data") },
          { Type: "bind", Source: "/somewhere/else" },
          { Type: "volume", Source: "/var/lib/docker/volumes/x/_data" },
          { Type: "bind", Source: dir },
        ]),
      }),
    );
    const result = await createMacosChecks(fake).dockerMounts(dir, { env: fakeDocker() });
    expect(result).toEqual({
      ok: true,
      value: {
        available: true,
        mounts: [
          { container: "abc123", name: "web-db-1", source: join(dir, "data") },
          { container: "abc123", name: "web-db-1", source: dir },
        ],
      },
    });
    expect(specs.map((s) => [s.command, ...(s.args ?? [])])).toEqual([
      [join(dir, "bin", "docker"), "ps", "--quiet", "--no-trunc"],
      [join(dir, "bin", "docker"), "inspect", "abc123"],
    ]);
  });

  test("a container mounting a folder that holds the project blocks too", async () => {
    const { host: fake } = scripted(
      outcome({ out: "abc123\n" }),
      outcome({ out: inspect([{ Type: "bind", Source: dirname(dir) }]) }),
    );
    const result = await createMacosChecks(fake).dockerMounts(dir, { env: fakeDocker() });
    expect(result).toEqual({
      ok: true,
      value: { available: true, mounts: [{ container: "abc123", name: "web-db-1", source: dirname(dir) }] },
    });
  });

  test("docker that is installed but cannot be started, or refuses us, blocks: containers may be running", async () => {
    const spawn = fail(finding("process.spawn-failed", { message: "could not start docker: EACCES" }));
    const failed = await createMacosChecks(scripted(spawn).host).dockerMounts(dir, { env: fakeDocker() });
    expect(!failed.ok && failed.finding.code).toBe("env.docker-mount");
    const denied = scripted(
      outcome({
        exitCode: 1,
        stderr: {
          text: "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock\n",
          droppedBytes: 0,
        },
      }),
    );
    const refused = await createMacosChecks(denied.host).dockerMounts(dir, { env: fakeDocker() });
    expect(!refused.ok && refused.finding.code).toBe("env.docker-mount");
    const late = await createMacosChecks(scripted(timedOut).host).dockerMounts(dir, { env: fakeDocker() });
    expect(!late.ok && late.finding.code).toBe("env.docker-mount");
  });

  test("no running containers: nothing to inspect", async () => {
    const { host: fake, specs } = scripted(outcome({ out: "" }));
    expect(await createMacosChecks(fake).dockerMounts(dir, { env: fakeDocker() })).toEqual({
      ok: true,
      value: { available: true, mounts: [] },
    });
    expect(specs).toHaveLength(1);
  });

  test("docker not installed is not a finding: it is unavailable", async () => {
    // The real host; PATH, the CLI folders (none) and the sockets (none) hold no docker.
    const result = await checks.dockerMounts(dir, { env: { PATH: dir, HOME: env.HOME } });
    expect(result).toEqual({ ok: true, value: { available: false, reason: "docker is not installed" } });
  });

  testOnMac(
    "docker with no daemon to reach is unavailable (the real docker CLI, pointed at a socket that is not there)",
    async () => {
      // This PATH without folders under the real home, which the guarded host refuses to look in.
      const PATH = (process.env.PATH ?? "")
        .split(":")
        .filter((folder) => !folder.startsWith(`${userInfo().homedir}/`))
        .join(":");
      const hasDocker = Bun.which("docker", { PATH }) !== null;
      const result = await checks.dockerMounts(dir, {
        env: { PATH, HOME: dir, DOCKER_HOST: `unix://${join(dir, "none.sock")}` },
      });
      expect(result).toEqual({
        ok: true,
        value: { available: false, reason: hasDocker ? "docker is not running" : "docker is not installed" },
      });
    },
  );

  test("docker is not running only when its socket is missing or refuses connections", async () => {
    for (const text of [
      "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory",
      "failed to connect to the docker API at unix:///var/run/docker.sock: dial unix /var/run/docker.sock: connect: connection refused",
    ]) {
      const { host: fake } = scripted(outcome({ exitCode: 1, stderr: { text, droppedBytes: 0 } }));
      expect(await createMacosChecks(fake).dockerMounts(dir, { env: fakeDocker() })).toEqual({
        ok: true,
        value: { available: false, reason: "docker is not running" },
      });
    }
  });

  test("'Is the docker daemon running?' alone proves nothing: docker may be running, so it blocks", async () => {
    const { host: fake } = scripted(
      outcome({
        exitCode: 1,
        stderr: {
          text: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
          droppedBytes: 0,
        },
      }),
    );
    const result = await createMacosChecks(fake).dockerMounts(dir, { env: fakeDocker() });
    expect(!result.ok && result.finding.code).toBe("env.docker-mount");
  });

  test("docker inspect output of an unexpected shape is env.docker-mount, with a fix", async () => {
    const { host: fake } = scripted(outcome({ out: "abc123\n" }), outcome({ out: '[{"Id": 1}]' }));
    const result = await createMacosChecks(fake).dockerMounts(dir, { env: fakeDocker() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.finding.code).toBe("env.docker-mount");
      expect(result.finding.fix).toBeDefined();
    }
  });

  test("a container that stopped between listing and inspecting is skipped", async () => {
    const { host: fake } = scripted(
      outcome({ out: "abc123\ngone456\n" }),
      outcome({
        exitCode: 1,
        out: inspect([{ Type: "bind", Source: dir }]),
        stderr: { text: "Error: No such object: gone456\n", droppedBytes: 0 },
      }),
    );
    const result = await createMacosChecks(fake).dockerMounts(dir, { env: fakeDocker() });
    expect(result.ok && result.value.available && result.value.mounts.length).toBe(1);
  });

  test("any other docker failure is env.docker-mount: the mounts were not checked", async () => {
    const { host: fake } = scripted(
      outcome({ out: "abc123\n" }),
      outcome({ exitCode: 1, stderr: { text: "permission denied\n", droppedBytes: 0 } }),
    );
    const result = await createMacosChecks(fake).dockerMounts(dir, { env: fakeDocker() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.finding.code).toBe("env.docker-mount");
  });
});

describe("macOS checks: preflight with the real checks", () => {
  testOnMac("proc.cwd and proc.open-files come from real processes; an idle folder has neither", async () => {
    mkdirSync(join(dir, "web"));
    const web = join(dir, "web");
    writeFileSync(join(web, "server.log"), "");
    const idle = await preflight(host, checks, web, { env });
    expect(idle.ok && idle.value.findings).toEqual([]);

    children.push(Bun.spawn(["/bin/sleep", "30"], { cwd: web }));
    children.push(
      Bun.spawn(["/bin/sh", "-c", 'exec 3>>"$0"; exec /bin/sleep 30', join(web, "server.log")], { cwd: "/" }),
    );
    await settle(web, byPid(children[0]));
    await settle(web, byPid(children[1]));
    const busy = await preflight(host, checks, web, { env });
    expect(busy.ok).toBe(true);
    if (busy.ok) {
      expect(busy.value.findings.map((f) => f.code)).toEqual(["proc.open-files", "proc.cwd"]);
      expect(busy.value.findings[0]?.paths).toEqual([join(web, "server.log")]);
    }
  });
});

describe("macOS checks: fail closed", () => {
  test("a PATH folder that cannot be searched for docker blocks: docker may be installed there", async () => {
    const locked = join(dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const result = await checks.dockerMounts(dir, { env: { PATH: `${locked}:${dir}` } });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.finding.code).toBe("env.docker-mount");
        expect(result.finding.fix).toContain(locked);
      }
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test("a docker that is there but not executable blocks, with a fix", async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "docker"), 0o644);
    const result = await checks.dockerMounts(dir, { env: { PATH: bin } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.finding.code).toBe("env.docker-mount");
      expect(result.finding.fix).toContain(`chmod u+x ${join(bin, "docker")}`);
    }
  });

  test("a folder whose real path cannot be found is not checked: each check blocks under its own code", async () => {
    const broken: HostPorts = {
      ...scripted().host,
      fs: {
        ...host.fs,
        realpath: async () => {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        },
      },
    };
    const unchecked = createMacosChecks(broken);
    const processes = await unchecked.processesUsing(dir, { env });
    expect(!processes.ok && processes.finding.code).toBe("proc.open-files");
    const dataless = await unchecked.dataless(dir, { env });
    expect(!dataless.ok && dataless.finding.code).toBe("fs.dataless");
    const docker = await unchecked.dockerMounts(dir, { env: fakeDocker() });
    expect(!docker.ok && docker.finding.code).toBe("env.docker-mount");
  });
});

describe("macOS checks: docker as each engine reports it (r4)", () => {
  /** A recorded-shape inspect listing with __PROJECT__ replaced by the folder's spelling the engine uses. */
  const fixture = (name: string, project: string): string =>
    readFileSync(join(import.meta.dir, "fixtures", `docker-inspect-${name}.json`), "utf8").replaceAll(
      "__PROJECT__",
      project,
    );

  test("Docker Desktop names bind sources inside its VM (/host_mnt/...): they are mapped back to host paths", async () => {
    const { host: fake } = scripted(
      outcome({ out: "9f1c2e4a7b3d\n" }),
      outcome({ out: fixture("docker-desktop", dir) }),
    );
    const result = await createMacosChecks(fake).dockerMounts(dir, { env: fakeDocker() });
    expect(result.ok && result.value.available && result.value.mounts.map((m) => m.source)).toEqual([
      `/host_mnt${dir}`,
      `/host_mnt${join(dir, "data")}`,
    ]);
  });

  test("OrbStack and colima name bind sources by their host path", async () => {
    const { host: fake } = scripted(
      outcome({ out: "c7d8e9f0a1b2\n" }),
      outcome({ out: fixture("orbstack", dir) }),
    );
    const result = await createMacosChecks(fake).dockerMounts(dir, { env: fakeDocker() });
    expect(result.ok && result.value.available && result.value.mounts.length).toBe(2);
  });

  test("a /host_mnt source for another folder is still not a mount of this one", async () => {
    const { host: fake } = scripted(
      outcome({ out: "9f1c2e4a7b3d\n" }),
      outcome({ out: fixture("docker-desktop", `${dir}-other`) }),
    );
    const result = await createMacosChecks(fake).dockerMounts(dir, { env: fakeDocker() });
    expect(result).toEqual({ ok: true, value: { available: true, mounts: [] } });
  });

  test("a daemon socket with no docker command anywhere known blocks: containers may be running", async () => {
    const home = join(dir, "home");
    mkdirSync(join(home, ".docker", "run"), { recursive: true });
    const server = createServer();
    try {
      await new Promise<void>((done) => server.listen(join(home, ".docker", "run", "docker.sock"), done));
      const result = await createMacosChecks(host, {
        dockerCliFolders: ["~/.docker/bin", "~/.orbstack/bin"],
        dockerSockets: ["~/.docker/run/docker.sock"],
      }).dockerMounts(dir, { env: { PATH: dir, HOME: home } });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.finding.code).toBe("env.docker-mount");
        expect(result.finding.message).toContain(join(home, ".docker", "run", "docker.sock"));
        expect(result.finding.fix).toContain(".docker/bin");
      }
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  test("DOCKER_HOST naming a unix socket that exists counts as a daemon too", async () => {
    const server = createServer();
    try {
      await new Promise<void>((done) => server.listen(join(dir, "engine.sock"), done));
      const result = await checks.dockerMounts(dir, {
        env: { PATH: dir, HOME: join(dir, "home"), DOCKER_HOST: `unix://${join(dir, "engine.sock")}` },
      });
      expect(!result.ok && result.finding.code).toBe("env.docker-mount");
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  test("a docker CLI in a known install folder is found when PATH lacks it", async () => {
    const home = join(dir, "home");
    mkdirSync(join(home, ".orbstack", "bin"), { recursive: true });
    writeFileSync(join(home, ".orbstack", "bin", "docker"), "#!/bin/sh\nexit 99\n");
    chmodSync(join(home, ".orbstack", "bin", "docker"), 0o755);
    const { host: fake, specs } = scripted(outcome({ out: "" }));
    const result = await createMacosChecks(fake, {
      dockerCliFolders: DOCKER_CLI_FOLDERS,
      dockerSockets: [],
    }).dockerMounts(dir, { env: { PATH: dir, HOME: home } });
    expect(result).toEqual({ ok: true, value: { available: true, mounts: [] } });
    expect(specs[0]?.command).toBe(join(home, ".orbstack", "bin", "docker"));
  });

  test("docker inspect's 'No such object' is accepted only when stderr was read whole", async () => {
    const { host: fake } = scripted(
      outcome({ out: "abc123\ngone456\n" }),
      outcome({
        exitCode: 1,
        out: inspect([{ Type: "bind", Source: dir }]),
        stderr: { text: "Error: No such object: gone456\n", droppedBytes: 512 },
      }),
    );
    const result = await createMacosChecks(fake).dockerMounts(dir, { env: fakeDocker() });
    expect(!result.ok && result.finding.code).toBe("env.docker-mount");
  });
});

describe("macOS checks: folders find could not search (r4)", () => {
  test("are returned by name, so preflight can block on them itself", async () => {
    const { host: fake } = scripted(
      outcome({
        exitCode: 1,
        out: `${dir}/a.mov\0`,
        stderr: {
          text: `find: ${dir}/locked: Permission denied\nfind: ${dir}/deep/er: Permission denied\n`,
          droppedBytes: 0,
        },
      }),
    );
    expect(await createMacosChecks(fake).dataless(dir, { env })).toEqual({
      ok: true,
      value: { placeholders: ["a.mov"], unsearchable: ["locked", "deep/er"] },
    });
  });
});

describe("macOS checks: hermetic docker discovery (q1)", () => {
  test("the CLI folders and the sockets are parameters: with none, and none on PATH, docker is not installed", async () => {
    const hermetic = createMacosChecks(host, { dockerCliFolders: [], dockerSockets: [] });
    const result = await hermetic.dockerMounts(dir, {
      env: { PATH: dir, HOME: join(dir, "home"), DOCKER_HOST: `unix://${join(dir, "none.sock")}` },
    });
    expect(result).toEqual({ ok: true, value: { available: false, reason: "docker is not installed" } });
  });

  test("~/ in a folder or socket entry means the check's HOME, and is skipped without one", async () => {
    const home = join(dir, "home");
    mkdirSync(join(home, "cli"), { recursive: true });
    writeFileSync(join(home, "cli", "docker"), "#!/bin/sh\nexit 99\n");
    chmodSync(join(home, "cli", "docker"), 0o755);
    const { host: fake, specs } = scripted(outcome({ out: "" }));
    const found = createMacosChecks(fake, { dockerCliFolders: ["~/cli"], dockerSockets: [] });
    expect(await found.dockerMounts(dir, { env: { PATH: dir, HOME: home } })).toEqual({
      ok: true,
      value: { available: true, mounts: [] },
    });
    expect(specs[0]?.command).toBe(join(home, "cli", "docker"));
    expect(await found.dockerMounts(dir, { env: { PATH: dir } })).toEqual({
      ok: true,
      value: { available: false, reason: "docker is not installed" },
    });
  });

  test("a realpath failure that is not a system error is a bug: the check throws", async () => {
    const broken: HostPorts = {
      ...scripted().host,
      fs: {
        ...host.fs,
        realpath: async () => {
          throw new TypeError("a fake went wrong");
        },
      },
    };
    await expect(createMacosChecks(broken).processesUsing(dir, { env })).rejects.toThrow(TypeError);
  });
});
