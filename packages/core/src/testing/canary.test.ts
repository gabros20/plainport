// The canary helper finds a planted secret wherever a leaky runner could put it: files, output, events, findings,
// argv and thrown errors, whole or in part, and every component of a master key in base64 and hex.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlainportEvent } from "@plainport/contract";
import { runProcess } from "../runner/runner.ts";
import type { ChildProcess, RunSpec, Spawner } from "../runner/types.ts";
import { expectNoCanary, findCanaries, makeCanary, makeMasterKeyCanary, recordArgv } from "./canary.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "plainport-canary-"));
  dirs.push(dir);
  return dir;
};

/** Stops the child `printing` started last. */
let stop: () => void = () => {};

/** A child that prints `text` on stdout, then exits with `code`, or hangs when code is null. */
const printing = (text: string, code: number | null): Spawner => ({
  spawn: (): ChildProcess => {
    let out!: ReadableStreamDefaultController<Uint8Array>;
    let err!: ReadableStreamDefaultController<Uint8Array>;
    let resolveExit!: (value: { code: number | null; signal: string | null }) => void;
    const child: ChildProcess & { alive: boolean } = {
      pid: 4242,
      alive: true,
      stdout: new ReadableStream({
        start: (c) => {
          out = c;
        },
      }),
      stderr: new ReadableStream({
        start: (c) => {
          err = c;
        },
      }),
      exited: new Promise((resolve) => {
        resolveExit = resolve;
      }),
    };
    queueMicrotask(() => {
      out.enqueue(new TextEncoder().encode(`${text}\n`));
      if (code !== null) {
        child.alive = false;
        resolveExit({ code, signal: null });
        out.close();
        err.close();
      }
    });
    stop = () => {
      if (!child.alive) return;
      child.alive = false;
      resolveExit({ code: null, signal: "SIGTERM" });
      out.close();
      err.close();
    };
    return child;
  },
  signalGroup: (_pgid, signal) => {
    if (signal !== 0) stop();
    return false;
  },
});
const spec = (overrides: Partial<RunSpec> = {}): RunSpec => ({
  command: "/usr/bin/tool",
  cwd: "/tmp",
  env: { PATH: "/usr/bin:/bin" },
  ...overrides,
});

describe("canary: the planted values", () => {
  test("each canary is unique, and its forms include the value and both halves", () => {
    const a = makeCanary("token");
    const b = makeCanary("token");
    expect(a.value).not.toBe(b.value);
    const texts = a.forms.map((form) => form.text);
    expect(texts).toContain(a.value);
    expect(texts.some((text) => a.value.startsWith(text) && text !== a.value)).toBe(true);
    expect(texts.some((text) => a.value.endsWith(text) && text !== a.value)).toBe(true);
    for (const form of a.forms) expect(form.text.length).toBeGreaterThanOrEqual(12);
    // One identifier token, so a parser that quotes the token it stopped at quotes all of it.
    expect(a.value).toMatch(/^[A-Za-z_][A-Za-z0-9_]+$/);
  });

  test("a master key canary is restic's masterkey JSON, and each component is looked for in base64 and hex", () => {
    const canary = makeMasterKeyCanary();
    const parsed = JSON.parse(canary.value) as { mac: { k: string; r: string }; encrypt: string };
    const names = canary.forms.map((form) => form.name);
    for (const [part, base64, size] of [
      ["encrypt", parsed.encrypt, 32],
      ["mac.k", parsed.mac.k, 16],
      ["mac.r", parsed.mac.r, 16],
    ] as const) {
      const bytes = Buffer.from(base64, "base64");
      expect(bytes.length).toBe(size);
      const texts = canary.forms.map((form) => form.text);
      expect(texts).toContain(base64);
      expect(texts).toContain(bytes.toString("hex"));
      expect(names).toContain(`${part} (base64)`);
      expect(names).toContain(`${part} (hex)`);
    }
  });
});

describe("canary: catches a deliberately leaky runner", () => {
  test("the default (not sensitive) runner puts stdout into a timeout's finding: the helper fails the test", async () => {
    const canary = makeCanary();
    const result = await runProcess(
      printing(canary.value, null),
      spec({ idleTimeoutMs: 30, killGraceMs: 20 }),
    );
    expect(result.ok).toBe(false);
    const findings = result.ok ? [] : [result.finding];
    expect(findCanaries([canary], { findings })).not.toEqual([]);
    expect(() => expectNoCanary([canary], { findings })).toThrow(/findings\[0\]/);
  });

  test("a runner that logs its lines leaks through events; half a canary is found too", async () => {
    const canary = makeCanary();
    const events: PlainportEvent[] = [];
    const half = canary.value.slice(0, Math.ceil(canary.value.length / 2));
    await runProcess(printing(half, 0), spec({ log: { op: "test", emit: (event) => events.push(event) } }));
    const hits = findCanaries([canary], { events });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.join("\n")).toContain("events[0]");
    // The report names the place and the form, never the value itself.
    expect(hits.join("\n")).not.toContain(half);
  });

  test("a secret passed in argv is found in the recorded argv", async () => {
    const canary = makeCanary();
    const recorded = recordArgv(printing("hello", 0));
    await runProcess(recorded.spawner, spec({ args: ["--password", canary.value] }));
    expect(recorded.argv).toEqual([["/usr/bin/tool", "--password", canary.value]]);
    expect(findCanaries([canary], { argv: recorded.argv })).not.toEqual([]);
  });

  test("a thrown error found by its message, its cause or its fields", () => {
    const canary = makeCanary();
    const plain = new Error(`bad value ${canary.value}`);
    const caused = new Error("outer", { cause: new Error(`inner ${canary.value}`) });
    const fielded = Object.assign(new Error("parse failed"), { input: canary.value });
    // JSON.parse quotes what it could not read: exactly why a caller never parses a secret with it bare.
    let parseError: unknown;
    try {
      JSON.parse(`{"key": ${canary.value}}`);
    } catch (error) {
      parseError = error;
    }
    for (const error of [plain, caused, fielded, parseError]) {
      expect(findCanaries([canary], { errors: [error] })).not.toEqual([]);
    }
    expect(findCanaries([canary], { errors: [new Error("nothing here")] })).toEqual([]);
  });

  test("files under the sandbox are searched, nested, binary and through symlink targets", () => {
    const canary = makeCanary();
    const master = makeMasterKeyCanary();
    const dir = tempDir();
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    writeFileSync(join(dir, "clean.txt"), "nothing\n");
    expect(findCanaries([canary, master], { dirs: [dir] })).toEqual([]);
    writeFileSync(
      join(dir, "a", "b", "log.bin"),
      Buffer.concat([Buffer.from([0, 255, 7]), Buffer.from(canary.value)]),
    );
    const key = JSON.parse(master.value) as { mac: { r: string } };
    symlinkSync(Buffer.from(key.mac.r, "base64").toString("hex"), join(dir, "a", "link"));
    const hits = findCanaries([canary, master], { dirs: [dir] }).join("\n");
    expect(hits).toContain(join("a", "b", "log.bin"));
    expect(hits).toContain("mac.r (hex)");
    expect(() => expectNoCanary([canary, master], { dirs: [dir] })).toThrow(/canary found/);
  });

  test("captured stdout and stderr, as text or bytes, and findings as objects", () => {
    const master = makeMasterKeyCanary();
    const key = JSON.parse(master.value) as { encrypt: string };
    const hex = Buffer.from(key.encrypt, "base64").toString("hex");
    expect(findCanaries([master], { output: [new TextEncoder().encode(`key ${hex}\n`)] }).join()).toContain(
      "encrypt (hex)",
    );
    expect(
      findCanaries([master], {
        findings: [{ code: "x", message: "m", data: { nested: [key.encrypt] } }],
      }).join(),
    ).toContain("encrypt (base64)");
    expect(() => expectNoCanary([master], { output: ["clean"], findings: [{ code: "x" }] })).not.toThrow();
  });
});
