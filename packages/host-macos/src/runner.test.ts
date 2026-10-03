// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell code, where ${…} is shell syntax.
// The runner against real process groups: TERM then KILL, grandchildren, floods, deadlines, abort. After every
// test, pgrep checks that no process is left in any group the runner started (the task's stop condition).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunSpec, type Spawner, splitRecords } from "@plainport/core";
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
  }, 30_000);

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
    // Far below the child's 60 s; loose enough for a loaded CI host.
    expect(performance.now() - started).toBeLessThan(20_000);
  }, 30_000);

  test("the overall deadline fires on slow but steady output", async () => {
    const started = performance.now();
    const result = await host.run(
      sh("while :; do echo tick; sleep 0.05; done", { idleTimeoutMs: 30_000, timeoutMs: 500 }),
    );
    expect(result).toMatchObject({ ok: false, finding: { code: "process.timeout" } });
    expect(performance.now() - started).toBeLessThan(20_000);
  }, 30_000);

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
  }, 30_000);

  test("processes the leader leaves running in its group are stopped when it exits", async () => {
    const pids: number[] = [];
    const started = performance.now();
    const result = await host.run(
      sh("(sleep 60; echo late) & echo $!; exit 0", {
        killGraceMs: 20_000,
        onLine: (line) => pids.push(Number(line.text)),
      }),
    );
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0, leftoversStopped: true } });
    expect(alive(pids[0] as number)).toBe(false);
    // Stopped by TERM, well inside the 20 s grace, even when the sleep was forked as the first TERM went out.
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 30_000);

  test("leftovers stop promptly every time, also when the runner's TERM races the fork (CI phase 4)", async () => {
    const started = performance.now();
    for (let i = 0; i < 40; i++) {
      const result = await host.run(
        sh("(sleep 60; echo late) & echo started; exit 0", { killGraceMs: 20_000 }),
      );
      expect(result).toMatchObject({ ok: true, value: { leftoversStopped: true } });
    }
    // 40 runs: with a single TERM, about one in ten waited out the full 20 s grace on a loaded host.
    expect(performance.now() - started).toBeLessThan(15_000);
  }, 60_000);

  test("a member forked after TERM went out (a TERM trap that forks) is stopped by TERM too, not left for KILL", async () => {
    const started = performance.now();
    const result = await host.run(
      sh("trap 'sleep 60 & exit 0' TERM; echo ready; while :; do sleep 0.1; done", {
        timeoutMs: 300,
        killGraceMs: 20_000,
      }),
    );
    expect(result).toMatchObject({ ok: false, finding: { code: "process.timeout" } });
    expect(members(groups[0] as number)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 30_000);

  test("in capture mode, leftovers the leader did not wait for make the run process.output-incomplete", async () => {
    const result = await host.run(
      sh("(sleep 60; echo late) & echo early; exit 0", {
        capture: { maxBytes: 1_000_000 },
        killGraceMs: 300,
      }),
    );
    expect(result).toMatchObject({ ok: false, exitCode: 1, finding: { code: "process.output-incomplete" } });
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

describe("runner: nothing outlives a run (host-macos)", () => {
  test("a process that ran a child exits promptly: no timer of the run keeps it alive", async () => {
    const script = join(dir, "one-run.ts");
    writeFileSync(
      script,
      `import { createMacosHost } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};\n` +
        `const result = await createMacosHost().run({ command: "/bin/echo", args: ["hi"], cwd: ${JSON.stringify(dir)}, env: { PATH: "/usr/bin:/bin" } });\n` +
        `console.log(result.ok ? "ran" : result.finding.code);\n` +
        // Measured inside the child, from the run's end to the process's exit, so a slow start-up on a loaded
        // host does not count; a leaked 5 s timer would.
        "const ended = performance.now();\n" +
        'process.on("exit", () => console.log(Math.round(performance.now() - ended)));\n',
    );
    const result = await host.run({
      command: process.execPath,
      args: [script],
      cwd: dir,
      env: { ...env, HOME: dir },
      timeoutMs: 20_000,
    });
    if (!result.ok) throw new Error(result.finding.message);
    const [ran, lingered] = result.value.stdout.text.trim().split("\n");
    expect(ran).toBe("ran");
    expect(Number(lingered)).toBeLessThan(2500);
  }, 30_000);
});

describe("runner: capturing the whole stdout (host-macos)", () => {
  test("NUL-separated output comes back whole, as git -z prints it", async () => {
    const result = await host.run(sh("printf 'a b\\0dir/c\\0'", { capture: { maxBytes: 1024 } }));
    if (!result.ok) throw new Error(result.finding.message);
    const records = splitRecords(result.value.captured as Uint8Array, 0).map((r) =>
      new TextDecoder().decode(r),
    );
    expect(records).toEqual(["a b", "dir/c"]);
  });

  test("capture keeps all of a 3 MB stdout while the tail stays bounded", async () => {
    const result = await host.run(
      sh("head -c 3000000 /dev/zero | tr '\\0' x", {
        outputLimitBytes: 64 * 1024,
        capture: { maxBytes: 4_000_000 },
      }),
    );
    if (!result.ok) throw new Error(result.finding.message);
    expect(result.value.captured?.length).toBe(3_000_000);
    expect(result.value.stdout.droppedBytes).toBe(3_000_000 - 64 * 1024);
  });

  test("a program that writes just past the cap and exits at once is process.output-too-large", async () => {
    for (let i = 0; i < 5; i++) {
      const result = await host.run({
        command: "/usr/bin/head",
        args: ["-c", "1010000", "/dev/zero"],
        cwd: dir,
        env,
        capture: { maxBytes: 1_000_000 },
      });
      expect(result).toMatchObject({ ok: false, finding: { code: "process.output-too-large" } });
    }
  });

  test("stdout past the cap is process.output-too-large, never a shortened ok", async () => {
    const result = await host.run(
      sh("yes plainport | head -c 5000000", { capture: { maxBytes: 1_000_000 } }),
    );
    expect(result).toMatchObject({ ok: false, finding: { code: "process.output-too-large" } });
    if (!result.ok) expect(result.finding.message).toContain("1000000");
  });
});

describe("runner: stopping every live group (host-macos)", () => {
  test("stopAll stops every running child, TERM-trapping ones included, and later runs are cancelled", async () => {
    const own = createMacosHost({ spawner: recording });
    const ready: string[] = [];
    let wake!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const onLine = (line: { text: string }): void => {
      ready.push(line.text);
      if (ready.length === 2) wake();
    };
    const plain = own.run(sh("echo plain; sleep 60", { onLine }));
    const stubborn = own.run(
      sh('trap "" TERM; echo stubborn; while :; do sleep 1; done', { onLine, killGraceMs: 300 }),
    );
    await bothReady;
    expect(own.liveGroups()).toHaveLength(2);
    await own.stopAll();
    expect(await plain).toMatchObject({ ok: false, exitCode: 130, finding: { code: "process.cancelled" } });
    expect(await stubborn).toMatchObject({
      ok: false,
      exitCode: 130,
      finding: { code: "process.cancelled" },
    });
    expect(own.liveGroups()).toEqual([]);
    for (const pgid of groups) expect(members(pgid)).toEqual([]);
    expect(await own.run(sh("echo never"))).toMatchObject({
      ok: false,
      finding: { code: "process.cancelled" },
    });
  });
});
