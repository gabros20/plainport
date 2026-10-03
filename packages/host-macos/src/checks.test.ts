import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@plainport/contract";
import type { HostPorts, RunOutcome, RunSpec } from "@plainport/core";
import { createMacosChecks, parseLsof } from "./checks.ts";
import { testHost } from "./testing.ts";

const host = testHost();
const checks = createMacosChecks(host);
const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
let dir: string;
let children: Bun.Subprocess[];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-checks-")));
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
const scripted = (...replies: RunOutcome[]): { host: HostPorts; specs: RunSpec[] } => {
  const specs: RunSpec[] = [];
  return {
    specs,
    host: {
      ...host,
      run: async (spec) => {
        specs.push(spec);
        const reply = replies.shift();
        if (reply === undefined) throw new Error(`unexpected run of ${spec.command}`);
        return ok(reply);
      },
    },
  };
};

/** Waits until lsof sees the child, so the check is not racing its start. */
const settle = () => Bun.sleep(150);

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

  test("a process working inside the folder is found", async () => {
    mkdirSync(join(dir, "src"));
    children.push(Bun.spawn(["/bin/sleep", "30"], { cwd: join(dir, "src") }));
    await settle();
    const result = await checks.processesUsing(dir, { env });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContainEqual(
        expect.objectContaining({ pid: children[0]?.pid, command: "sleep", cwd: true, ancestor: false }),
      );
    }
  });

  test("a process holding a file open inside the folder is found, under the folder's real path", async () => {
    const file = join(dir, "data.db");
    writeFileSync(file, "x");
    children.push(Bun.spawn(["/bin/sh", "-c", 'exec 3<"$0"; exec /bin/sleep 30', file], { cwd: "/" }));
    await settle();
    // Given by its /var spelling: lsof reports /private/var.
    const spelled = dir.replace(/^\/private\/var\//, "/var/");
    const result = await checks.processesUsing(spelled, { env });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const found = result.value.find((p) => p.pid === children[0]?.pid);
      expect(found).toMatchObject({ cwd: false, files: [file], fileCount: 1 });
    }
  });

  test("an idle folder has no processes", async () => {
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
    expect(result).toEqual({ ok: true, value: ["movie.mov", "photos"] });
    expect(specs[0]?.command).toBe("/usr/bin/find");
    expect(specs[0]?.args).toEqual([dir, "-flags", "+dataless", "-print0", "-prune"]);
  });

  test("an ordinary folder on APFS has none (find accepts the flag here)", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    mkdirSync(join(dir, "sub"));
    expect(await checks.dataless(dir, { env })).toEqual({ ok: true, value: [] });
  });

  test("folders find may not enter are the scan's fs.unreadable, not a failure here", async () => {
    const { host: fake } = scripted(
      outcome({
        exitCode: 1,
        out: `${dir}/a.mov\0`,
        stderr: { text: `find: ${dir}/locked: Permission denied\n`, droppedBytes: 0 },
      }),
    );
    expect(await createMacosChecks(fake).dataless(dir, { env })).toEqual({ ok: true, value: ["a.mov"] });
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

describe("macOS checks: docker bind mounts", () => {
  const inspect = (mounts: { Type: string; Source: string }[], name = "/web-db-1", id = "abc123") =>
    JSON.stringify([{ Id: id, Name: name, Mounts: mounts, State: { Running: true } }]);

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
    const result = await createMacosChecks(fake).dockerMounts(dir, { env });
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
      ["docker", "ps", "--quiet", "--no-trunc"],
      ["docker", "inspect", "abc123"],
    ]);
  });

  test("no running containers: nothing to inspect", async () => {
    const { host: fake, specs } = scripted(outcome({ out: "" }));
    expect(await createMacosChecks(fake).dockerMounts(dir, { env })).toEqual({
      ok: true,
      value: { available: true, mounts: [] },
    });
    expect(specs).toHaveLength(1);
  });

  test("docker not installed is not a finding: it is unavailable", async () => {
    // The real host, with a PATH that has no docker on it.
    const result = await checks.dockerMounts(dir, { env: { PATH: dir } });
    expect(result).toEqual({ ok: true, value: { available: false, reason: "docker is not installed" } });
  });

  test("docker's daemon not running is not a finding: it is unavailable", async () => {
    const { host: fake } = scripted(
      outcome({
        exitCode: 1,
        stderr: {
          text: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
          droppedBytes: 0,
        },
      }),
    );
    expect(await createMacosChecks(fake).dockerMounts(dir, { env })).toEqual({
      ok: true,
      value: { available: false, reason: "docker is not running" },
    });
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
    const result = await createMacosChecks(fake).dockerMounts(dir, { env });
    expect(result.ok && result.value.available && result.value.mounts.length).toBe(1);
  });

  test("any other docker failure is env.docker-mount: the mounts were not checked", async () => {
    const { host: fake } = scripted(
      outcome({ out: "abc123\n" }),
      outcome({ exitCode: 1, stderr: { text: "permission denied\n", droppedBytes: 0 } }),
    );
    const result = await createMacosChecks(fake).dockerMounts(dir, { env });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.finding.code).toBe("env.docker-mount");
  });
});
