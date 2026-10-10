// The host port's refusal of protected paths (run decision D6): the authoritative check that tests never touch the
// real home. Most tests protect a stand-in "home" in a temp folder, so symlinks and case can be tried for real;
// the last ones check that testHost() protects the real home and the checkout.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { Spawner } from "@plainport/core";
import { createMacosHost, guardFromEnv, type MacosHost, posixSpawner } from "./index.ts";
import { testHost } from "./testing.ts";

const env = { PATH: "/usr/bin:/bin" };
const REFUSED = "ERR_PLAINPORT_PATH_REFUSED";
let base: string;
let home: string;
let checkout: string;
let outside: string;
let spawned: string[];
let host: MacosHost;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "plainport-guard-")));
  home = join(base, "home");
  checkout = join(home, "src", "plainport");
  outside = join(base, "outside");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(home, "secret"), "secret");
  writeFileSync(join(checkout, "package.json"), "{}");
  writeFileSync(join(outside, "file"), "outside");
  symlinkSync(home, join(outside, "to-home"));
  symlinkSync(join(home, "secret"), join(checkout, "to-secret"));
  spawned = [];
  const spawner: Spawner = {
    spawn: (request) => {
      spawned.push(request.command);
      return posixSpawner.spawn(request);
    },
    signalGroup: (pgid, signal) => posixSpawner.signalGroup(pgid, signal),
  };
  host = createMacosHost({ guard: { refuse: [home], readOnly: [checkout] }, spawner });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("host guard: protected paths are refused", () => {
  test("reads and writes under a refused root reject with ERR_PLAINPORT_PATH_REFUSED", async () => {
    await expect(host.fs.readText(join(home, "secret"))).rejects.toMatchObject({ code: REFUSED });
    await expect(host.fs.writeTextDurable(join(home, "new"), "x")).rejects.toMatchObject({ code: REFUSED });
    await expect(host.fs.mkdirp(join(home, "a", "b"))).rejects.toMatchObject({ code: REFUSED });
    await expect(host.fs.stat(home)).rejects.toMatchObject({ code: REFUSED });
    await expect(host.fs.rename(join(outside, "file"), join(home, "file"))).rejects.toMatchObject({
      code: REFUSED,
    });
    await expect(host.fs.link(join(home, "secret"), join(outside, "copy"))).rejects.toMatchObject({
      code: REFUSED,
    });
    const error = await host.fs.unlink(join(home, "secret")).catch((e: unknown) => e);
    expect(String((error as Error).message)).toContain(join(home, "secret"));
    expect(String((error as Error).message)).toContain("unlink");
  });

  test("a path that reaches a refused root through a symlink is refused", async () => {
    await expect(host.fs.readText(join(outside, "to-home", "secret"))).rejects.toMatchObject({
      code: REFUSED,
    });
    await expect(host.fs.mkdirp(join(outside, "to-home", "new"))).rejects.toMatchObject({ code: REFUSED });
  });

  test.skipIf(process.platform !== "darwin")("on macOS a differently cased spelling is refused", async () => {
    await expect(host.fs.readText(join(base, "HOME", "secret"))).rejects.toMatchObject({ code: REFUSED });
  });

  test("a read-only root inside a refused one may be read, never written", async () => {
    expect(await host.fs.readText(join(checkout, "package.json"))).toBe("{}");
    await expect(host.fs.writeTextDurable(join(checkout, "x"), "x")).rejects.toMatchObject({ code: REFUSED });
    await expect(host.fs.readText(join(checkout, "to-secret"))).rejects.toMatchObject({ code: REFUSED });
  });

  test("everything else is untouched", async () => {
    expect(await host.fs.readText(join(outside, "file"))).toBe("outside");
    await host.fs.writeTextDurable(join(outside, "new"), "x");
    expect(await host.fs.readText(join(outside, "new"))).toBe("x");
  });

  test("a child is refused a refused cwd, path argument or env path, and never starts", async () => {
    const run = (overrides: object) =>
      host.run({ command: "/bin/echo", args: [], cwd: outside, env, ...overrides });
    await expect(run({ cwd: home })).rejects.toMatchObject({ code: REFUSED });
    await expect(run({ args: [join(home, "secret")] })).rejects.toMatchObject({ code: REFUSED });
    await expect(run({ args: [`--repo=${join(home, "repo")}`] })).rejects.toMatchObject({ code: REFUSED });
    await expect(run({ args: [join(outside, "to-home")] })).rejects.toMatchObject({ code: REFUSED });
    await expect(run({ env: { ...env, HOME: home } })).rejects.toMatchObject({ code: REFUSED });
    await expect(run({ env: { ...env, XDG_DIRS: `/usr/share:${home}` } })).rejects.toMatchObject({
      code: REFUSED,
    });
    expect(spawned).toEqual([]);
  });

  test("an env value refused as a path is named by its variable, never by its value (it may be a secret)", async () => {
    const secret = join(home, "canary_guard_0123456789abcdef0123456789abcdef");
    const error = await host
      .run({
        command: "/bin/echo",
        args: [],
        cwd: outside,
        env: { ...env, API_TOKEN: `/usr/share:${secret}` },
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: REFUSED });
    const text = `${String(error)} ${(error as Error).stack} ${JSON.stringify(error)}`;
    expect(text).toContain("API_TOKEN");
    expect(text).not.toContain("canary_guard");
    expect(spawned).toEqual([]);
  });

  test("a child may get PATH entries, read-only paths and paths elsewhere", async () => {
    const result = await host.run({
      command: "/bin/echo",
      args: [join(checkout, "package.json"), `--out=${join(outside, "file")}`, "plain"],
      cwd: checkout,
      env: { PATH: `${join(home, "bin")}:/usr/bin:/bin`, HOME: outside },
    });
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } });
    expect(spawned).toEqual(["/bin/echo"]);
  });
});

describe("host guard: who turns it on", () => {
  test("a host made without a guard refuses nothing", async () => {
    expect(await createMacosHost().fs.readText(join(home, "secret"))).toBe("secret");
  });

  test("guardFromEnv protects the home a test run names, and is off otherwise", () => {
    expect(guardFromEnv({ PLAINPORT_TRIPWIRE_REAL_HOME: "/Users/someone" })).toEqual({
      refuse: ["/Users/someone"],
      readOnly: [],
    });
    expect(guardFromEnv({ HOME: "/Users/someone" })).toBeUndefined();
  });

  test("testHost() refuses the real home from the account database, whatever HOME says", async () => {
    const realHome = userInfo().homedir;
    const guarded = testHost();
    await expect(guarded.fs.readText(join(realHome, ".plainport-guard-probe"))).rejects.toMatchObject({
      code: REFUSED,
    });
    await expect(guarded.run({ command: "/bin/echo", args: [], cwd: realHome, env })).rejects.toMatchObject({
      code: REFUSED,
    });
  });

  test("testHost() lets tests read the checkout but never write it", async () => {
    const repo = resolve(import.meta.dir, "../../..");
    const guarded = testHost();
    expect(await guarded.fs.readText(join(repo, "package.json"))).toContain("plainport-workspace");
    await expect(guarded.fs.writeTextDurable(join(repo, "guard-probe.txt"), "x")).rejects.toMatchObject({
      code: REFUSED,
    });
  });
});
