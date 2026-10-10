// The canary helper finds a planted secret wherever a leaky runner could put it: files, output, events, findings,
// argv and thrown errors, whole or in part, and every component of a master key in base64 and hex.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlainportEvent } from "@plainport/contract";
import { runProcess } from "../runner/runner.ts";
import type { ChildProcess, RunSpec, Spawner } from "../runner/types.ts";
import {
  expectNoCanary,
  expectRunLeaksNothing,
  findCanaries,
  makeCanary,
  makeMasterKeyCanary,
  recordArgv,
  recordOwnOutput,
} from "./canary.ts";

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

  test("a canary split across chunks, events, findings or argv is found in the stream's concatenation", () => {
    const canary = makeCanary();
    const pieces = canary.value.match(/.{1,5}/g) as string[];
    expect(pieces.length).toBeGreaterThan(4);
    const encoder = new TextEncoder();
    expect(findCanaries([canary], { stdout: pieces.map((piece) => encoder.encode(piece)) }).join()).toContain(
      "stdout (all of it)",
    );
    expect(findCanaries([canary], { stderr: pieces }).join()).toContain("stderr (all of it)");
    const events = pieces.map((piece) => ({ type: "log", op: "x", level: "info", message: piece }));
    expect(findCanaries([canary], { events }).join()).toContain("events (all of");
    const findings = pieces.map((piece) => ({ code: "process.timeout", message: piece }));
    expect(findCanaries([canary], { findings }).join()).toContain("findings (all of");
    expect(findCanaries([canary], { argv: [["/bin/tool", ...pieces]] }).join()).toContain("argv (all of it)");
    expect(findCanaries([canary], { returned: [{ stderr: { text: pieces.join("") } }] })).not.toEqual([]);
    // Each piece alone is too short to count, so it is the concatenation that finds them.
    expect(findCanaries([canary], { output: [pieces[0] as string] })).toEqual([]);
  });

  test("a file whose name holds a canary is reported without its name", () => {
    const canary = makeCanary();
    const dir = tempDir();
    writeFileSync(join(dir, `${canary.value}.txt`), "clean");
    const hits = findCanaries([canary], { dirs: [dir] });
    expect(hits).not.toEqual([]);
    expect(hits.join("\n")).toContain("name withheld");
    expect(hits.join("\n")).not.toContain(canary.value.slice(0, 12));
    let message = "";
    try {
      expectNoCanary([canary], { dirs: [dir] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("canary found");
    expect(findCanaries([canary], { errors: [message] })).toEqual([]);
  });
});

describe("canary: pieces and other spellings", () => {
  /** The random part of a plain canary: what makes it a secret, as opposed to its fixed `canary_<label>_` prefix. */
  const randomOf = (canary: { value: string }): string =>
    canary.value.slice(canary.value.lastIndexOf("_") + 1);

  test("any 12-character piece of the random part is found, interior slices included", () => {
    const canary = makeCanary();
    const random = randomOf(canary);
    const middle = canary.value.slice(13, 33);
    const first15 = random.slice(0, 15);
    const interior = random.slice(9, 21);
    for (const piece of [middle, first15, interior]) {
      expect(findCanaries([canary], { findings: [{ message: `x ${piece} y` }] })).not.toEqual([]);
      expect(findCanaries([canary], { output: [`before${piece}after`] })).not.toEqual([]);
    }
    // Shorter than 12, or only the fixed prefix that every canary of the label shares, is not a piece.
    expect(findCanaries([canary], { output: [random.slice(0, 11)] })).toEqual([]);
    expect(findCanaries([canary], { output: ["canary_secret_"] })).toEqual([]);
    // The report names the form, never the piece.
    const hits = findCanaries([canary], { output: [interior] }).join("\n");
    expect(hits).toContain("a piece");
    expect(hits).not.toContain(interior);
  });

  test("the cuts the default runner makes are found: the 600-character tail of a message, the 2000-character log line", async () => {
    const canary = makeCanary();
    // lastOutput keeps the last 600 characters: a canary followed by 580 more keeps its last 20.
    const tail = await runProcess(
      printing(`${canary.value}${"x".repeat(580)}`, null),
      spec({ idleTimeoutMs: 30, killGraceMs: 20 }),
    );
    expect(tail.ok).toBe(false);
    const message = tail.ok ? "" : tail.finding.message;
    expect(message).not.toContain(canary.value);
    expect(message).toContain(canary.value.slice(-20));
    expect(findCanaries([canary], { findings: tail.ok ? [] : [tail.finding] })).not.toEqual([]);
    // A log line is cut at 2000 characters: "tool: " and 1964 more leave the canary's first 30.
    const events: PlainportEvent[] = [];
    await runProcess(
      printing(`${"y".repeat(1964)}${canary.value}`, 0),
      spec({ log: { op: "x", emit: (event) => events.push(event) } }),
    );
    const logged = JSON.stringify(events);
    expect(logged).not.toContain(canary.value);
    expect(logged).toContain(canary.value.slice(0, 30));
    expect(findCanaries([canary], { events })).not.toEqual([]);
  });

  test("a master key component cut to its first 15 hex characters, or a middle slice of its base64, is found", () => {
    const master = makeMasterKeyCanary();
    const key = JSON.parse(master.value) as { encrypt: string; mac: { k: string } };
    const hex = Buffer.from(key.encrypt, "base64").toString("hex");
    expect(findCanaries([master], { output: [hex.slice(0, 15)] }).join()).toContain("encrypt (hex)");
    expect(findCanaries([master], { findings: [{ message: key.mac.k.slice(5, 19) }] }).join()).toContain(
      "mac.k (base64)",
    );
  });

  test("base64 at every alignment and base64url find a value encoded inside a larger envelope", () => {
    const canary = makeCanary();
    for (const prefix of ["", "a", "ab", "abc"]) {
      const envelope = Buffer.from(`${prefix}{"token":"${canary.value}"}`);
      expect(findCanaries([canary], { output: [envelope.toString("base64")] })).not.toEqual([]);
      expect(findCanaries([canary], { output: [envelope.toString("base64url")] })).not.toEqual([]);
    }
    expect(findCanaries([canary], { output: [Buffer.from(canary.value).toString("hex")] })).not.toEqual([]);
    const master = makeMasterKeyCanary();
    const key = JSON.parse(master.value) as { encrypt: string };
    const raw = Buffer.from(key.encrypt, "base64");
    for (const prefix of [[], [1], [1, 2]]) {
      const shifted = Buffer.concat([Buffer.from(prefix), raw, Buffer.from([9, 9, 9])]);
      expect(findCanaries([master], { output: [shifted.toString("base64")] }).join()).toContain("encrypt");
      expect(findCanaries([master], { output: [shifted.toString("base64url")] }).join()).toContain("encrypt");
    }
  });

  test("recordOwnOutput records a logged object as the console would print it, fields included", async () => {
    const canary = makeCanary();
    const own = await recordOwnOutput(async () => {
      console.log({ outcome: { stderr: { text: canary.value } } });
      console.error("%s failed", canary.value);
    });
    expect(findCanaries([canary], { stdout: own.stdout })).not.toEqual([]);
    expect(findCanaries([canary], { stderr: own.stderr })).not.toEqual([]);
    expect(own.stdout.join("")).not.toContain("[object Object]");
  });
});

describe("canary: expectRunLeaksNothing, the shared leak gate", () => {
  test("fails a default-mode run whose timeout quotes the secret, passes the same run in sensitive mode", async () => {
    const canary = makeCanary();
    const leaky = expectRunLeaksNothing([canary], (log) =>
      runProcess(printing(canary.value, null), spec({ idleTimeoutMs: 30, killGraceMs: 20, log })),
    );
    await expect(leaky).rejects.toThrow(/canary found/);
    const quiet = await expectRunLeaksNothing([canary], (log) =>
      runProcess(
        printing(canary.value, null),
        spec({ idleTimeoutMs: 30, killGraceMs: 20, sensitive: true, log }),
      ),
    );
    expect(quiet.result).toMatchObject({ ok: false, finding: { code: "process.idle-timeout" } });
  });

  test("scans the returned outcome, own output and recorded argv; checks events and throws", async () => {
    const canary = makeCanary();
    // A default-mode success returns stdout in its tail: the returned outcome is a place.
    await expect(
      expectRunLeaksNothing([canary], () => runProcess(printing(canary.value, 0), spec())),
    ).rejects.toThrow(/returned\[0\]/);
    await expect(
      expectRunLeaksNothing([canary], async (log) => {
        console.log({ leaked: canary.value });
        return runProcess(printing("x", 0), spec({ sensitive: true, log }));
      }),
    ).rejects.toThrow(/stdout/);
    const recorded = recordArgv(printing("x", 0));
    await expect(
      expectRunLeaksNothing(
        [canary],
        () => runProcess(recorded.spawner, spec({ sensitive: true, args: [canary.value] })),
        { argv: recorded.argv },
      ),
    ).rejects.toThrow(/argv/);
    await expect(
      expectRunLeaksNothing([canary], (log) => runProcess(printing("x", 0), spec({ log }))),
    ).rejects.toThrow(/logged 1 events/);
    await expect(
      expectRunLeaksNothing([canary], async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/threw 1 errors, expected none/);
    const thrown = await expectRunLeaksNothing(
      [canary],
      async () => {
        throw new Error("boom");
      },
      { throws: true },
    );
    expect(String(thrown.errors[0])).toContain("boom");
  });
});

describe("canary: pieces are positional, so two canaries of one label never match each other", () => {
  test("1000 pairs of same-label canaries: neither's value or spellings is a hit for the other", () => {
    for (let run = 0; run < 1000; run++) {
      const a = makeCanary();
      const b = makeCanary();
      const hits = findCanaries([a], { output: [b.value, ...b.forms.map((form) => form.text)] });
      if (hits.length > 0)
        throw new Error(`run ${run}: a second canary of the label was a hit: ${hits.join("; ")}`);
    }
  });

  test("the shared prefix and a few characters of another canary are no hit; 8 random characters on are", () => {
    const a = makeCanary();
    const b = makeCanary();
    const prefix = "canary_secret_";
    const random = a.value.slice(prefix.length);
    for (const n of [1, 2, 3, 4]) {
      expect(
        findCanaries([a], { output: [`${prefix}${b.value.slice(prefix.length, prefix.length + n)}`] }),
      ).toEqual([]);
    }
    expect(findCanaries([a], { output: [`${prefix}${random.slice(0, 8)}`] })).not.toEqual([]);
    // The same positional rule holds for the encoded spellings: base64 of the prefix alone is no hit.
    expect(findCanaries([a], { output: [Buffer.from(`${prefix}xxxx`).toString("base64")] })).toEqual([]);
    expect(findCanaries([a], { output: [Buffer.from(`${prefix}xxxx`).toString("hex")] })).toEqual([]);
  });
});
