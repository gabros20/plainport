import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hostTarget } from "../packages/core/src/tools.ts";
import { describeT1 } from "../test/tiers.ts";
import {
  dirtyFromStatus,
  installVersion,
  isVersionName,
  layout,
  planName,
  readState,
  removeInstall,
  removeVersion,
  rollback,
  versionName,
} from "./install.ts";

const scratch = mkdtempSync(join(tmpdir(), "plainport-install-test-"));
afterAll(() => removeInstall(scratch));

let prefixes = 0;
/** A prefix of its own for each test, so no test depends on another's install. */
const fresh = (): string => join(scratch, `prefix-${++prefixes}`);

const stageFake =
  (text: string) =>
  (dir: string): void => {
    for (const name of ["plainport", "restic", "rclone"])
      writeFileSync(join(dir, name), `#!/bin/sh\necho ${text}\n`);
  };

describe("naming a build", () => {
  test("a release installs under its version; a dev build under its version, build time and commit", () => {
    expect(versionName("0.1.0", "abc1234", new Date("2026-10-04T12:34:56Z"))).toBe("0.1.0");
    expect(versionName("0.1.0-dev", "abc1234", new Date("2026-10-04T12:34:56Z"))).toBe(
      "0.1.0-dev+20261004123456.abc1234",
    );
  });

  test("a dirty tree marks a dev build .dirty and refuses a release", () => {
    const now = new Date("2026-10-04T12:34:56Z");
    expect(planName({ version: "0.1.0-dev", commit: "abc1234", dirty: true, now })).toEqual({
      ok: true,
      name: "0.1.0-dev+20261004123456.abc1234.dirty",
    });
    expect(planName({ version: "0.1.0", commit: "abc1234", dirty: false, now })).toEqual({
      ok: true,
      name: "0.1.0",
    });
    const refused = planName({ version: "0.1.0", commit: "abc1234", dirty: true, now });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain("commit or stash");
  });

  test("a release outside a git checkout (no commit) is refused", () => {
    const refused = planName({ version: "0.1.0", commit: undefined, dirty: false });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain("not a git checkout");
    expect(planName({ version: "0.1.0-dev", commit: undefined, dirty: false, now: new Date(0) })).toEqual({
      ok: true,
      name: "0.1.0-dev+19700101000000.unknown",
    });
  });

  test("every SemVer pre-release names a version the installer owns, consistently with versionName (R3-M3)", () => {
    const now = new Date("2026-10-04T12:34:56Z");
    for (const version of ["0.1.0", "0.2.0-rc.1", "1.0.0-beta.2.x-y", "0.1.0-dev"]) {
      const named = planName({ version, commit: "abc1234", dirty: false, now });
      expect(named.ok).toBe(true);
      if (named.ok) expect(isVersionName(named.name)).toBe(true);
    }
    expect(planName({ version: "0.2.0-rc.1", commit: "abc1234", dirty: false, now })).toEqual({
      ok: true,
      name: "0.2.0-rc.1",
    });
    expect(isVersionName("0.1.0-dev+20261004123456.abc1234.dirty")).toBe(true);
    for (const name of ["dev", "0.1", "0.1.0-", "0.1.0-rc..1", "v0.1.0", "0.1.0+junk"])
      expect(isVersionName(name)).toBe(false);
  });

  test("a VERSION that is not SemVer is refused with its fix (R3-M3)", () => {
    const refused = planName({ version: "0.2", commit: "abc1234", dirty: false });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain("VERSION");
  });

  test("tracked changes anywhere and untracked files under packages/ make the tree dirty", () => {
    expect(dirtyFromStatus("")).toBe(false);
    expect(dirtyFromStatus("?? notes.txt\n?? .orchestrate/x.md\n")).toBe(false);
    expect(dirtyFromStatus(" M README.md\n")).toBe(true);
    expect(dirtyFromStatus("?? packages/core/src/new.ts\n")).toBe(true);
  });
});

describe("installVersion and rollback", () => {
  test("installs a read-only version tree behind current, with bin/plainport pointing through current", () => {
    const prefix = fresh();
    const first = installVersion(prefix, "0.1.0", stageFake("one"));
    expect(first).toEqual({
      ok: true,
      version: "0.1.0",
      previous: undefined,
      reused: false,
      pruned: [],
      notices: [],
    });
    const paths = layout(prefix);
    expect(readlinkSync(paths.current)).toBe("versions/0.1.0");
    expect(readlinkSync(paths.bin)).toBe(join(paths.current, "plainport"));
    expect(realpathSync(paths.bin)).toBe(realpathSync(join(paths.versions, "0.1.0", "plainport")));
    expect(statSync(join(paths.versions, "0.1.0")).mode & 0o222).toBe(0);
    expect(statSync(join(paths.versions, "0.1.0", "restic")).mode & 0o777).toBe(0o555);
    expect(readState(prefix)).toEqual({ current: "0.1.0", previous: undefined, versions: ["0.1.0"] });
  });

  test("a second version records the first as the rollback target and keeps both", () => {
    const prefix = fresh();
    installVersion(prefix, "0.1.0", stageFake("one"));
    const second = installVersion(prefix, "0.2.0", stageFake("two"));
    expect(second).toMatchObject({ ok: true, version: "0.2.0", previous: "0.1.0", reused: false });
    expect(readState(prefix)).toEqual({ current: "0.2.0", previous: "0.1.0", versions: ["0.1.0", "0.2.0"] });
    expect(readFileSync(layout(prefix).bin, "utf8")).toContain("echo two");
  });

  test("a third version prunes everything but current and the rollback target", () => {
    const prefix = fresh();
    installVersion(prefix, "0.1.0", stageFake("one"));
    installVersion(prefix, "0.2.0", stageFake("two"));
    const third = installVersion(prefix, "0.3.0", stageFake("three"));
    expect(third).toMatchObject({ ok: true, previous: "0.2.0", pruned: ["0.1.0"] });
    expect(readState(prefix)).toEqual({ current: "0.3.0", previous: "0.2.0", versions: ["0.2.0", "0.3.0"] });
    expect(rollback(prefix)).toEqual({ ok: true, from: "0.3.0", to: "0.2.0" });
  });

  test("--rollback swaps current and previous, and a second rollback swaps them back", () => {
    const prefix = fresh();
    installVersion(prefix, "0.1.0", stageFake("one"));
    installVersion(prefix, "0.2.0", stageFake("two"));
    expect(rollback(prefix)).toEqual({ ok: true, from: "0.2.0", to: "0.1.0" });
    expect(readState(prefix)).toMatchObject({ current: "0.1.0", previous: "0.2.0" });
    expect(readFileSync(layout(prefix).bin, "utf8")).toContain("echo one");
    expect(rollback(prefix)).toEqual({ ok: true, from: "0.1.0", to: "0.2.0" });
  });

  test("a version already installed from the same commit is activated again without staging", () => {
    const prefix = fresh();
    installVersion(prefix, "0.1.0", stageFake("one"), { commit: "aaa1111" });
    installVersion(prefix, "0.2.0", stageFake("two"), { commit: "bbb2222" });
    let staged = false;
    const again = installVersion(
      prefix,
      "0.1.0",
      () => {
        staged = true;
      },
      { commit: "aaa1111" },
    );
    expect(again).toMatchObject({ ok: true, version: "0.1.0", previous: "0.2.0", reused: true });
    expect(staged).toBe(false);
  });

  test("a version already installed from another commit is refused, never reused as if it were this one", () => {
    const prefix = fresh();
    installVersion(prefix, "0.1.0", stageFake("one"), { commit: "aaa1111" });
    const other = installVersion(prefix, "0.1.0", stageFake("other"), { commit: "ccc3333" });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.message).toContain("aaa1111");
    expect(readFileSync(layout(prefix).bin, "utf8")).toContain("echo one");
  });

  test("a failed stage leaves the install as it was and no staging folder behind", () => {
    const prefix = fresh();
    installVersion(prefix, "0.1.0", stageFake("one"));
    const before = readState(prefix);
    const failed = installVersion(prefix, "0.3.0", () => {
      throw new Error("build broke");
    });
    expect(failed.ok).toBe(false);
    expect(readState(prefix)).toEqual(before);
    expect(readdirSync(layout(prefix).versions).filter((n) => n.startsWith(".staging-"))).toEqual([]);
  });

  test("an install sweeps the staging folders and temp links an interrupted install left, and nothing else", () => {
    const prefix = fresh();
    installVersion(prefix, "0.1.0", stageFake("one"));
    const paths = layout(prefix);
    chmodSync(paths.versions, 0o755);
    mkdirSync(join(paths.versions, ".staging-AbC123/inner"), { recursive: true });
    chmodSync(join(paths.versions, ".staging-AbC123"), 0o555);
    symlinkSync("versions/0.1.0", `${paths.current}.tmp-123-456`);
    symlinkSync(join(paths.current, "plainport"), `${paths.bin}.tmp-123-456`);
    writeFileSync(join(paths.share, "notes.txt"), "the owner's");
    writeFileSync(join(prefix, "bin", "other-tool"), "not ours");
    expect(installVersion(prefix, "0.2.0", stageFake("two")).ok).toBe(true);
    expect(readdirSync(paths.versions).sort()).toEqual(["0.1.0", "0.2.0"]);
    expect(readdirSync(paths.share).sort()).toEqual(["current", "notes.txt", "previous", "versions"]);
    expect(readdirSync(join(prefix, "bin")).sort()).toEqual(["other-tool", "plainport"]);
  });

  /** A folder outside the install whose modes must never change: it, a 700 folder in it, and a file. */
  const outside = (): { dir: string; modes: () => number[] } => {
    const dir = mkdtempSync(join(scratch, "outside-"));
    mkdirSync(join(dir, "private"));
    chmodSync(join(dir, "private"), 0o700);
    writeFileSync(join(dir, "private", "key"), "secret-ish");
    chmodSync(join(dir, "private", "key"), 0o600);
    chmodSync(dir, 0o700);
    const modes = () =>
      [dir, join(dir, "private"), join(dir, "private", "key")].map((p) => statSync(p).mode & 0o777);
    return { dir, modes };
  };

  test("prune and sweep never follow a symlink: links in versions/ survive and their targets keep their modes (R2-I1)", () => {
    const prefix = fresh();
    installVersion(prefix, "0.1.0", stageFake("one"));
    const paths = layout(prefix);
    chmodSync(paths.versions, 0o755);
    const a = outside();
    const b = outside();
    symlinkSync(a.dir, join(paths.versions, "dev"));
    symlinkSync(a.dir, join(paths.versions, "0.0.9"));
    symlinkSync(b.dir, join(paths.versions, ".staging-AbC123"));
    installVersion(prefix, "0.2.0", stageFake("two"));
    const third = installVersion(prefix, "0.3.0", stageFake("three"));
    expect(third).toMatchObject({ ok: true, pruned: ["0.1.0"] });
    if (third.ok) {
      expect(third.notices).toContain(
        `left alone: ${join(paths.versions, "dev")} (not a version scripts/install made)`,
      );
      expect(third.notices).toContain(
        `left alone: ${join(paths.versions, ".staging-AbC123")} (not a staging folder scripts/install made)`,
      );
    }
    for (const name of ["dev", "0.0.9", ".staging-AbC123"])
      expect(lstatSync(join(paths.versions, name)).isSymbolicLink()).toBe(true);
    expect(a.modes()).toEqual([0o700, 0o700, 0o600]);
    expect(b.modes()).toEqual([0o700, 0o700, 0o600]);
  });

  test("prune leaves a foreign file and a foreign folder in versions/ alone, version-shaped or not (R2-I1)", () => {
    const prefix = fresh();
    installVersion(prefix, "0.1.0", stageFake("one"));
    const paths = layout(prefix);
    chmodSync(paths.versions, 0o755);
    writeFileSync(join(paths.versions, "README"), "the owner's notes");
    mkdirSync(join(paths.versions, "9.9.9"));
    writeFileSync(join(paths.versions, "9.9.9", "plainport"), "another tool's");
    mkdirSync(join(paths.versions, "scratch"));
    installVersion(prefix, "0.2.0", stageFake("two"));
    installVersion(prefix, "0.3.0", stageFake("three"));
    expect(readdirSync(paths.versions).sort()).toEqual(["0.2.0", "0.3.0", "9.9.9", "README", "scratch"]);
    expect(readFileSync(join(paths.versions, "9.9.9", "plainport"), "utf8")).toBe("another tool's");
  });

  test("a prune that fails after activation is a notice, and the install still succeeds (R2-M2)", () => {
    const prefix = fresh();
    installVersion(prefix, "0.1.0", stageFake("one"));
    installVersion(prefix, "0.2.0", stageFake("two"));
    // An injected removal fault stands in for EPERM (a uchg flag, another owner) on every platform.
    const remove = (path: string) => {
      throw Object.assign(new Error(`EPERM: operation not permitted, rm '${path}'`), { code: "EPERM" });
    };
    const third = installVersion(prefix, "0.3.0", stageFake("three"), undefined, { remove });
    expect(third).toMatchObject({ ok: true, version: "0.3.0", pruned: [] });
    if (third.ok) expect(third.notices.some((n) => n.startsWith("prune of 0.1.0 failed: EPERM"))).toBe(true);
    expect(readState(prefix)).toMatchObject({ current: "0.3.0", previous: "0.2.0" });
    expect(readState(prefix).versions).toEqual(["0.1.0", "0.2.0", "0.3.0"]);
  });

  test("a second install while one holds the lock is refused, and the lock goes when an install ends (R2-M7)", () => {
    const prefix = fresh();
    installVersion(prefix, "0.1.0", stageFake("one"));
    const lock = join(layout(prefix).share, ".install.lock");
    expect(existsSync(lock)).toBe(false);
    mkdirSync(lock);
    const refused = installVersion(prefix, "0.2.0", stageFake("two"));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain("another scripts/install is running");
    expect(rollback(prefix).ok).toBe(false);
    rmSync(lock, { recursive: true });
    expect(installVersion(prefix, "0.2.0", stageFake("two")).ok).toBe(true);
  });

  test("a lock whose recorded pid is alive is refused with the exact rm -r to run (R3-M1)", () => {
    const prefix = fresh();
    installVersion(prefix, "0.1.0", stageFake("one"));
    const lock = join(layout(prefix).share, ".install.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), `${process.pid}\n`);
    const refused = installVersion(prefix, "0.2.0", stageFake("two"));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain(`rm -r '${lock}'`);
    rmSync(lock, { recursive: true });
  });

  test("a lock whose recorded pid is gone is taken over, with a notice (R3-M1)", () => {
    const prefix = fresh();
    installVersion(prefix, "0.1.0", stageFake("one"));
    const lock = join(layout(prefix).share, ".install.lock");
    const dead = Bun.spawnSync(["/bin/sh", "-c", "echo $$"], { stdout: "pipe" }).stdout.toString().trim();
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), `${dead}\n`);
    const taken = installVersion(prefix, "0.2.0", stageFake("two"));
    expect(taken).toMatchObject({ ok: true, version: "0.2.0" });
    if (taken.ok) expect(taken.notices).toContain(`took over a stale lock: pid ${dead} is gone (${lock})`);
    expect(existsSync(lock)).toBe(false);
  });

  test("a lock with no pid file is taken over once it is a minute old, and refused while younger (R3-M1)", () => {
    const prefix = fresh();
    installVersion(prefix, "0.1.0", stageFake("one"));
    const lock = join(layout(prefix).share, ".install.lock");
    mkdirSync(lock);
    expect(installVersion(prefix, "0.2.0", stageFake("two")).ok).toBe(false);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const taken = installVersion(prefix, "0.2.0", stageFake("two"));
    expect(taken.ok).toBe(true);
    if (taken.ok) expect(taken.notices.some((n) => n.startsWith("took over a stale lock"))).toBe(true);
  });

  test("a prune that fails partway keeps build.json, so the folder stays the installer's and the next prune finishes it (R3-M2)", () => {
    const prefix = fresh();
    installVersion(prefix, "0.1.0", stageFake("one"));
    installVersion(prefix, "0.2.0", stageFake("two"));
    const dir = join(layout(prefix).versions, "0.1.0");
    // An rm that fails on the binary: everything it reached before build.json may be gone, build.json is not.
    const rm = (path: string) => {
      if (path.endsWith("/plainport")) throw new Error(`EPERM: operation not permitted, unlink '${path}'`);
      rmSync(path, { recursive: true, force: true });
    };
    expect(() => removeVersion(dir, rm)).toThrow("EPERM");
    expect(existsSync(join(dir, "build.json"))).toBe(true);
    expect(readState(prefix).versions).toContain("0.1.0");
    const third = installVersion(prefix, "0.3.0", stageFake("three"));
    expect(third).toMatchObject({ ok: true, pruned: ["0.1.0"] });
    if (third.ok) expect(third.notices).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  test("a failed stage whose cleanup also fails returns one message naming both, not an exception (R3-M4)", () => {
    const prefix = fresh();
    const result = installVersion(
      prefix,
      "0.1.0",
      () => {
        throw new Error("build broke");
      },
      undefined,
      {
        remove: () => {
          throw new Error("EACCES: permission denied");
        },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("build broke");
      expect(result.message).toContain("removing its staging folder failed: EACCES");
    }
  });

  test("a current that is not a link fails with a message, not an exception", () => {
    const prefix = fresh();
    mkdirSync(join(layout(prefix).current, "x"), { recursive: true });
    const result = installVersion(prefix, "0.1.0", stageFake("one"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(layout(prefix).current);
  });

  test("rollback with nothing to roll back to, and a foreign bin/plainport, are refused", () => {
    const prefix = fresh();
    expect(rollback(prefix).ok).toBe(false);
    installVersion(prefix, "0.1.0", stageFake("one"));
    expect(rollback(prefix)).toMatchObject({ ok: false });
    const foreign = fresh();
    mkdirSync(join(foreign, "bin"), { recursive: true });
    writeFileSync(join(foreign, "bin/plainport"), "not ours");
    const refused = installVersion(foreign, "0.1.0", stageFake("one"));
    expect(refused.ok).toBe(false);
    expect(readFileSync(join(foreign, "bin/plainport"), "utf8")).toBe("not ours");
  });
});

const script = join(import.meta.dir, "install");

describe("scripts/install, expected failures", () => {
  const run = (args: string[], path: string) => {
    const ran = Bun.spawnSync([script, ...args], {
      env: { PATH: path, HOME: join(scratch, "home") },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: ran.exitCode, err: ran.stderr.toString() };
  };
  const withBun = `${join(process.execPath, "..")}:/usr/bin:/bin`;

  test("without bun, the wrapper names the fix", () => {
    const ran = run(["--prefix", fresh()], "/usr/bin:/bin");
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("scripts/install: bun not found; install Bun");
  });

  test("an unknown flag prints usage, not a stack trace", () => {
    const ran = run(["--nope"], withBun);
    expect(ran.code).toBe(2);
    expect(ran.err).toContain("scripts/install:");
    expect(ran.err).toContain("usage: scripts/install");
    expect(ran.err).not.toContain("    at ");
  });

  test("missing tools name fetch-tools", () => {
    const ran = run(["--prefix", fresh(), "--tools", join(scratch, "no-tools")], withBun);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("bun scripts/fetch-tools.ts");
  });
});

/**
 * This working tree copied into `dir` and committed there with VERSION set to `pinned`, its node_modules linked to
 * this checkout's. The end-to-end tests install from it, so they hold whatever VERSION this checkout is at and however
 * dirty its tree is: a release VERSION reuses its one folder on a second install, and refuses a dirty tree.
 */
const pinnedCheckout = (dir: string, pinned: string): string => {
  const repo = join(import.meta.dir, "..");
  const run = (cwd: string, ...args: string[]): string => {
    const ran = Bun.spawnSync(
      ["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
    return ran.stdout.toString();
  };
  for (const path of run(repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0")) {
    if (path === "" || !existsSync(join(repo, path))) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(join(repo, path), join(dir, path), { verbatimSymlinks: true });
  }
  // The workspace packages' links are relative, so they resolve inside the copy, and through it to the shared store.
  symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"));
  for (const name of readdirSync(join(repo, "packages"))) {
    const modules = join(repo, "packages", name, "node_modules");
    if (existsSync(modules))
      cpSync(modules, join(dir, "packages", name, "node_modules"), {
        recursive: true,
        verbatimSymlinks: true,
      });
  }
  writeFileSync(join(dir, "VERSION"), `${pinned}\n`);
  run(dir, "init", "-q");
  writeFileSync(join(dir, ".git/info/exclude"), "/node_modules\n");
  run(dir, "add", "-A");
  run(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", `fixture at ${pinned}`);
  return dir;
};

// The real script: builds the binary through scripts/build.ts into temp prefixes, with stand-in restic and rclone.
// Each test has its own prefix and install, so they hold in any order or alone. They install from a copy of this
// checkout pinned at a -dev VERSION, so two installs are two builds and the release commit runs them unchanged.
describeT1("scripts/install end to end", () => {
  const top = mkdtempSync(join(scratch, "e2e-"));
  const version = "0.0.1-dev";
  let script = "";
  beforeAll(() => {
    script = join(pinnedCheckout(join(top, "checkout"), version), "scripts/install");
  });
  const tools = join(top, "tools");
  mkdirSync(tools, { recursive: true });
  for (const name of ["restic", "rclone"]) {
    writeFileSync(join(tools, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(tools, name), 0o755);
  }
  const env = { PATH: "/usr/bin:/bin", HOME: join(top, "home") };
  mkdirSync(env.HOME, { recursive: true });
  const install = (prefix: string, ...args: string[]) => {
    const ran = Bun.spawnSync([script, "--prefix", prefix, "--tools", tools, ...args], {
      env: { ...env, PATH: `${join(process.execPath, "..")}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: ran.exitCode, out: ran.stdout.toString(), err: ran.stderr.toString() };
  };

  test("installs the built binary with restic and rclone beside it, and plainport --version runs", () => {
    const prefix = join(top, "one");
    const first = install(prefix);
    expect(first.code).toBe(0);
    expect(first.out).toContain("--tools: restic and rclone are not checked against tools.lock.json");
    const state = readState(prefix);
    expect(state.current).toStartWith(`${version}`);
    for (const name of ["plainport", "restic", "rclone", "build.json"])
      expect(existsSync(join(layout(prefix).versions, state.current ?? "", name))).toBe(true);
    const build = JSON.parse(
      readFileSync(join(layout(prefix).versions, state.current ?? "", "build.json"), "utf8"),
    );
    expect(build.commit).toMatch(/^[0-9a-f]{40}$/);
    const ran = Bun.spawnSync([layout(prefix).bin, "--version"], { env, stdout: "pipe" });
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.toString().trim()).toBe(`plainport ${version}`);
    expect(lstatSync(layout(prefix).bin).isSymbolicLink()).toBe(true);
  }, 120_000);

  test("a second install becomes current and --rollback returns to the first", async () => {
    const prefix = join(top, "two");
    expect(install(prefix).code).toBe(0);
    await Bun.sleep(1100); // dev builds are named by the second they were built in
    expect(install(prefix).code).toBe(0);
    const state = readState(prefix);
    expect(state.versions).toHaveLength(2);
    expect(state.previous).toBe(state.versions[0]);
    expect(state.current).toBe(state.versions[1]);
    const back = install(prefix, "--rollback");
    expect(back.code).toBe(0);
    expect(readState(prefix)).toMatchObject({ current: state.previous, previous: state.current });
    expect(back.out).toContain(`${state.previous}`);
  }, 180_000);

  test("Ctrl-C during the build exits 130 and leaves no lock and no staging folder (R3-M1)", async () => {
    const prefix = join(top, "sigint");
    const child = Bun.spawn([script, "--prefix", prefix, "--tools", tools], {
      env: { ...env, PATH: `${join(process.execPath, "..")}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    const versions = layout(prefix).versions;
    const deadline = Date.now() + 60_000;
    const staging = () =>
      existsSync(versions) ? readdirSync(versions).filter((n) => n.startsWith(".staging-")) : [];
    while (staging().length === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(staging()).toHaveLength(1);
    process.kill(-child.pid, "SIGINT"); // the terminal's Ctrl-C reaches the whole foreground group
    expect(await child.exited).toBe(130);
    expect(await new Response(child.stderr).text()).toContain("interrupted");
    expect(staging()).toEqual([]);
    expect(existsSync(join(layout(prefix).share, ".install.lock"))).toBe(false);
    expect(readState(prefix).current).toBeUndefined();
  }, 120_000);

  test("an installed dev build never walks up into a checkout, and its missing-tool fix says to reinstall (N1)", () => {
    // A checkout-looking folder above the prefix: an installed build must never walk up into it.
    const n1 = join(top, "n1");
    mkdirSync(n1, { recursive: true });
    writeFileSync(join(n1, "tools.lock.json"), "{}", { flag: "w" });
    const target = hostTarget();
    if (target !== undefined) {
      mkdirSync(join(n1, ".tools", target), { recursive: true });
      writeFileSync(join(n1, ".tools", target, "restic"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(n1, ".tools", target, "restic"), 0o755);
    }
    const prefix = join(n1, "prefix");
    expect(install(prefix).code).toBe(0);
    const dir = join(layout(prefix).versions, readState(prefix).current ?? "");
    chmodSync(dir, 0o755);
    rmSync(join(dir, "restic"));
    chmodSync(dir, 0o555);
    const home = join(n1, "home");
    mkdirSync(join(home, "work"), { recursive: true });
    const ran = Bun.spawnSync(
      [
        layout(prefix).bin,
        "init",
        "--root",
        `work=${join(home, "work")}`,
        "--store-path",
        "~/ssd",
        "--device",
        "n1",
        "--yes",
        "--json",
      ],
      { env: { ...env, HOME: home, PLAINPORT_STORE_PASSWORD: "n1" }, stdout: "pipe", stderr: "pipe" },
    );
    const envelope = JSON.parse(ran.stdout.toString().trim().split("\n").at(-1) ?? "{}");
    expect(ran.exitCode).toBe(6);
    expect(envelope.error.finding.code).toBe("tool.missing");
    expect(envelope.error.finding.paths).toEqual([join(realpathSync(dir), "restic")]);
    expect(envelope.error.finding.fix).toContain("reinstall plainport");
  }, 120_000);
});
