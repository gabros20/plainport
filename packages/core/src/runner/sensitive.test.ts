// The runner's sensitive mode against a fake spawner: a child prints a canary, then ends every way a run can end. On
// every path the canary is absent from events, findings, argv and thrown errors, and present in the ok value only
// when the child exited 0. The same matrix against real process groups is in packages/host-macos (sensitive.test.ts).

import { describe, expect, test } from "bun:test";
import type { PlainportEvent } from "@plainport/contract";
import {
  type Canary,
  expectNoCanary,
  makeCanary,
  makeMasterKeyCanary,
  recordArgv,
} from "../testing/canary.ts";
import { RingBuffer } from "./ring-buffer.ts";
import { parseSensitiveJson, runProcess } from "./runner.ts";
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

  write(stream: "stdout" | "stderr", text: string): void {
    if (this.closed) return;
    const bytes = encode(text);
    this.written.push(bytes);
    (stream === "stdout" ? this.out : this.err).enqueue(bytes);
  }

  exit(code: number | null, signal: string | null = null): void {
    if (!this.alive) return;
    this.alive = false;
    this.resolveExit({ code, signal });
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.broken) this.out.close();
    this.err.close();
  }

  breakStdout(error: Error): void {
    this.broken = true;
    this.out.error(error);
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
    if (child === undefined || !child.alive) return false;
    if (signal !== 0) child.exit(null, signal);
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

/** Runs one scripted child in sensitive mode and collects everywhere the canary must not be. */
const runCase = async (script: (child: FakeChild) => void, overrides: Partial<RunSpec> = {}) => {
  const spawner = new FakeSpawner(script);
  const recorded = recordArgv(spawner);
  const events: PlainportEvent[] = [];
  const errors: unknown[] = [];
  const result = await runProcess(recorded.spawner, {
    ...spec(overrides),
    log: { op: "secret", emit: (event) => events.push(event) },
  }).catch((error: unknown) => {
    errors.push(error);
    return undefined;
  });
  const findings = result === undefined || result.ok ? [] : [result.finding];
  return { result, spawner, argv: recorded.argv, events, errors, findings };
};

type Case = Awaited<ReturnType<typeof runCase>>;

const expectClean = (canary: Canary, run: Case): void => {
  expectNoCanary([canary], {
    events: run.events,
    findings: run.findings,
    argv: run.argv,
    errors: run.errors,
  });
  expect(run.events).toEqual([]);
  expect(run.errors).toEqual([]);
};

/** A failure names the label, the stop reason and byte counts, and nothing the child printed. */
const expectFailure = (run: Case, code: string, stdoutBytes: number): string => {
  expect(run.result).toMatchObject({ ok: false, finding: { code } });
  const message = run.result?.ok === false ? run.result.finding.message : "";
  expect(message).toStartWith("security ");
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
      child.exit(0);
    });
    expectClean(canary, run);
    expect(run.result?.ok).toBe(true);
    if (!run.result?.ok) return;
    expect(decode(run.result.value.captured as Uint8Array)).toBe(`${canary.value}\n`);
    // Only captured holds stdout: its tail stays empty.
    expect(run.result.value.stdout).toEqual({ text: "", droppedBytes: 0 });
    expectWiped(run.spawner.spawned[0]);
  });

  test("exits 1: an ok outcome with its exit code, and no stdout in it at all", async () => {
    const canary = makeCanary();
    const run = await runCase((child) => {
      child.write("stdout", `${canary.value}\n`);
      child.write("stderr", "security: item not found\n");
      child.exit(1);
    });
    expectClean(canary, run);
    expect(run.result).toMatchObject({
      ok: true,
      value: { exitCode: 1, stderr: { text: "security: item not found\n" } },
    });
    if (!run.result?.ok) return;
    expect(run.result.value.captured).toBeUndefined();
    expectNoCanary([canary], { findings: [run.result.value] });
    expectWiped(run.spawner.spawned[0]);
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
    expect(run.result?.ok === false && run.result.finding.message).toContain("4096 bytes");
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
  });

  test("a string stdin, which may hold a secret, is overwritten once the run ends", async () => {
    const canary = makeCanary();
    const run = await runCase((child) => child.exit(0), { stdin: `${canary.value}\n` });
    expect(run.result?.ok).toBe(true);
    const stdin = run.spawner.requests[0]?.stdin as Uint8Array;
    expect(stdin.length).toBe(canary.value.length + 1);
    expect(stdin.every((byte) => byte === 0)).toBe(true);
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
