// The runner's logic against a fake spawner: deadlines, TERM then KILL, bounded output, lines and log events.
// The same behaviour against real process groups is tested in packages/host-macos (runner.test.ts).

import { describe, expect, test } from "bun:test";
import { FindingSchema, type PlainportEvent } from "@plainport/contract";
import { RingBuffer } from "./ring-buffer.ts";
import { runProcess } from "./runner.ts";
import type { ChildProcess, GroupSignal, RunSpec, Spawner } from "./types.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A scripted child: the test writes its output and decides how it answers signals. */
class FakeChild implements ChildProcess {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  /** Members of the group besides the leader that are still running. */
  leftovers = 0;
  leaderAlive = true;
  ignoresTerm = false;
  private out!: ReadableStreamDefaultController<Uint8Array>;
  private err!: ReadableStreamDefaultController<Uint8Array>;
  private resolveExit!: (value: { code: number | null; signal: string | null }) => void;
  private closed = false;

  constructor(pid: number) {
    this.pid = pid;
    this.stdout = new ReadableStream({
      start: (c) => {
        this.out = c;
      },
    });
    this.stderr = new ReadableStream({
      start: (c) => {
        this.err = c;
      },
    });
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  write(stream: "stdout" | "stderr", text: string | Uint8Array): void {
    if (this.closed) return;
    (stream === "stdout" ? this.out : this.err).enqueue(typeof text === "string" ? encode(text) : text);
  }

  /** The leader exits; its pipes close once no group member is left to hold them. */
  exit(code: number | null, signal: string | null = null): void {
    if (!this.leaderAlive) return;
    this.leaderAlive = false;
    this.resolveExit({ code, signal });
    this.maybeClose();
  }

  maybeClose(): void {
    if (this.leaderAlive || this.leftovers > 0 || this.closed) return;
    this.closed = true;
    this.out.close();
    this.err.close();
  }
}

class FakeSpawner implements Spawner {
  readonly signals: GroupSignal[] = [];
  readonly spawned: FakeChild[] = [];
  readonly requests: Parameters<Spawner["spawn"]>[0][] = [];
  constructor(private readonly script: (child: FakeChild) => void = () => {}) {}

  spawn(request: Parameters<Spawner["spawn"]>[0]): ChildProcess {
    this.requests.push(request);
    const child = new FakeChild(1000 + this.spawned.length);
    this.spawned.push(child);
    queueMicrotask(() => this.script(child));
    return child;
  }

  signalGroup(pgid: number, signal: GroupSignal): boolean {
    const child = this.spawned.find((c) => c.pid === pgid);
    if (child === undefined) return false;
    const alive = child.leaderAlive || child.leftovers > 0;
    if (signal === 0) return alive;
    this.signals.push(signal);
    if (!alive) return false;
    if (signal === "SIGKILL" || !child.ignoresTerm) {
      child.leftovers = 0;
      child.exit(null, signal);
      child.maybeClose();
    }
    return true;
  }
}

const spec = (overrides: Partial<RunSpec> = {}): RunSpec => ({
  command: "/usr/bin/tool",
  args: ["a", "b"],
  cwd: "/tmp",
  env: { PATH: "/usr/bin:/bin" },
  ...overrides,
});

const ms = (n: number): Promise<void> => Bun.sleep(n);

describe("runner (fake spawner): exit and output", () => {
  test("a child's exit code and output come back as an ok outcome, also when the code is not 0", async () => {
    const spawner = new FakeSpawner((child) => {
      child.write("stdout", "hello\n");
      child.write("stderr", "warning\n");
      child.exit(3);
    });
    const result = await runProcess(spawner, spec());
    expect(result).toMatchObject({
      ok: true,
      value: {
        exitCode: 3,
        signal: null,
        stdout: { text: "hello\n", droppedBytes: 0 },
        stderr: { text: "warning\n", droppedBytes: 0 },
        leftoversStopped: false,
      },
    });
    expect(spawner.requests[0]).toMatchObject({
      command: "/usr/bin/tool",
      args: ["a", "b"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin" },
    });
  });

  test("a spawn that throws is a process.spawn-failed value, never an exception", async () => {
    const spawner: Spawner = {
      spawn: () => {
        throw Object.assign(new Error("ENOENT: no such file or directory, posix_spawn '/nope'"), {
          code: "ENOENT",
        });
      },
      signalGroup: () => false,
    };
    const result = await runProcess(spawner, spec({ command: "/nope" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(1);
    expect(result.finding.code).toBe("process.spawn-failed");
    expect(result.finding.message).toContain("/nope");
    expect(FindingSchema.parse(result.finding)).toEqual(result.finding);
  });

  test("lines are split across chunks, CRLF is trimmed, and a final line without a newline still counts", async () => {
    const spawner = new FakeSpawner((child) => {
      child.write("stdout", "fir");
      child.write("stdout", "st\r\nsecond\nthi");
      child.write("stderr", "oops\n");
      child.write("stdout", "rd");
      child.exit(0);
    });
    const lines: string[] = [];
    const events: PlainportEvent[] = [];
    const result = await runProcess(
      spawner,
      spec({
        onLine: (line) => lines.push(`${line.stream}:${line.text}`),
        log: { op: "op-1", emit: (event) => events.push(event) },
      }),
    );
    expect(result.ok).toBe(true);
    expect(lines.filter((l) => l.startsWith("stdout:"))).toEqual([
      "stdout:first",
      "stdout:second",
      "stdout:third",
    ]);
    expect(lines).toContain("stderr:oops");
    expect(events).toContainEqual({ type: "log", op: "op-1", level: "debug", message: "tool: first" });
    expect(events).toContainEqual({ type: "log", op: "op-1", level: "info", message: "tool: oops" });
  });

  test("a line longer than maxLineBytes is cut and marked truncated; the next line is whole", async () => {
    const spawner = new FakeSpawner((child) => {
      child.write("stdout", `${"x".repeat(100)}\nshort\n`);
      child.exit(0);
    });
    const lines: { text: string; truncated: boolean }[] = [];
    await runProcess(spawner, spec({ maxLineBytes: 10, onLine: (line) => lines.push(line) }));
    expect(lines.map(({ text, truncated }) => ({ text, truncated }))).toEqual([
      { text: "x".repeat(10), truncated: true },
      { text: "short", truncated: false },
    ]);
  });

  test("log events can be limited to some streams", async () => {
    const spawner = new FakeSpawner((child) => {
      child.write("stdout", '{"json":true}\n');
      child.write("stderr", "said something\n");
      child.exit(0);
    });
    const events: PlainportEvent[] = [];
    await runProcess(spawner, spec({ log: { op: "op", emit: (e) => events.push(e), streams: ["stderr"] } }));
    expect(events.map((e) => (e.type === "log" ? e.message : ""))).toEqual(["tool: said something"]);
  });
});

describe("runner (fake spawner): bounded output", () => {
  test("a flood keeps only the last outputLimitBytes of each stream and counts what it dropped", async () => {
    const chunk = encode(`${"y".repeat(1023)}\n`);
    const spawner = new FakeSpawner((child) => {
      for (let i = 0; i < 4096; i++) child.write("stdout", chunk); // 4 MiB
      child.write("stdout", "the end\n");
      child.exit(0);
    });
    const result = await runProcess(spawner, spec({ outputLimitBytes: 64 * 1024 }));
    if (!result.ok) throw new Error(result.finding.message);
    const { stdout } = result.value;
    expect(Buffer.byteLength(stdout.text)).toBe(64 * 1024);
    expect(stdout.droppedBytes).toBe(4096 * 1024 + 8 - 64 * 1024);
    expect(stdout.text.endsWith("the end\n")).toBe(true);
  });

  test("the ring buffer keeps the newest bytes in order across wraps", () => {
    const ring = new RingBuffer(8);
    ring.push(encode("abcde"));
    ring.push(encode("fghij"));
    expect(new TextDecoder().decode(ring.bytes())).toBe("cdefghij");
    expect(ring.droppedBytes).toBe(2);
    ring.push(encode("0123456789abc"));
    expect(new TextDecoder().decode(ring.bytes())).toBe("56789abc");
    expect(ring.droppedBytes).toBe(15);
  });
});

describe("runner (fake spawner): deadlines and cancelling", () => {
  test("the idle deadline fires on silence: TERM to the group, process.idle-timeout", async () => {
    const spawner = new FakeSpawner((child) => child.write("stderr", "connecting\n"));
    const result = await runProcess(spawner, spec({ idleTimeoutMs: 60, timeoutMs: 10_000 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.finding.code).toBe("process.idle-timeout");
    expect(result.exitCode).toBe(1);
    expect(result.finding.message).toContain("connecting");
    expect(spawner.signals).toEqual(["SIGTERM"]);
  });

  test("output resets the idle deadline", async () => {
    const spawner = new FakeSpawner(async (child) => {
      for (let i = 0; i < 8; i++) {
        child.write("stdout", `tick ${i}\n`);
        await ms(20);
      }
      child.exit(0);
    });
    const result = await runProcess(spawner, spec({ idleTimeoutMs: 100, timeoutMs: 10_000 }));
    expect(result.ok).toBe(true);
    expect(spawner.signals).toEqual([]);
  });

  test("the overall deadline fires even while output keeps coming", async () => {
    let running = true;
    const spawner = new FakeSpawner(async (child) => {
      while (running && child.leaderAlive) {
        child.write("stdout", "tick\n");
        await ms(10);
      }
    });
    const started = performance.now();
    const result = await runProcess(spawner, spec({ idleTimeoutMs: 1000, timeoutMs: 120 }));
    running = false;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.finding.code).toBe("process.timeout");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a child that ignores TERM gets KILL after the grace period", async () => {
    const spawner = new FakeSpawner((child) => {
      child.ignoresTerm = true;
    });
    const started = performance.now();
    const result = await runProcess(spawner, spec({ timeoutMs: 50, killGraceMs: 100 }));
    expect(result.ok).toBe(false);
    expect(spawner.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
  });

  test("aborting cancels the whole group: process.cancelled, exit 130", async () => {
    const controller = new AbortController();
    const spawner = new FakeSpawner((child) => {
      child.write("stdout", "working\n");
      setTimeout(() => controller.abort(), 30);
    });
    const result = await runProcess(spawner, spec({ signal: controller.signal }));
    expect(result).toMatchObject({ ok: false, exitCode: 130, finding: { code: "process.cancelled" } });
    expect(spawner.signals[0]).toBe("SIGTERM");
  });

  test("an already aborted signal never starts the child", async () => {
    const spawner = new FakeSpawner();
    const result = await runProcess(spawner, spec({ signal: AbortSignal.abort() }));
    expect(result).toMatchObject({ ok: false, exitCode: 130, finding: { code: "process.cancelled" } });
    expect(spawner.spawned).toHaveLength(0);
  });

  test("processes the leader leaves behind in its group are stopped too", async () => {
    const spawner = new FakeSpawner((child) => {
      child.leftovers = 2;
      child.write("stdout", "done\n");
      child.exit(0);
    });
    const result = await runProcess(spawner, spec());
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0, leftoversStopped: true } });
    expect(spawner.signals).toEqual(["SIGTERM"]);
  });

  test("an onLine callback that throws is a bug: the group is stopped, then the error propagates", async () => {
    const spawner = new FakeSpawner((child) => child.write("stdout", "boom\n"));
    await expect(
      runProcess(
        spawner,
        spec({
          onLine: () => {
            throw new Error("parser bug");
          },
        }),
      ),
    ).rejects.toThrow("parser bug");
    expect(spawner.signals[0]).toBe("SIGTERM");
    expect(spawner.spawned[0]?.leaderAlive).toBe(false);
  });

  test("a process group id of 0 or 1 is refused before any signal, since kill(-1) means every process", async () => {
    const signalled: number[] = [];
    const spawner: Spawner = {
      spawn: () => new FakeChild(1),
      signalGroup: (pgid) => {
        signalled.push(pgid);
        return false;
      },
    };
    await expect(runProcess(spawner, spec())).rejects.toThrow(/process group/);
    expect(signalled).toEqual([]);
  });

  test("deadlines and limits must be positive", async () => {
    await expect(runProcess(new FakeSpawner(), spec({ idleTimeoutMs: 0 }))).rejects.toThrow(/idleTimeoutMs/);
    await expect(runProcess(new FakeSpawner(), spec({ outputLimitBytes: -1 }))).rejects.toThrow(
      /outputLimitBytes/,
    );
  });
});
