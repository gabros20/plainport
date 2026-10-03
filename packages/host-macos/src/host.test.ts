import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finding } from "@plainport/contract";
import { acquireLock, InjectedFault, nodeLocalIo } from "@plainport/core";
import { macOnlyTests } from "../../../test/platform.ts";
import { createMacosHost } from "./index.ts";
import { testHost } from "./testing.ts";

/** Tests that need the real macOS tools; skipped on Linux, counted on a Mac (test/platform.ts). */
const testOnMac = macOnlyTests();

const env = { PATH: "/usr/bin:/bin" };
let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-host-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("host: the macOS host port implements LocalIo", () => {
  test("file system calls work on real files", async () => {
    const { fs } = createMacosHost();
    await fs.mkdirp(join(dir, "a", "b"));
    await fs.writeTextDurable(join(dir, "a", "one.txt"), "one");
    expect(await fs.readText(join(dir, "a", "one.txt"))).toBe("one");
    await fs.link(join(dir, "a", "one.txt"), join(dir, "a", "two.txt"));
    await expect(fs.link(join(dir, "a", "one.txt"), join(dir, "a", "two.txt"))).rejects.toMatchObject({
      code: "EEXIST",
    });
    await fs.rename(join(dir, "a", "two.txt"), join(dir, "a", "three.txt"));
    await fs.unlink(join(dir, "a", "one.txt"));
    await fs.syncDir(join(dir, "a"));
    expect((await fs.readdir(join(dir, "a"))).sort()).toEqual(["b", "three.txt"]);
    symlinkSync(join(dir, "a"), join(dir, "link"));
    expect(await fs.realpath(join(dir, "link", "three.txt"))).toBe(join(dir, "a", "three.txt"));
    expect(await fs.stat(join(dir, "link"))).toMatchObject({ kind: "dir" });
    expect((await fs.entries(dir)).sort((x, y) => x.name.localeCompare(y.name))).toEqual([
      { name: "a", kind: "dir" },
      { name: "link", kind: "symlink" },
    ]);
    expect(await fs.writable(dir)).toBe(true);
    writeFileSync(join(dir, "tool"), "#!/bin/sh\n");
    expect(await fs.executable(join(dir, "tool"))).toBe(false);
    chmodSync(join(dir, "tool"), 0o755);
    expect(await fs.executable(join(dir, "tool"))).toBe(true);
    expect(await fs.executable(join(dir, "a"))).toBe(false);
    await expect(fs.readText(join(dir, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(readFileSync(join(dir, "a", "three.txt"), "utf8")).toBe("one");
  });

  test("lstat, readlink and readable describe an entry without following it (scan)", async () => {
    const { fs } = testHost();
    writeFileSync(join(dir, "file.txt"), "12345");
    chmodSync(join(dir, "file.txt"), 0o640);
    symlinkSync("file.txt", join(dir, "link"));
    Bun.spawnSync(["/usr/bin/mkfifo", join(dir, "pipe")]);
    const file = await fs.lstat(join(dir, "file.txt"));
    expect(file).toMatchObject({ kind: "file", size: 5, mode: 0o640 });
    expect(typeof file.mtimeNs).toBe("bigint");
    expect(file.ctimeNs).toBeGreaterThan(0n);
    expect(await fs.lstat(join(dir, "link"))).toMatchObject({ kind: "symlink", size: 8 });
    expect(await fs.lstat(join(dir, "pipe"))).toMatchObject({ kind: "fifo" });
    expect(await fs.lstat(dir)).toMatchObject({ kind: "dir" });
    expect(await fs.readlink(join(dir, "link"))).toBe("file.txt");
    expect(await fs.readable(join(dir, "file.txt"))).toBe(true);
    chmodSync(join(dir, "file.txt"), 0o200);
    expect(await fs.readable(join(dir, "file.txt"))).toBe(false);
    expect(await fs.readable(join(dir, "missing"))).toBe(false);
    await expect(fs.lstat(join(dir, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  testOnMac(
    "realpath resolves a path holding a backslash, which Bun 1.3.14's realpath reports as missing",
    async () => {
      const { fs } = createMacosHost();
      const odd = join(dir, "p\\q", "Inner");
      await fs.mkdirp(odd);
      symlinkSync(odd, join(dir, "link"));
      expect(await fs.realpath(odd)).toBe(odd);
      // Through a symlink, and spelled as the volume stores it when given in another case.
      expect(await fs.realpath(join(dir, "link"))).toBe(odd);
      expect(await fs.realpath(join(dir, "p\\q", "inner"))).toBe(odd);
      await expect(fs.realpath(join(dir, "p\\q", "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("every host shares the process's one ProcessInfo, so locks see one process", async () => {
    const a = createMacosHost();
    const b = createMacosHost();
    expect(a.proc).toBe(b.proc);
    expect(a.proc).toBe(nodeLocalIo.proc);
    expect(a.proc.pid).toBe(process.pid);

    const held = (_: unknown, path: string, ours: boolean) =>
      finding("config.locked", { message: ours ? "ours" : "theirs", paths: [path] });
    const lock = await acquireLock(a, join(dir, "x.lock"), { timeoutMs: 1000, held });
    if (!lock.ok) throw new Error(lock.finding.message);
    const busy = await acquireLock(b, join(dir, "x.lock"), { timeoutMs: 50, held });
    expect(busy).toMatchObject({ ok: false, finding: { message: "ours" } });
    await lock.value.release();
  });

  test("the clock tells wall time, monotonic time and sleeps", async () => {
    const { clock } = createMacosHost();
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(1000);
    const before = clock.monotonicMs();
    await clock.sleep(20);
    expect(clock.monotonicMs() - before).toBeGreaterThanOrEqual(15);
  });

  test("run starts a child through the runner", async () => {
    const result = await createMacosHost().run({ command: "/bin/echo", args: ["hi"], cwd: dir, env });
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0, stdout: { text: "hi\n" } } });
  });
});

describe("host: faultAt", () => {
  test("is a no-op unless a fault is planned", () => {
    createMacosHost().faultAt("offload.release");
  });

  test("a planned fault throws InjectedFault at its step", () => {
    const steps: string[] = [];
    const host = createMacosHost({ faults: { at: "offload.release", onStep: (step) => steps.push(step) } });
    host.faultAt("offload.commit");
    expect(() => host.faultAt("offload.release")).toThrow(InjectedFault);
    expect(steps).toEqual(["offload.commit", "offload.release"]);
  });

  test("the kill action ends the process with SIGKILL at its step", async () => {
    const script = join(dir, "crash.ts");
    writeFileSync(
      script,
      `import { createMacosHost } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};\n` +
        `const host = createMacosHost({ faults: { at: "offload.release", action: "kill" } });\n` +
        `host.faultAt("offload.commit");\nconsole.log("before");\n` +
        `host.faultAt("offload.release");\nconsole.log("after");\n`,
    );
    const result = await createMacosHost().run({
      command: process.execPath,
      args: [script],
      cwd: dir,
      env: { ...env, HOME: dir },
    });
    expect(result).toMatchObject({
      ok: true,
      value: { exitCode: null, signal: "SIGKILL", stdout: { text: "before\n" } },
    });
  });
});
