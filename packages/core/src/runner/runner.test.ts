// The runner's logic against a fake spawner: deadlines, TERM then KILL, bounded output, lines and log events.
// The same behaviour against real process groups is tested in packages/host-macos (runner.test.ts).

import { describe, expect, test } from "bun:test";
import { FindingSchema, type PlainportEvent } from "@plainport/contract";
import { RingBuffer } from "./ring-buffer.ts";
import { runProcess, splitRecords } from "./runner.ts";
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
    this.closePipes();
  }

  /** The last holder of the pipes lets go (used when one outside the group held them). */
  closePipes(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.broken.has("stdout")) this.out.close();
    if (!this.broken.has("stderr")) this.err.close();
  }

  private readonly broken = new Set<"stdout" | "stderr">();
  /** The pipe itself fails (EIO from the kernel): reading it rejects from here on, instead of ending. */
  breakPipe(stream: "stdout" | "stderr", error: Error): void {
    if (this.closed || this.broken.has(stream)) return;
    this.broken.add(stream);
    (stream === "stdout" ? this.out : this.err).error(error);
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

describe("runner (fake spawner): capturing the whole stdout", () => {
  test("capture returns every stdout byte, beyond the tail limit, and splitRecords splits on NUL", async () => {
    const spawner = new FakeSpawner((child) => {
      child.write("stdout", "first\0sec");
      child.write("stdout", `ond\0${"z".repeat(5000)}\0`);
      child.exit(0);
    });
    const result = await runProcess(
      spawner,
      spec({ outputLimitBytes: 16, capture: { maxBytes: 1_000_000 } }),
    );
    if (!result.ok) throw new Error(result.finding.message);
    const { captured } = result.value;
    expect(captured).toBeInstanceOf(Uint8Array);
    expect(captured?.length).toBe(5 + 1 + 6 + 1 + 5000 + 1);
    const records = splitRecords(captured as Uint8Array, 0).map((r) => new TextDecoder().decode(r));
    expect(records).toEqual(["first", "second", "z".repeat(5000)]);
    expect(result.value.stdout.droppedBytes).toBeGreaterThan(0);
  });

  test("without capture there is no captured field", async () => {
    const spawner = new FakeSpawner((child) => {
      child.write("stdout", "x\n");
      child.exit(0);
    });
    const result = await runProcess(spawner, spec());
    expect(result.ok && result.value.captured).toBeUndefined();
  });

  test("output past the capture cap fails the run as process.output-too-large and stops the group", async () => {
    let running = true;
    const spawner = new FakeSpawner(async (child) => {
      // Bounded, so a broken cap fails the test instead of hanging it.
      for (let i = 0; running && child.leaderAlive && i < 200; i++) {
        child.write("stdout", "y".repeat(100));
        await ms(1);
      }
      child.exit(0);
    });
    const result = await runProcess(spawner, spec({ capture: { maxBytes: 1000 } }));
    running = false;
    expect(result).toMatchObject({ ok: false, exitCode: 1, finding: { code: "process.output-too-large" } });
    expect(spawner.signals[0]).toBe("SIGTERM");
  });

  test("output that crosses the cap after the leader was reaped still fails: never a shortened ok", async () => {
    // The leader exits first; its last writes are still in the pipe (held open here) and arrive while draining.
    const spawner = new FakeSpawner(async (child) => {
      child.leftovers = 1;
      child.exit(0);
      child.leftovers = 0;
      await ms(5);
      child.write("stdout", "a".repeat(600));
      child.write("stdout", "b".repeat(600));
      child.closePipes();
    });
    const result = await runProcess(spawner, spec({ capture: { maxBytes: 1000 } }));
    expect(result).toMatchObject({ ok: false, exitCode: 1, finding: { code: "process.output-too-large" } });
  });

  test("output that crosses the cap in the same tick as the exit fails too", async () => {
    const spawner = new FakeSpawner((child) => {
      child.write("stdout", "a".repeat(600));
      child.write("stdout", "b".repeat(600));
      child.exit(0);
    });
    const result = await runProcess(spawner, spec({ capture: { maxBytes: 1000 } }));
    expect(result).toMatchObject({ ok: false, finding: { code: "process.output-too-large" } });
  });

  test("output of exactly the cap is kept whole", async () => {
    const spawner = new FakeSpawner((child) => {
      child.write("stdout", "a".repeat(600));
      child.write("stdout", "b".repeat(400));
      child.exit(0);
    });
    const result = await runProcess(spawner, spec({ capture: { maxBytes: 1000 } }));
    if (!result.ok) throw new Error(result.finding.message);
    expect(result.value.captured?.length).toBe(1000);
  });

  test("a capture cap must be positive", async () => {
    await expect(runProcess(new FakeSpawner(), spec({ capture: { maxBytes: 0 } }))).rejects.toThrow(
      /maxBytes/,
    );
  });

  test("splitRecords keeps empty records in the middle and drops only the final empty one", () => {
    const records = splitRecords(encode("a\n\nb\n"), 10).map((r) => new TextDecoder().decode(r));
    expect(records).toEqual(["a", "", "b"]);
    expect(splitRecords(encode("tail"), 10).map((r) => new TextDecoder().decode(r))).toEqual(["tail"]);
    expect(splitRecords(new Uint8Array(0), 0)).toEqual([]);
  });
});

describe("runner (fake spawner): a capture is whole, or the run fails", () => {
  test("a read error on stdout during a normal drain is process.output-incomplete, never a shortened ok", async () => {
    // The child writes, the pipe then fails (EIO) while the drain is still in progress, and the child exits 0.
    const spawner = new FakeSpawner(async (child) => {
      child.write("stdout", "first\0second\0");
      await ms(5);
      child.breakPipe("stdout", Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" }));
      child.exit(0);
    });
    const result = await runProcess(spawner, spec({ capture: { maxBytes: 1000 } }));
    expect(result).toMatchObject({ ok: false, exitCode: 1, finding: { code: "process.output-incomplete" } });
    if (result.ok) return;
    expect(result.finding.message).toContain("EIO");
  });

  test("without capture, a read error keeps what was read and is reported as a log event", async () => {
    const spawner = new FakeSpawner(async (child) => {
      child.write("stdout", "before\n");
      await ms(5);
      child.breakPipe("stdout", new Error("EIO: i/o error, read"));
      child.exit(0);
    });
    const events: PlainportEvent[] = [];
    const result = await runProcess(
      spawner,
      spec({ log: { op: "op", emit: (event) => events.push(event) } }),
    );
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0, stdout: { text: "before\n" } } });
    expect(events).toContainEqual({
      type: "log",
      op: "op",
      level: "warn",
      message: expect.stringMatching(/stdout.*EIO/),
    });
  });

  test("leftovers stopped in capture mode are process.output-incomplete: one of them may have been writing", async () => {
    const spawner = new FakeSpawner((child) => {
      child.leftovers = 1;
      child.write("stdout", "partial\0");
      child.exit(0);
    });
    const result = await runProcess(spawner, spec({ capture: { maxBytes: 1000 } }));
    expect(result).toMatchObject({ ok: false, exitCode: 1, finding: { code: "process.output-incomplete" } });
    expect(spawner.signals).toEqual(["SIGTERM"]);
  });

  test("a callback that throws a non-Error value still propagates: the stopped group never comes back as ok", async () => {
    const spawner = new FakeSpawner((child) => child.write("stdout", "boom\n"));
    await expect(
      runProcess(
        spawner,
        spec({
          capture: { maxBytes: 1000 },
          onLine: () => {
            throw undefined;
          },
        }),
      ),
    ).rejects.toThrow(/not an Error/);
    expect(spawner.signals[0]).toBe("SIGTERM");
  });
});

describe("runner (fake spawner): pipes held by a process outside the group", () => {
  test("in capture mode a drain cut short is process.output-incomplete: the capture cannot be proven whole", async () => {
    const spawner = new FakeSpawner((child) => {
      child.write("stdout", "partial\0");
      child.leftovers = 1;
      child.exit(0);
      child.leftovers = 0;
    });
    const result = await runProcess(spawner, spec({ capture: { maxBytes: 1000 } }));
    expect(result).toMatchObject({ ok: false, exitCode: 1, finding: { code: "process.output-incomplete" } });
  });

  test("the run still returns soon after the group is gone, with what was read", async () => {
    const spawner = new FakeSpawner((child) => {
      child.write("stdout", "before the daemon\n");
      // The leader exits and nothing is left in its group, but an escaped daemon keeps both pipes open.
      child.leftovers = 1;
      child.exit(0);
      child.leftovers = 0;
    });
    const started = performance.now();
    const result = await runProcess(spawner, spec());
    expect(performance.now() - started).toBeLessThan(3000);
    expect(result).toMatchObject({
      ok: true,
      value: { exitCode: 0, stdout: { text: "before the daemon\n" } },
    });
  });
});

describe("runner (fake spawner): wholeStdout, stdout read as line records without keeping it", () => {
  const collect = () => {
    const lines: string[] = [];
    return {
      lines,
      onLine: (line: { stream: string; text: string; truncated: boolean }) => {
        if (line.stream === "stdout") lines.push(line.truncated ? `TRUNCATED:${line.text}` : line.text);
      },
    };
  };

  test("every stdout line reaches onLine, past the tail limit, and nothing is captured", async () => {
    const spawner = new FakeSpawner((child) => {
      for (let i = 0; i < 500; i++) child.write("stdout", `line ${i}\n`);
      child.write("stdout", "last without newline");
      child.exit(0);
    });
    const { lines, onLine } = collect();
    const result = await runProcess(spawner, spec({ wholeStdout: true, onLine, outputLimitBytes: 64 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(lines).toHaveLength(501);
    expect(lines.at(-1)).toBe("last without newline");
    expect(result.value.captured).toBeUndefined();
    expect(result.value.stdout.droppedBytes).toBeGreaterThan(0);
  });

  test("a stdout line longer than maxLineBytes fails as process.output-too-large and never reaches onLine cut", async () => {
    const spawner = new FakeSpawner(async (child) => {
      child.write("stdout", `short\n${"x".repeat(100)}\n`);
      await ms(50);
      child.exit(0);
    });
    const { lines, onLine } = collect();
    const result = await runProcess(spawner, spec({ wholeStdout: true, onLine, maxLineBytes: 32 }));
    expect(result).toMatchObject({ ok: false, exitCode: 1, finding: { code: "process.output-too-large" } });
    if (!result.ok) expect(result.finding.message).toContain("32");
    expect(lines.some((line) => line.startsWith("TRUNCATED"))).toBe(false);
    expect(spawner.signals[0]).toBe("SIGTERM");
  });

  test("an over-long last line read during the drain after the exit still fails the run", async () => {
    const spawner = new FakeSpawner((child) => {
      child.write("stdout", "y".repeat(100));
      child.exit(0);
    });
    const { onLine } = collect();
    const result = await runProcess(spawner, spec({ wholeStdout: true, onLine, maxLineBytes: 32 }));
    expect(result).toMatchObject({ ok: false, finding: { code: "process.output-too-large" } });
  });

  test("an over-long stderr line is only cut, as without wholeStdout", async () => {
    const spawner = new FakeSpawner((child) => {
      child.write("stderr", `${"e".repeat(100)}\n`);
      child.write("stdout", "fine\n");
      child.exit(0);
    });
    const { lines, onLine } = collect();
    const result = await runProcess(spawner, spec({ wholeStdout: true, onLine, maxLineBytes: 32 }));
    expect(result.ok).toBe(true);
    expect(lines).toEqual(["fine"]);
  });

  test("a stdout read error is process.output-incomplete", async () => {
    const spawner = new FakeSpawner(async (child) => {
      child.write("stdout", "first\n");
      await ms(5);
      child.breakPipe("stdout", Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" }));
      child.exit(0);
    });
    const result = await runProcess(spawner, spec({ wholeStdout: true, onLine: () => {} }));
    expect(result).toMatchObject({ ok: false, finding: { code: "process.output-incomplete" } });
  });

  test("leftovers stopped are process.output-incomplete", async () => {
    const spawner = new FakeSpawner((child) => {
      child.leftovers = 1;
      child.write("stdout", "partial\n");
      child.exit(0);
    });
    const result = await runProcess(spawner, spec({ wholeStdout: true, onLine: () => {} }));
    expect(result).toMatchObject({ ok: false, finding: { code: "process.output-incomplete" } });
  });

  test("stdout held open past the drain is process.output-incomplete", async () => {
    const spawner = new FakeSpawner((child) => {
      child.write("stdout", "partial\n");
      child.leftovers = 1;
      child.exit(0);
      child.leftovers = 0;
    });
    const result = await runProcess(spawner, spec({ wholeStdout: true, onLine: () => {} }));
    expect(result).toMatchObject({ ok: false, finding: { code: "process.output-incomplete" } });
  });

  test("wholeStdout needs onLine and excludes capture", async () => {
    await expect(runProcess(new FakeSpawner(), spec({ wholeStdout: true }))).rejects.toThrow(/onLine/);
    await expect(
      runProcess(new FakeSpawner(), spec({ wholeStdout: true, onLine: () => {}, capture: { maxBytes: 10 } })),
    ).rejects.toThrow(/capture/);
  });
});

describe("runner (fake spawner): wholeStdout lines are the child's lines (fix r2 N2, N3)", () => {
  test("a carriage return at the end of a stdout line is kept: it may be part of a name", async () => {
    const spawner = new FakeSpawner((child) => {
      child.write("stdout", "tar\r\nplain\n");
      child.write("stderr", "err\r\n");
      child.exit(0);
    });
    const seen: string[] = [];
    const result = await runProcess(
      spawner,
      spec({ wholeStdout: true, onLine: (line) => seen.push(`${line.stream}:${line.text}`) }),
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["stdout:tar\r", "stdout:plain", "stderr:err"]);
  });

  test("without wholeStdout a trailing carriage return is still dropped", async () => {
    const spawner = new FakeSpawner((child) => {
      child.write("stdout", "tar\r\n");
      child.exit(0);
    });
    const seen: string[] = [];
    await runProcess(spawner, spec({ onLine: (line) => seen.push(line.text) }));
    expect(seen).toEqual(["tar"]);
  });

  test("an endless stdout line fails as soon as it crosses maxLineBytes, not at its newline or a deadline", async () => {
    const spawner = new FakeSpawner(async (child) => {
      child.write("stdout", "z".repeat(100)); // no newline, and the child never exits by itself
    });
    const started = performance.now();
    const result = await runProcess(
      spawner,
      spec({ wholeStdout: true, onLine: () => {}, maxLineBytes: 32, idleTimeoutMs: 60_000 }),
    );
    expect(result).toMatchObject({ ok: false, finding: { code: "process.output-too-large" } });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(spawner.signals[0]).toBe("SIGTERM");
  });
});
