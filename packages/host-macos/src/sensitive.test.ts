// The runner's sensitive mode against real process groups, through the macOS host: a shell child prints a canary it
// was handed in its environment (never in argv), then ends every way a run can end. On every path the canary is
// absent from the sandbox's files, events, findings, argv and thrown errors, and present in the ok value only when the
// child exited 0. pgrep checks that no process is left in any group the runner started.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlainportEvent } from "@plainport/contract";
import { parseSensitiveJson, type RunSpec, type Spawner } from "@plainport/core";
import {
  type Canary,
  expectNoCanary,
  makeCanary,
  makeMasterKeyCanary,
  recordArgv,
} from "../../core/src/testing/canary.ts";
import { createMacosHost, posixSpawner } from "./index.ts";

const groups: number[] = [];
const grouping: Spawner = {
  spawn: (request) => {
    const child = posixSpawner.spawn(request);
    groups.push(child.pid);
    return child;
  },
  signalGroup: (pgid, signal) => posixSpawner.signalGroup(pgid, signal),
};
const recorded = recordArgv(grouping);
const host = createMacosHost({ spawner: recorded.spawner });
let dir: string;

const members = (pgid: number): string[] => {
  const found = Bun.spawnSync(["/usr/bin/pgrep", "-g", String(pgid)], {
    stdout: "pipe",
    env: { PATH: "/usr/bin:/bin" },
  });
  return found.stdout.toString().split("\n").filter(Boolean);
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-sensitive-")));
  recorded.argv.length = 0;
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

/** A shell child with the canary in $SECRET; it writes its scratch files in the sandbox, which is searched too. */
const runCase = async (canary: Canary, script: string, overrides: Partial<RunSpec> = {}) => {
  const events: PlainportEvent[] = [];
  const errors: unknown[] = [];
  const result = await host
    .run({
      command: "/bin/sh",
      args: ["-c", script],
      cwd: dir,
      env: { PATH: "/usr/bin:/bin", SECRET: canary.value },
      sensitive: true,
      idleTimeoutMs: 300,
      killGraceMs: 300,
      log: { op: "secret", emit: (event) => events.push(event) },
      ...overrides,
    })
    .catch((error: unknown) => {
      errors.push(error);
      return undefined;
    });
  const findings = result === undefined || result.ok ? [] : [result.finding];
  expectNoCanary([canary], { dirs: [dir], events, findings, argv: recorded.argv, errors });
  expect(events).toEqual([]);
  expect(errors).toEqual([]);
  return result;
};

const messageOf = (result: Awaited<ReturnType<typeof runCase>>): string =>
  result?.ok === false ? result.finding.message : "";

describe("runner: sensitive mode against real process groups (host-macos)", () => {
  test("exits 0: the canary is in captured stdout only", async () => {
    const canary = makeCanary();
    const result = await runCase(canary, 'printf "%s\\n" "$SECRET"; printf "%s\\n" "$SECRET" >&2');
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(new TextDecoder().decode(result.value.captured)).toBe(`${canary.value}\n`);
    expect(result.value.stdout.text).toBe("");
  });

  test("exits 1: an ok outcome with exit code 1 and no stdout", async () => {
    const canary = makeCanary();
    const result = await runCase(canary, 'printf "%s\\n" "$SECRET"; echo "not found" >&2; exit 1');
    expect(result).toMatchObject({ ok: true, value: { exitCode: 1, stderr: { text: "not found\n" } } });
    if (!result?.ok) return;
    expect(result.value.captured).toBeUndefined();
    expectNoCanary([canary], { findings: [result.value] });
  });

  test("hangs: process.idle-timeout with byte counts", async () => {
    const canary = makeCanary();
    const result = await runCase(
      canary,
      'printf "%s\\n" "$SECRET"; printf "%s\\n" "$SECRET" >&2; exec sleep 30',
    );
    expect(result).toMatchObject({ ok: false, finding: { code: "process.idle-timeout" } });
    const bytes = canary.value.length + 1;
    expect(messageOf(result)).toContain(`${bytes} bytes on stdout and ${bytes} bytes on stderr`);
  });

  test("prints slowly: process.timeout", async () => {
    const canary = makeCanary();
    const result = await runCase(
      canary,
      'while :; do printf "%s\\n" "$SECRET"; printf "%s\\n" "$SECRET" >&2; sleep 0.05; done',
      { idleTimeoutMs: 5_000, timeoutMs: 400 },
    );
    expect(result).toMatchObject({ ok: false, finding: { code: "process.timeout" } });
  });

  test("is cancelled: process.cancelled", async () => {
    const canary = makeCanary();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await runCase(canary, 'printf "%s\\n" "$SECRET"; exec sleep 30', {
      signal: controller.signal,
      idleTimeoutMs: 5_000,
    });
    expect(result).toMatchObject({ ok: false, finding: { code: "process.cancelled" } });
  });

  test("prints half the canary and hangs: process.idle-timeout without either half", async () => {
    const canary = makeCanary();
    const half = Math.ceil(canary.value.length / 2);
    const result = await runCase(canary, `printf "%s" "$SECRET" | head -c ${half}; exec sleep 30`);
    expect(result).toMatchObject({ ok: false, finding: { code: "process.idle-timeout" } });
    expect(messageOf(result)).toContain(`${half} bytes on stdout`);
  });

  test("prints malformed JSON: ok, and parseSensitiveJson refuses it without quoting it", async () => {
    const canary = makeMasterKeyCanary();
    const result = await runCase(canary, 'printf "%s" "$SECRET" | sed "s/\\"encrypt\\":\\"/\\"encrypt\\":/"');
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(parseSensitiveJson(result.value.captured as Uint8Array)).toBeUndefined();
  });

  test("floods past the buffer: process.output-too-large", async () => {
    const canary = makeCanary();
    const result = await runCase(canary, 'while :; do printf "%s\\n" "$SECRET"; done', {
      capture: { maxBytes: 64 * 1024 },
      idleTimeoutMs: 5_000,
    });
    expect(result).toMatchObject({ ok: false, finding: { code: "process.output-too-large" } });
  });

  test("cannot start: process.spawn-failed names the program and the error code", async () => {
    const canary = makeCanary();
    const result = await runCase(canary, "", { command: join(dir, "missing-tool") });
    expect(result).toMatchObject({ ok: false, finding: { code: "process.spawn-failed" } });
    expect(messageOf(result)).toContain("missing-tool");
    expect(messageOf(result)).toContain("ENOENT");
  });
});
