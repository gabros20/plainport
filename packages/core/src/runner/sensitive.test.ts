// The runner's sensitive mode against a fake spawner: a child prints a canary, then ends every way a run can end. On
// every path the canary is absent from events, findings, argv, thrown errors, plainport's own stdout and stderr and
// the returned outcome, and present only in the ok value's captured stdout when the child exited 0. The same matrix
// against real process groups is in packages/host-macos (sensitive.t1.test.ts).

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type Canary,
  collectRun,
  expectNoCanary,
  makeCanary,
  makeMasterKeyCanary,
  recordArgv,
} from "../testing/canary.ts";
import { RingBuffer } from "./ring-buffer.ts";
import { bufferProbe, bytesInclude, parseSensitiveJson, runProcess, stderrClasses } from "./runner.ts";
import type { ChildProcess, GroupSignal, RunSpec, Spawner } from "./types.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** A scripted child; every chunk it wrote is kept, so a test can see whether the runner overwrote it. */
class FakeChild implements ChildProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  readonly written: Uint8Array[] = [];
  alive = true;
  /** Processes the leader left in its group: the group is not empty until they are signalled. */
  leftovers = false;
  /** A process outside the group holds the pipes: they never close. */
  heldOpen = false;
  private out!: ReadableStreamDefaultController<Uint8Array>;
  private err!: ReadableStreamDefaultController<Uint8Array>;
  private resolveExit!: (value: { code: number | null; signal: string | null }) => void;
  private closed = false;
  private broken = false;

  constructor(readonly pid: number) {
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

  /** As a Node Buffer when asked: its slice() shares memory instead of copying. */
  write(stream: "stdout" | "stderr", text: string, as: "bytes" | "buffer" = "bytes"): void {
    if (this.closed) return;
    const bytes = as === "buffer" ? Buffer.from(text) : encode(text);
    this.written.push(bytes);
    try {
      (stream === "stdout" ? this.out : this.err).enqueue(bytes);
    } catch {
      // The runner cancelled its reader: the pipe is gone, as a real write would find it (EPIPE).
    }
  }

  exit(code: number | null, signal: string | null = null): void {
    if (!this.alive) return;
    this.alive = false;
    this.resolveExit({ code, signal });
    if (!this.leftovers) this.close();
  }

  close(): void {
    if (this.closed || this.heldOpen) return;
    this.closed = true;
    if (!this.broken) this.out.close();
    if (!this.brokenErr) this.err.close();
  }

  breakStdout(error: Error): void {
    this.broken = true;
    this.out.error(error);
  }

  private brokenErr = false;
  breakStream(stream: "stdout" | "stderr", error: Error): void {
    if (stream === "stdout") {
      this.breakStdout(error);
      return;
    }
    this.brokenErr = true;
    this.err.error(error);
  }
}

class FakeSpawner implements Spawner {
  readonly spawned: FakeChild[] = [];
  readonly requests: Parameters<Spawner["spawn"]>[0][] = [];
  constructor(private readonly script: (child: FakeChild) => void) {}

  spawn(request: Parameters<Spawner["spawn"]>[0]): ChildProcess {
    this.requests.push(request);
    const child = new FakeChild(2000 + this.spawned.length);
    this.spawned.push(child);
    queueMicrotask(() => this.script(child));
    return child;
  }

  signalGroup(pgid: number, signal: GroupSignal): boolean {
    const child = this.spawned.find((c) => c.pid === pgid);
    if (child === undefined || !(child.alive || child.leftovers)) return false;
    if (signal === 0) return true;
    child.leftovers = false;
    if (child.alive) child.exit(null, signal);
    else child.close();
    return true;
  }
}

const spec = (overrides: Partial<RunSpec> = {}): RunSpec => ({
  command: "/usr/bin/security",
  args: ["find-generic-password", "-w"],
  cwd: "/tmp",
  env: { PATH: "/usr/bin:/bin" },
  sensitive: true,
  idleTimeoutMs: 40,
  killGraceMs: 20,
  ...overrides,
});

/** Runs one scripted child in sensitive mode and collects everywhere the canary must not be (collectRun). */
const runCase = async (script: (child: FakeChild) => void, overrides: Partial<RunSpec> = {}) => {
  const spawner = new FakeSpawner(script);
  const recorded = recordArgv(spawner);
  const run = await collectRun((log) => runProcess(recorded.spawner, { ...spec(overrides), log }), {
    argv: recorded.argv,
  });
  return { ...run, spawner, findings: run.places.findings ?? [], returned: run.places.returned ?? [] };
};

type Case = Awaited<ReturnType<typeof runCase>>;

const expectClean = (canary: Canary, run: Case): void => {
  expectNoCanary([canary], run.places);
  expect(run.events).toEqual([]);
  expect(run.errors).toEqual([]);
};

/** A failure names the label, the stop reason and byte counts, and nothing the child printed. */
const expectFailure = (run: Case, code: string, stdoutBytes: number): string => {
  expect(run.result).toMatchObject({ ok: false, finding: { code } });
  const message = run.result?.ok === false ? run.result.finding.message : "";
  expect(message).toMatch(/^security\b/);
  expect(message).toContain(`${stdoutBytes} bytes on stdout`);
  expect(message).not.toContain("last output");
  return message;
};

/** Every chunk the child wrote was overwritten once the run ended. */
const expectWiped = (child: FakeChild | undefined): void => {
  expect(child).toBeDefined();
  for (const chunk of child?.written ?? []) expect(chunk.every((byte) => byte === 0)).toBe(true);
};

describe("runner: sensitive mode, a child that prints a canary", () => {
  test("exits 0: the canary is in the ok value's captured stdout and nowhere else", async () => {
    const canary = makeCanary();
    const run = await runCase((child) => {
      child.write("stdout", `${canary.value}\n`);
      child.write("stderr", `${canary.value}\n`);
      child.exit(0);
    });
    expectClean(canary, run);
    expect(run.result?.ok).toBe(true);
    if (!run.result?.ok) return;
    expect(decode(run.result.value.captured as Uint8Array)).toBe(`${canary.value}\n`);
    // Only captured holds stdout; stderr is returned as a count, with no classifier no code.
    expect(run.result.value.stdout).toEqual({ text: "", droppedBytes: 0 });
    expect(run.result.value.stderr).toEqual({ text: "", droppedBytes: 0 });
    const bytes = canary.value.length + 1;
    expect(run.result.value.privateOutput).toEqual({ stdoutBytes: bytes, stderrBytes: bytes });
    expectWiped(run.spawner.spawned[0]);
  });

  test("Node Buffer chunks, whose slice() shares memory: captured is the bytes, not the zeros the wipe left", async () => {
    const canary = makeCanary();
    const run = await runCase((child) => {
      child.write("stdout", canary.value.slice(0, 10), "buffer");
      child.write("stdout", `${canary.value.slice(10)}\n`, "buffer");
      child.exit(0);
    });
    expectClean(canary, run);
    expect(run.result?.ok && decode(run.result.value.captured as Uint8Array)).toBe(`${canary.value}\n`);
    expectWiped(run.spawner.spawned[0]);
  });

  test("exits 1: an ok outcome with its exit code, and no stdout in it at all", async () => {
    const canary = makeCanary();
    const run = await runCase((child) => {
      child.write("stdout", `${canary.value}\n`);
      child.write("stderr", `security: ${canary.value} not found\n`);
      child.exit(1);
    });
    expectClean(canary, run);
    expect(run.result).toMatchObject({
      ok: true,
      value: { exitCode: 1, stderr: { text: "", droppedBytes: 0 } },
    });
    if (!run.result?.ok) return;
    expect(run.result.value.captured).toBeUndefined();
    expect(run.result.value.privateOutput?.stderrCode).toBeUndefined();
    expectWiped(run.spawner.spawned[0]);
  });

  test("classifyStderr: the outcome holds only the declared code it chose, never stderr", async () => {
    const canary = makeCanary();
    let seen = 0;
    // Matched as bytes: stderr is never decoded into a string, which nothing could overwrite.
    const classifyStderr = stderrClasses(["not-found", "signed-out", "other"], (stderr) => {
      seen = stderr.length;
      return bytesInclude(stderr, "not currently signed in")
        ? "signed-out"
        : bytesInclude(stderr, "not found")
          ? "not-found"
          : "other";
    });
    const run = await runCase(
      (child) => {
        child.write("stdout", `${canary.value}\n`);
        child.write("stderr", `[ERROR] ${canary.value}: you are not currently signed in\n`);
        child.exit(1);
      },
      { classifyStderr },
    );
    expectClean(canary, run);
    expect(seen).toBeGreaterThan(0);
    expect(run.result).toMatchObject({
      ok: true,
      value: { exitCode: 1, stderr: { text: "" }, privateOutput: { stderrCode: "signed-out" } },
    });
    // The typed reader: the code as the caller's closed union, checked against the declared codes.
    const code: "not-found" | "signed-out" | "other" | undefined = run.result?.ok
      ? classifyStderr.codeOf(run.result.value)
      : undefined;
    expect(code).toBe("signed-out");
    // A code it did not declare reads as undefined.
    if (run.result?.ok) {
      const forged = {
        ...run.result.value,
        privateOutput: { stdoutBytes: 0, stderrBytes: 0, stderrCode: "x" },
      };
      expect(classifyStderr.codeOf(forged)).toBeUndefined();
    }
    expectWiped(run.spawner.spawned[0]);
  });

  test("bytesInclude matches bytes without decoding them, at any offset, and only whole", () => {
    const bytes = encode("[ERROR] you are not currently signed in\n");
    expect(bytesInclude(bytes, "not currently signed in")).toBe(true);
    expect(bytesInclude(bytes.subarray(8), "you are")).toBe(true);
    expect(bytesInclude(bytes, "signed out")).toBe(false);
    expect(bytesInclude(bytes.subarray(0, 20), "not currently signed in")).toBe(false);
    expect(bytesInclude(new Uint8Array(0), "x")).toBe(false);
  });

  test("a stderr that fails mid-read with a classifier set: process.output-incomplete, never a classified cut", async () => {
    const canary = makeCanary();
    let classified = false;
    const run = await runCase(
      (child) => {
        child.write("stderr", `${canary.value}: not currently sig`);
        child.breakStream("stderr", Object.assign(new Error("read failed"), { code: "EIO" }));
        child.exit(1);
      },
      {
        classifyStderr: stderrClasses(["signed-out", "other"], () => {
          classified = true;
          return "other";
        }),
      },
    );
    expectNoCanary([canary], run.places);
    expect(classified).toBe(false);
    const message = expectFailure(run, "process.output-incomplete", 0);
    expect(message).toContain("stderr could not be read to the end: EIO");
  });

  test("classifyStderr returning an undeclared code, or throwing, is a bug thrown without stderr", async () => {
    const canary = makeCanary();
    const script = (child: FakeChild): void => {
      child.write("stderr", `${canary.value}\n`);
      child.exit(1);
    };
    const undeclared = await runCase(script, {
      classifyStderr: { codes: ["a"], classify: (stderr) => decode(stderr) },
    });
    const throwing = await runCase(script, {
      classifyStderr: {
        codes: ["a"],
        classify: (stderr) => {
          throw new Error(`cannot classify ${decode(stderr)}`);
        },
      },
    });
    for (const run of [undeclared, throwing]) {
      expect(run.errors).toHaveLength(1);
      expectNoCanary([canary], run.places);
      expect(String(run.errors[0])).toContain("classifyStderr");
    }
  });

  test("hangs: process.idle-timeout names the label and byte counts only", async () => {
    const canary = makeCanary();
    const run = await runCase((child) => {
      child.write("stdout", `${canary.value}\n`);
      child.write("stderr", `${canary.value}\n`);
    });
    expectClean(canary, run);
    const message = expectFailure(run, "process.idle-timeout", canary.value.length + 1);
    expect(message).toContain(`${canary.value.length + 1} bytes on stderr`);
    expectWiped(run.spawner.spawned[0]);
  });

  test("prints slowly: process.timeout carries none of it", async () => {
    const canary = makeCanary();
    let printed = 0;
    const run = await runCase(
      (child) => {
        const tick = setInterval(() => {
          if (!child.alive) return clearInterval(tick);
          child.write("stdout", canary.value.slice(printed, printed + 1));
          child.write("stderr", canary.value.slice(printed, printed + 1));
          printed += 1;
          if (printed >= canary.value.length) printed = 0;
        }, 2);
      },
      { idleTimeoutMs: 1_000, timeoutMs: 120 },
    );
    expectClean(canary, run);
    expect(run.result).toMatchObject({ ok: false, finding: { code: "process.timeout" } });
    expect(run.result?.ok === false && run.result.finding.message).toMatch(
      /\d+ bytes on stdout and \d+ bytes on stderr/,
    );
  });

  test("is cancelled: process.cancelled carries none of it", async () => {
    const canary = makeCanary();
    const controller = new AbortController();
    const run = await runCase(
      (child) => {
        child.write("stdout", `${canary.value}\n`);
        child.write("stderr", `${canary.value}\n`);
        setTimeout(() => controller.abort(), 5);
      },
      { signal: controller.signal, idleTimeoutMs: 5_000 },
    );
    expectClean(canary, run);
    expectFailure(run, "process.cancelled", canary.value.length + 1);
    expectWiped(run.spawner.spawned[0]);
  });

  test("prints half the canary and hangs: neither half reaches the finding", async () => {
    const canary = makeCanary();
    const half = canary.value.slice(0, Math.ceil(canary.value.length / 2));
    const run = await runCase((child) => child.write("stdout", half));
    expectClean(canary, run);
    expectFailure(run, "process.idle-timeout", half.length);
  });

  test("prints the canary a few bytes at a time, then hangs: no piece reaches anything", async () => {
    const canary = makeCanary();
    const run = await runCase((child) => {
      for (const piece of canary.value.match(/.{1,3}/g) ?? []) child.write("stdout", piece);
    });
    expectClean(canary, run);
    expectFailure(run, "process.idle-timeout", canary.value.length);
  });

  test("prints malformed JSON: the run is ok, and parseSensitiveJson refuses it without quoting it", async () => {
    const canary = makeMasterKeyCanary();
    const broken = canary.value.replace(/"encrypt":"/, '"encrypt":');
    const run = await runCase((child) => {
      child.write("stdout", broken);
      child.exit(0);
    });
    expectClean(canary, run);
    expect(run.result?.ok).toBe(true);
    if (!run.result?.ok) return;
    const captured = run.result.value.captured as Uint8Array;
    const errors: unknown[] = [];
    let parsed: ReturnType<typeof parseSensitiveJson>;
    try {
      parsed = parseSensitiveJson(captured);
    } catch (error) {
      errors.push(error);
    }
    expect(parsed).toBeUndefined();
    expect(errors).toEqual([]);
    expect(parseSensitiveJson(encode(canary.value))).toEqual({ value: JSON.parse(canary.value) });
    // With a schema: the value typed, and a mismatch refused the same way, never quoting the input.
    const MasterKey = z.object({ mac: z.object({ k: z.string(), r: z.string() }), encrypt: z.string() });
    const typed = parseSensitiveJson(encode(canary.value), MasterKey);
    expect(typed?.value.mac.k).toBe((JSON.parse(canary.value) as { mac: { k: string } }).mac.k);
    const strict = z.object({ encrypt: z.number() });
    let mismatch: unknown = "not run";
    try {
      mismatch = parseSensitiveJson(encode(canary.value), strict);
    } catch (error) {
      errors.push(error);
    }
    expect(mismatch).toBeUndefined();
    expect(errors).toEqual([]);
    // Bytes that are not UTF-8 are refused the same way.
    expect(parseSensitiveJson(new Uint8Array([0x22, 0xff, 0x22]))).toBeUndefined();
  });

  test("floods past the buffer: process.output-too-large with byte counts, never a cut capture", async () => {
    const canary = makeCanary();
    const run = await runCase(
      (child) => {
        child.write("stdout", `${canary.value}\n`);
        const tick = setInterval(() => {
          if (!child.alive) return clearInterval(tick);
          child.write("stdout", `${canary.value}\n`.repeat(64));
        }, 1);
      },
      { capture: { maxBytes: 4096 }, idleTimeoutMs: 5_000 },
    );
    expectClean(canary, run);
    expect(run.result).toMatchObject({ ok: false, finding: { code: "process.output-too-large" } });
    const message = run.result?.ok === false ? run.result.finding.message : "";
    expect(message).toContain("more than 4096 bytes");
    // The bytes actually seen, which crossed the limit.
    const seen = Number(/it printed (\d+) bytes on stdout/.exec(message)?.[1]);
    expect(seen).toBeGreaterThan(4096);
    expectWiped(run.spawner.spawned[0]);
  });

  test("without capture, the bound is outputLimitBytes", async () => {
    const canary = makeCanary();
    const run = await runCase(
      (child) => {
        child.write("stdout", `${canary.value}\n`.repeat(10));
        child.exit(0);
      },
      { outputLimitBytes: 64 },
    );
    expectClean(canary, run);
    expect(run.result).toMatchObject({ ok: false, finding: { code: "process.output-too-large" } });
  });

  test("cannot start: process.spawn-failed names the label and the error code, not the error's text", async () => {
    const canary = makeCanary();
    const spawner: Spawner = {
      spawn: () => {
        throw Object.assign(new Error(`spawn failed near ${canary.value}`), { code: "ENOENT" });
      },
      signalGroup: () => false,
    };
    const recorded = recordArgv(spawner);
    const result = await runProcess(
      recorded.spawner,
      spec({ env: { PATH: "/usr/bin", SECRET: canary.value } }),
    );
    expect(result).toMatchObject({ ok: false, finding: { code: "process.spawn-failed" } });
    const findings = result.ok ? [] : [result.finding];
    expectNoCanary([canary], { findings, argv: recorded.argv });
    expect(result.ok === false && result.finding.message).toContain("ENOENT");
    expect(result.ok === false && result.finding.message).toContain(
      "0 bytes on stdout and 0 bytes on stderr",
    );
  });

  test("an error code that is not a plain code is named unknown, at spawn and on a read", async () => {
    const canary = makeCanary();
    const spawner: Spawner = {
      spawn: () => {
        throw Object.assign(new Error("failed"), { code: canary.value });
      },
      signalGroup: () => false,
    };
    const spawned = await runProcess(spawner, spec());
    expectNoCanary([canary], { findings: spawned.ok ? [] : [spawned.finding] });
    expect(spawned.ok === false && spawned.finding.message).toContain("(unknown)");
    const read = await runCase((child) => {
      child.write("stdout", "x");
      child.breakStdout(Object.assign(new Error("failed"), { code: canary.value }));
      child.exit(0);
    });
    expectNoCanary([canary], read.places);
    expect(read.result?.ok === false && read.result.finding.message).toContain("unknown");
    // The read failure's warning names the code it could vouch for, and nothing else.
    expect(read.events).toEqual([
      {
        type: "log",
        op: "canary",
        level: "warn",
        message: "security: stdout could not be read to the end: unknown",
      },
    ]);
  });

  test("a stdout that fails mid-read: process.output-incomplete without the read error's text", async () => {
    const canary = makeCanary();
    const run = await runCase((child) => {
      child.write("stdout", `${canary.value}\n`);
      child.breakStdout(Object.assign(new Error(`EIO near ${canary.value}`), { code: "EIO" }));
      child.exit(0);
    });
    expectNoCanary([canary], { events: run.events, findings: run.findings, errors: run.errors });
    expect(run.result).toMatchObject({ ok: false, finding: { code: "process.output-incomplete" } });
    expect(run.result?.ok === false && run.result.finding.message).toContain("EIO");
    expect(run.result?.ok === false && run.result.finding.message).toContain(
      `${canary.value.length + 1} bytes on stdout`,
    );
  });

  test("exits while something outside its group holds stdout open: process.output-incomplete, counts only", async () => {
    const canary = makeCanary();
    const run = await runCase((child) => {
      child.heldOpen = true;
      child.write("stdout", `${canary.value}\n`);
      child.write("stderr", `${canary.value}\n`);
      child.exit(0);
    });
    expectClean(canary, run);
    expect(expectFailure(run, "process.output-incomplete", canary.value.length + 1)).toContain(
      "a process outside its group kept its stdout open",
    );
    expectWiped(run.spawner.spawned[0]);
  });

  test("exits leaving a writer in its group: process.output-incomplete, counts only", async () => {
    const canary = makeCanary();
    const run = await runCase((child) => {
      child.leftovers = true;
      child.write("stdout", `${canary.value}\n`);
      child.write("stderr", `${canary.value}\n`);
      child.exit(0);
    });
    expectClean(canary, run);
    expect(expectFailure(run, "process.output-incomplete", canary.value.length + 1)).toContain(
      "left processes running in its group",
    );
    expectWiped(run.spawner.spawned[0]);
  });

  test("a string stdin, which may hold a secret, is overwritten once the run ends", async () => {
    const canary = makeCanary();
    const run = await runCase((child) => child.exit(0), { stdin: `${canary.value}\n` });
    expect(run.result?.ok).toBe(true);
    const stdin = run.spawner.requests[0]?.stdin as Uint8Array;
    expect(stdin.length).toBe(canary.value.length + 1);
    expect(stdin.every((byte) => byte === 0)).toBe(true);
  });

  test("already cancelled before it starts: process.cancelled with byte counts, nothing spawned", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await runCase(() => {}, { signal: controller.signal });
    expect(run.spawner.requests).toEqual([]);
    expectFailure(run, "process.cancelled", 0);
    expect(run.result?.ok === false && run.result.finding.message).toContain("0 bytes on stderr");
  });

  test("onLine and wholeStdout are refused: nothing would keep a callback from seeing the output", async () => {
    const spawner = new FakeSpawner((child) => child.exit(0));
    await expect(runProcess(spawner, spec({ onLine: () => {} }))).rejects.toThrow(RangeError);
    await expect(runProcess(spawner, spec({ onLine: () => {}, wholeStdout: true }))).rejects.toThrow(
      RangeError,
    );
    expect(spawner.requests).toEqual([]);
  });
});

describe("runner: sensitive mode, the runner's own buffers", () => {
  /** Runs `run` while recording every buffer the capture and the private collectors allocate. */
  const observed = async (run: () => Promise<unknown>): Promise<Uint8Array[]> => {
    const seen: Uint8Array[] = [];
    bufferProbe.observe = (bytes) => seen.push(bytes);
    try {
      await run();
    } finally {
      bufferProbe.observe = undefined;
    }
    return seen;
  };
  const zeros = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0);
  const classes = stderrClasses(["a", "b"], () => "a");

  test("are overwritten when the run ends: exit 0, exit 1, a timeout, a classifier that throws", async () => {
    const canary = makeCanary();
    const printing = (end: (child: FakeChild) => void) => (child: FakeChild) => {
      child.write("stdout", `${canary.value}\n`);
      child.write("stderr", `${canary.value}\n`);
      end(child);
    };
    const cases: [string, () => Promise<unknown>][] = [
      [
        "exit 0",
        () =>
          runCase(
            printing((child) => child.exit(0)),
            { classifyStderr: classes },
          ),
      ],
      [
        "exit 1",
        () =>
          runCase(
            printing((child) => child.exit(1)),
            { classifyStderr: classes },
          ),
      ],
      [
        "timeout",
        () =>
          runCase(
            printing(() => {}),
            { classifyStderr: classes },
          ),
      ],
      [
        "classifier throws",
        () =>
          runCase(
            printing((child) => child.exit(1)),
            {
              classifyStderr: {
                codes: ["a"],
                classify: () => {
                  throw new Error("no");
                },
              },
            },
          ),
      ],
    ];
    for (const [name, run] of cases) {
      const seen = await observed(run);
      // The capture's chunk and the stderr ring at least; a classifier's copy too where one ran.
      expect({ name, buffers: seen.length >= 2 }).toEqual({ name, buffers: true });
      expect({ name, wiped: seen.every(zeros) }).toEqual({ name, wiped: true });
    }
  });

  test("when the runner throws (a spawner that fails to signal), output that arrives later is never kept", async () => {
    const canary = makeCanary();
    let child: FakeChild | undefined;
    const spawner = new FakeSpawner((c) => {
      child = c;
      c.write("stdout", `${canary.value}\n`);
    });
    spawner.signalGroup = () => {
      throw new Error("signal failed");
    };
    const seen: Uint8Array[] = [];
    bufferProbe.observe = (bytes) => seen.push(bytes);
    try {
      const thrown = await runProcess(spawner, spec({ classifyStderr: classes })).catch(
        (error: unknown) => error,
      );
      expect(String(thrown)).toContain("signal failed");
      const before = seen.length;
      // The child keeps writing after the throw: a sealed capture takes none of it.
      child?.write("stdout", `${canary.value}\n`);
      child?.write("stderr", `${canary.value}\n`);
      await Bun.sleep(20);
      expect(seen.length).toBe(before);
      expect(seen.every(zeros)).toBe(true);
    } finally {
      bufferProbe.observe = undefined;
    }
  });

  test("the probe sees real data: a default-mode capture is not overwritten", async () => {
    const seen = await observed(() =>
      runCase(
        (child) => {
          child.write("stdout", "data\n");
          child.exit(0);
        },
        { sensitive: false, capture: { maxBytes: 1024 } },
      ),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((bytes) => !zeros(bytes))).toBe(true);
  });
});

describe("runner: the default mode, unchanged", () => {
  test("a timeout's finding still quotes the last output, so sensitive mode is what keeps a secret out", async () => {
    const canary = makeCanary();
    const run = await runCase((child) => child.write("stdout", `${canary.value}\n`), { sensitive: false });
    expect(run.result?.ok === false && run.result.finding.message).toContain(canary.value);
    expect(() => expectNoCanary([canary], { findings: run.findings, events: run.events })).toThrow();
    expect(run.spawner.spawned[0]?.written[0]?.some((byte) => byte !== 0)).toBe(true);
  });
});

describe("runner: RingBuffer.wipe", () => {
  test("overwrites what it kept and forgets its counts", () => {
    const ring = new RingBuffer(8);
    ring.push(encode("abcdefghij"));
    ring.wipe();
    expect(ring.bytes()).toEqual(new Uint8Array(0));
    expect(ring.droppedBytes).toBe(0);
    ring.push(encode("xy"));
    expect(decode(ring.bytes())).toBe("xy");
  });
});
