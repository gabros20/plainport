import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpath,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open, writeFile } from "node:fs/promises";
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

  test("points the XDG search paths into the sandbox too", () => {
    for (const name of ["XDG_CONFIG_DIRS", "XDG_DATA_DIRS"]) {
      expect({ name, set: (process.env[name] ?? "") !== "" }).toEqual({ name, set: true });
    }
    for (const [name, value] of Object.entries(process.env)) {
      if (!/^XDG_\w+_(HOME|DIRS?)$/.test(name)) continue;
      for (const entry of (value ?? "").split(":")) {
        expect({ name, entry, inSandbox: under(sandbox, entry) }).toEqual({ name, entry, inSandbox: true });
      }
    }
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

// The checkout normally lives under the real home; these cases only mean something when it does.
const checkoutUnderHome = realHome !== "" && under(realHome, repoRoot);
// A path inside the checkout whose parent is a regular file: nothing can ever be created there.
const checkoutProbe = () => join(repoRoot, "VERSION", `probe-${randomUUID()}`);

describe("home tripwire: paths are compared after resolving symlinks and case", () => {
  test("a sandbox symlink into the real home is refused", () => {
    expect(tripwireInstalled()).toBe(true);
    const link = join(sandbox, `link-${randomUUID()}`);
    symlinkSync(realHome, link);
    expect(() => writeFileSync(join(link, `.plainport-tripwire-${randomUUID()}`, "probe.txt"), "x")).toThrow(
      /home tripwire/,
    );
    expect(() => existsSync(join(link, ".claude"))).toThrow(/home tripwire/);
    expect(takeViolations()).toHaveLength(2);
  });

  test("a dangling sandbox symlink that points into the real home is refused", () => {
    expect(tripwireInstalled()).toBe(true);
    const link = join(sandbox, `dangling-${randomUUID()}`);
    symlinkSync(realHomeProbe(), link);
    expect(() => writeFileSync(link, "x")).toThrow(/home tripwire/);
    expect(takeViolations()).toHaveLength(1);
  });

  test.skipIf(process.platform !== "darwin")("other casings of the real home are refused on macOS", () => {
    expect(tripwireInstalled()).toBe(true);
    const upper = realHomeProbe().replace(realHome, realHome.toUpperCase());
    expect(() => writeFileSync(upper, "x")).toThrow(/home tripwire/);
    expect(takeViolations()).toHaveLength(1);
  });
});

describe("home tripwire: write-capable calls count as writes", () => {
  test("realpath.native is guarded, sync and callback", () => {
    expect(tripwireInstalled()).toBe(true);
    expect(() => realpathSync.native(join(realHome, ".claude"))).toThrow(/home tripwire/);
    expect(() => realpath.native(join(realHome, ".claude"), () => {})).toThrow(/home tripwire/);
    expect(takeViolations()).toHaveLength(2);
  });

  test.skipIf(!checkoutUnderHome)("writes into the checkout are refused", () => {
    expect(() => writeFileSync(checkoutProbe(), "x")).toThrow(/home tripwire/);
    expect(takeViolations()).toHaveLength(1);
  });

  test.skipIf(!checkoutUnderHome)(
    "read APIs with write-capable flags inside the checkout are refused",
    async () => {
      const version = join(repoRoot, "VERSION");
      expect(() => readFileSync(version, { flag: "a" })).toThrow(/home tripwire/);
      expect(() => createReadStream(version, { flags: "a" })).toThrow(/home tripwire/);
      expect(() => openSync(version, "r+")).toThrow(/home tripwire/);
      await expect(open(version, "a")).rejects.toThrow(/home tripwire/);
      expect(takeViolations()).toHaveLength(4);
      expect(readFileSync(version, { flag: "r" }).length).toBeGreaterThan(0);
    },
  );

  test.skipIf(!checkoutUnderHome)("Bun.file mutators inside the checkout are refused", async () => {
    const file = Bun.file(checkoutProbe());
    expect(() => file.writer()).toThrow(/home tripwire/);
    await expect(file.write("x")).rejects.toThrow(/home tripwire/);
    await expect(file.delete()).rejects.toThrow(/home tripwire/);
    await expect(file.unlink()).rejects.toThrow(/home tripwire/);
    expect(() => file.slice(0, 1).writer()).toThrow(/home tripwire/);
    expect(takeViolations()).toHaveLength(5);
  });
});
