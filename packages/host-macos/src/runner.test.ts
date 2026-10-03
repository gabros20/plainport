// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell code, where ${…} is shell syntax.
// The runner against real process groups: TERM then KILL, grandchildren, floods, deadlines, abort. After every
// test, pgrep checks that no process is left in any group the runner started (the task's stop condition).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSpec, Spawner } from "@plainport/core";
import { createMacosHost, posixSpawner } from "./index.ts";

const groups: number[] = [];
const recording: Spawner = {
  spawn: (request) => {
    const child = posixSpawner.spawn(request);
    groups.push(child.pid);
    return child;
  },
  signalGroup: (pgid, signal) => posixSpawner.signalGroup(pgid, signal),
};
const host = createMacosHost({ spawner: recording });
const env = { PATH: "/usr/bin:/bin" };
let dir: string;

/** The pids pgrep finds in a process group; pgrep exits 1 when there are none. */
const members = (pgid: number): string[] => {
  const found = Bun.spawnSync(["/usr/bin/pgrep", "-g", String(pgid)], { stdout: "pipe", env });
  return found.stdout.toString().split("\n").filter(Boolean);
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-runner-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  const left: string[] = [];
  for (const pgid of groups.splice(0)) {
    const pids = members(pgid);
    if (pids.length === 0) continue;
    left.push(`group ${pgid}: ${pids.join(", ")}`);
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  if (left.length > 0) throw new Error(`processes left behind: ${left.join("; ")}`);
});

const sh = (script: string, overrides: Partial<RunSpec> = {}): RunSpec => ({
  command: "/bin/sh",
  args: ["-c", script],
  cwd: dir,
  env,
  ...overrides,
});

describe("runner: real process groups (host-macos)", () => {
  test("a child that ignores SIGTERM, and its children, are killed after the grace period", async () => {
    const started = performance.now();
    const result = await host.run(
      sh('trap "" TERM; echo ready; while :; do sleep 1; done', {
        timeoutMs: 300,
        killGraceMs: 300,
        idleTimeoutMs: 10_000,
      }),
    );
    expect(result).toMatchObject({ ok: false, finding: { code: "process.timeout" } });
    expect(performance.now() - started).toBeGreaterThanOrEqual(550);
    expect(members(groups[0] as number)).toEqual([]);
  });

  test("grandchildren die with the group", async () => {
    const controller = new AbortController();
    const pids: number[] = [];
    const result = await host.run(
      sh('sleep 60 & echo $!; /bin/sh -c "sleep 60 & echo \\$!; wait" & wait', {
        signal: controller.signal,
        onLine: (line) => {
          pids.push(Number(line.text));
          if (pids.length === 2) controller.abort();
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, exitCode: 130, finding: { code: "process.cancelled" } });
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(alive(pid)).toBe(false);
  });

  test("an output flood stays bounded: the tail is outputLimitBytes, the rest is counted", async () => {
    let lines = 0;
    const result = await host.run(
      sh("yes plainport-flood | head -c 20000000; echo; echo the-end", {
        outputLimitBytes: 256 * 1024,
        onLine: () => {
          lines++;
        },
      }),
    );
    if (!result.ok) throw new Error(result.finding.message);
    const { stdout } = result.value;
    expect(result.value.exitCode).toBe(0);
    expect(Buffer.byteLength(stdout.text)).toBe(256 * 1024);
    expect(stdout.droppedBytes).toBe(20_000_000 + 1 + 8 - 256 * 1024);
    expect(stdout.text.endsWith("\nthe-end\n")).toBe(true);
    // 16-byte lines, then the empty line echo adds and the-end.
    expect(lines).toBe(20_000_000 / 16 + 2);
  });

  test("a flood without newlines is one line cut at maxLineBytes", async () => {
    const seen: { bytes: number; truncated: boolean }[] = [];
    const result = await host.run(
      sh("head -c 5000000 /dev/zero | tr '\\0' x", {
        maxLineBytes: 4096,
        onLine: (line) => seen.push({ bytes: Buffer.byteLength(line.text), truncated: line.truncated }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ bytes: 4096, truncated: true }]);
  });

  test("the idle deadline fires on silence", async () => {
    const started = performance.now();
    const result = await host.run(sh("echo starting; sleep 60", { idleTimeoutMs: 300 }));
    expect(result).toMatchObject({ ok: false, exitCode: 1, finding: { code: "process.idle-timeout" } });
    if (!result.ok) expect(result.finding.message).toContain("starting");
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("the overall deadline fires on slow but steady output", async () => {
    const started = performance.now();
    const result = await host.run(
      sh("while :; do echo tick; sleep 0.05; done", { idleTimeoutMs: 2000, timeoutMs: 500 }),
    );
    expect(result).toMatchObject({ ok: false, finding: { code: "process.timeout" } });
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("abort mid-run leaves no process behind", async () => {
    const controller = new AbortController();
    const result = await host.run(
      sh("sleep 60 & sleep 60 & echo ready; wait", {
        signal: controller.signal,
        onLine: (line) => {
          if (line.text === "ready") controller.abort();
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, exitCode: 130, finding: { code: "process.cancelled" } });
    expect(members(groups[0] as number)).toEqual([]);
  });

  test("processes the leader leaves running in its group are stopped when it exits", async () => {
    const pids: number[] = [];
    const started = performance.now();
    const result = await host.run(
      sh("(sleep 60; echo late) & echo $!; exit 0", { onLine: (line) => pids.push(Number(line.text)) }),
    );
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0, leftoversStopped: true } });
    expect(alive(pids[0] as number)).toBe(false);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("the child's environment is exactly the env passed, never the parent's", async () => {
    process.env.PLAINPORT_RUNNER_LEAK = "leaked";
    try {
      const result = await host.run(
        sh('echo "${PLAINPORT_RUNNER_LEAK-none} $FOO"', { env: { ...env, FOO: "bar" } }),
      );
      if (!result.ok) throw new Error(result.finding.message);
      expect(result.value.stdout.text).toBe("none bar\n");
    } finally {
      delete process.env.PLAINPORT_RUNNER_LEAK;
    }
  });

  test("stdin is handed to the child, and the cwd is the one asked for", async () => {
    const result = await host.run(sh("cat; pwd", { stdin: "hello\n" }));
    if (!result.ok) throw new Error(result.finding.message);
    expect(result.value.stdout.text).toBe(`hello\n${dir}\n`);
  });

  test("an exit code and a terminating signal come back as they are", async () => {
    expect(await host.run(sh("exit 7"))).toMatchObject({ ok: true, value: { exitCode: 7, signal: null } });
    expect(await host.run(sh("kill -USR1 $$"))).toMatchObject({
      ok: true,
      value: { exitCode: null, signal: "SIGUSR1" },
    });
  });

  test("a program that does not exist is process.spawn-failed", async () => {
    const result = await host.run({ command: join(dir, "nope"), args: [], cwd: dir, env });
    expect(result).toMatchObject({ ok: false, exitCode: 1, finding: { code: "process.spawn-failed" } });
  });
});
