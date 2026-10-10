// The runner's sensitive mode against real process groups, through the macOS host with its path guard on: a shell
// child prints a canary it was handed in its environment (never in argv), then ends every way a run can end. On every
// path the canary is absent from the sandbox's files, events, findings, argv, thrown errors, this process's own stdout
// and stderr and the returned outcome, and present only in captured stdout when the child exited 0. pgrep checks that
// no process is left in any group the runner started. T1: real processes (ADR-0018).

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesInclude, parseSensitiveJson, type RunSpec, type Spawner, stderrClasses } from "@plainport/core";
import { describeT1 } from "../../../test/tiers.ts";
import {
  type Canary,
  expectRunLeaksNothing,
  makeCanary,
  makeMasterKeyCanary,
  recordArgv,
} from "../../core/src/testing/canary.ts";
import { createMacosHost, PATH_REFUSED, posixSpawner } from "./index.ts";

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
/** The folder the host's guard protects, standing in for the real home. */
const protectedRoot = realpathSync(mkdtempSync(join(tmpdir(), "plainport-sensitive-home-")));
const host = createMacosHost({ spawner: recorded.spawner, guard: { refuse: [protectedRoot], readOnly: [] } });
let dir: string;

const members = (pgid: number): string[] => {
  const found = Bun.spawnSync(["/usr/bin/pgrep", "-g", String(pgid)], {
    stdout: "pipe",
    env: { PATH: "/usr/bin:/bin" },
  });
  return found.stdout.toString().split("\n").filter(Boolean);
};

afterAll(() => rmSync(protectedRoot, { recursive: true, force: true }));

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-sensitive-")));
  recorded.argv.length = 0;
});

/**
 * A helper a test started outside every process group (the held-open case's perl) writes its pid to helper.pid in the
 * sandbox; afterEach kills whatever it names before the sandbox goes, so it is stopped even when the test failed before
 * reading it (a leak assertion inside runCase).
 */
const killHelper = (): void => {
  let pid: number;
  try {
    pid = Number(readFileSync(join(dir, "helper.pid"), "utf8"));
  } catch {
    return; // No helper this test.
  }
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
};

afterEach(() => {
  killHelper();
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

/**
 * A shell child with the canary in $SECRET, through expectRunLeaksNothing: its scratch files in the sandbox and the
 * guard's protected root are searched too. The idle deadline is 10 s, as in the host runner suite (a cold start on a
 * loaded host can be quiet for a while); only the idle cases lower it.
 */
const runCase = async (
  canary: Canary,
  script: string,
  overrides: Partial<RunSpec> = {},
  expectThrown = false,
) =>
  expectRunLeaksNothing(
    [canary],
    (log) =>
      host.run({
        command: "/bin/sh",
        args: ["-c", script],
        cwd: dir,
        env: { PATH: "/usr/bin:/bin", SECRET: canary.value },
        sensitive: true,
        idleTimeoutMs: 10_000,
        killGraceMs: 300,
        log,
        ...overrides,
      }),
    { dirs: [dir, protectedRoot], argv: recorded.argv, throws: expectThrown },
  );

const messageOf = (result: Awaited<ReturnType<typeof runCase>>["result"]): string =>
  result?.ok === false ? result.finding.message : "";

describeT1("runner: sensitive mode against real process groups (host-macos)", () => {
  test("exits 0: the canary is in captured stdout only", async () => {
    const canary = makeCanary();
    const { result } = await runCase(canary, 'printf "%s\\n" "$SECRET"; printf "%s\\n" "$SECRET" >&2');
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(new TextDecoder().decode(result.value.captured)).toBe(`${canary.value}\n`);
    expect(result.value.stdout.text).toBe("");
  });

  test("exits 1: an ok outcome with exit code 1, no stdout, and stderr only as the code a classifier chose", async () => {
    const canary = makeCanary();
    const classes = stderrClasses(["not-found", "other"], (stderr) =>
      bytesInclude(stderr, "not found") ? "not-found" : "other",
    );
    const { result } = await runCase(
      canary,
      'printf "%s\\n" "$SECRET"; printf "%s: item not found\\n" "$SECRET" >&2; exit 1',
      {
        classifyStderr: classes,
      },
    );
    expect(result).toMatchObject({
      ok: true,
      value: { exitCode: 1, stderr: { text: "" }, privateOutput: { stderrCode: "not-found" } },
    });
    if (!result?.ok) return;
    expect(classes.codeOf(result.value)).toBe("not-found");
    expect(result.value.captured).toBeUndefined();
  });

  test("hangs: process.idle-timeout with byte counts", async () => {
    const canary = makeCanary();
    const { result } = await runCase(
      canary,
      'printf "%s\\n" "$SECRET"; printf "%s\\n" "$SECRET" >&2; exec sleep 30',
      { idleTimeoutMs: 300 },
    );
    expect(result).toMatchObject({ ok: false, finding: { code: "process.idle-timeout" } });
    const bytes = canary.value.length + 1;
    expect(messageOf(result)).toContain(`${bytes} bytes on stdout and ${bytes} bytes on stderr`);
  });

  test("prints slowly: process.timeout", async () => {
    const canary = makeCanary();
    const { result } = await runCase(
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
    const { result } = await runCase(canary, 'printf "%s\\n" "$SECRET"; exec sleep 30', {
      signal: controller.signal,
      idleTimeoutMs: 5_000,
    });
    expect(result).toMatchObject({ ok: false, finding: { code: "process.cancelled" } });
  });

  test("prints half the canary and hangs: process.idle-timeout without either half", async () => {
    const canary = makeCanary();
    const half = Math.ceil(canary.value.length / 2);
    const { result } = await runCase(canary, `printf "%s" "$SECRET" | head -c ${half}; exec sleep 30`, {
      idleTimeoutMs: 300,
    });
    expect(result).toMatchObject({ ok: false, finding: { code: "process.idle-timeout" } });
    expect(messageOf(result)).toContain(`${half} bytes on stdout`);
  });

  test("prints malformed JSON: ok, and parseSensitiveJson refuses it without quoting it", async () => {
    const canary = makeMasterKeyCanary();
    const { result } = await runCase(
      canary,
      'printf "%s" "$SECRET" | sed "s/\\"encrypt\\":\\"/\\"encrypt\\":/"',
    );
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(parseSensitiveJson(result.value.captured as Uint8Array)).toBeUndefined();
  });

  test("floods past the buffer: process.output-too-large", async () => {
    const canary = makeCanary();
    const { result } = await runCase(canary, 'while :; do printf "%s\\n" "$SECRET"; done', {
      capture: { maxBytes: 64 * 1024 },
      idleTimeoutMs: 5_000,
    });
    expect(result).toMatchObject({ ok: false, finding: { code: "process.output-too-large" } });
  });

  test("cannot start: process.spawn-failed names the program and the error code", async () => {
    const canary = makeCanary();
    const { result } = await runCase(canary, "", { command: join(dir, "missing-tool") });
    expect(result).toMatchObject({ ok: false, finding: { code: "process.spawn-failed" } });
    expect(messageOf(result)).toContain("missing-tool");
    expect(messageOf(result)).toContain("ENOENT");
  });

  test("exits while a process outside its group holds stdout: process.output-incomplete", async () => {
    const canary = makeCanary();
    const { result } = await runCase(
      canary,
      // perl leaves the group (setsid) and only then writes its pid, which sh waits for before it exits: when the
      // leader goes, nothing is left in its group, and stdout is held only from outside it.
      'printf "%s\\n" "$SECRET"; /usr/bin/perl -MPOSIX -e \'POSIX::setsid(); open(my $f, ">", "helper.tmp") or die; print $f $$; close $f; rename("helper.tmp", "helper.pid"); sleep 30\' & while [ ! -e helper.pid ]; do sleep 0.01; done; exit 0',
    );
    // afterEach kills it, whatever happened above.
    expect(Number(readFileSync(join(dir, "helper.pid"), "utf8"))).toBeGreaterThan(1);
    expect(result).toMatchObject({ ok: false, finding: { code: "process.output-incomplete" } });
    // The held-open path, not the leftovers one: the helper had left the group.
    expect(messageOf(result)).toContain("a process outside its group kept its stdout open");
    expect(messageOf(result)).toContain(`${canary.value.length + 1} bytes on stdout`);
  });

  test("exits leaving a writer in its group: process.output-incomplete", async () => {
    const canary = makeCanary();
    const { result } = await runCase(
      canary,
      '(sleep 30; printf "%s\\n" "$SECRET") & printf "%s\\n" "$SECRET"; exit 0',
    );
    expect(result).toMatchObject({ ok: false, finding: { code: "process.output-incomplete" } });
  });

  test("a path-shaped secret under a protected root: the guard refuses, naming the variable, not its value", async () => {
    const canary = makeCanary();
    mkdirSync(protectedRoot, { recursive: true });
    const secret = join(protectedRoot, canary.value);
    const { errors } = await runCase(
      { ...canary, forms: [...canary.forms, { name: "path-shaped secret", text: secret }] },
      'printf "%s\\n" "$TOKEN"',
      { env: { PATH: "/usr/bin:/bin", TOKEN: secret } },
      true,
    );
    expect(errors[0]).toMatchObject({ code: PATH_REFUSED });
    expect(String((errors[0] as Error).message)).toContain("TOKEN");
    expect(recorded.argv).toEqual([]);
  });
});
