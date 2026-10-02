import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { takeViolations, tripwireInstalled } from "./home-tripwire.ts";

const repoRoot = join(import.meta.dir, "..");
const realHome = process.env.PLAINPORT_TRIPWIRE_REAL_HOME ?? "";
const sandbox = process.env.PLAINPORT_TEST_HOME ?? "";
const homeVars = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GROK_HOME",
];

const under = (root: string, path: string) => path === root || path.startsWith(root + sep);

// A path under the real home whose parent does not exist: if the tripwire ever failed to stop a write,
// the write itself would fail with ENOENT rather than leave anything behind.
const realHomeProbe = () => {
  if (realHome === "") throw new Error("the tripwire did not record the real home");
  return join(realHome, `.plainport-tripwire-${randomUUID()}`, "probe.txt");
};

describe("home tripwire: sandbox", () => {
  test("records the real home and a sandbox in the temp directory", () => {
    expect(realHome).not.toBe("");
    expect(sandbox).not.toBe("");
    expect(under(tmpdir(), sandbox)).toBe(true);
    expect(under(realHome, sandbox)).toBe(false);
  });

  test("points HOME, XDG_*, CLAUDE_CONFIG_DIR, CODEX_HOME and GROK_HOME into the sandbox", () => {
    for (const name of homeVars) {
      const value = process.env[name] ?? "";
      expect({ name, inSandbox: under(sandbox, value) }).toEqual({ name, inSandbox: true });
    }
    expect(process.env.HOME).toBe(sandbox);
    expect(homedir()).toBe(sandbox);
  });

  test("child processes see the sandboxed home", async () => {
    const script = 'printf %s "$HOME"';
    expect(Bun.spawnSync(["sh", "-c", script]).stdout.toString()).toBe(sandbox);
    expect(await new Response(Bun.spawn(["sh", "-c", script]).stdout).text()).toBe(sandbox);
    expect(spawnSync("sh", ["-c", script]).stdout.toString()).toBe(sandbox);
  });

  test("writes inside the sandbox and reads inside the repository are allowed", () => {
    // Without a sandbox the path below would be relative and land in the working directory.
    expect(isAbsolute(sandbox)).toBe(true);
    const dir = join(sandbox, "allowed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "probe.txt"), "ok");
    expect(readFileSync(join(dir, "probe.txt"), "utf8")).toBe("ok");
    expect(readFileSync(join(repoRoot, "VERSION"), "utf8")).toMatch(/^\d+\.\d+\.\d+/);
    expect(takeViolations()).toEqual([]);
  });
});

describe("home tripwire: refusals", () => {
  test("refuses node:fs writes under the real home, sync and async", async () => {
    expect(tripwireInstalled()).toBe(true);
    const target = realHomeProbe();
    expect(() => writeFileSync(target, "x")).toThrow(/home tripwire/);
    await expect(writeFile(target, "x")).rejects.toThrow(/home tripwire/);
    expect(() => mkdirSync(join(realHome, `.plainport-tripwire-${randomUUID()}`))).toThrow(/home tripwire/);
    expect(takeViolations()).toHaveLength(3);
  });

  test("refuses reads under the real home outside the repository", () => {
    expect(tripwireInstalled()).toBe(true);
    expect(() => existsSync(join(realHome, ".claude"))).toThrow(/home tripwire/);
    expect(() => Bun.file(join(realHome, ".codex", "config.toml"))).toThrow(/home tripwire/);
    expect(takeViolations()).toHaveLength(2);
  });

  test("refuses Bun.write under the real home", async () => {
    expect(tripwireInstalled()).toBe(true);
    await expect(Bun.write(realHomeProbe(), "x")).rejects.toThrow(/home tripwire/);
    expect(takeViolations()).toHaveLength(1);
  });

  test("a test that writes under the real home fails with a clear message, even if it swallows the error", () => {
    const probe = realHomeProbe();
    const run = Bun.spawnSync([process.execPath, "test", "./test/fixtures/home-tripwire.fixture.ts"], {
      cwd: repoRoot,
      env: { ...process.env, PLAINPORT_TRIPWIRE_PROBE: probe },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = run.stdout.toString() + run.stderr.toString();
    expect(run.exitCode).not.toBe(0);
    expect(output).toContain(`home tripwire: writeFileSync ${probe} is under the real home`);
    expect(output).toContain("use a temp directory or the sandboxed HOME");
    expect(output).toMatch(/\b0 pass\b/);
    expect(output).toMatch(/\b2 fail\b/);
    // Nothing reached the real home: checked by a child process, which the tripwire does not patch.
    expect(Bun.spawnSync(["test", "-e", probe]).exitCode).not.toBe(0);
  });
});
