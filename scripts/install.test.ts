import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostTarget } from "../packages/core/src/tools.ts";
import { installVersion, layout, readState, removeInstall, rollback, versionName } from "./install.ts";

const scratch = mkdtempSync(join(tmpdir(), "plainport-install-test-"));
afterAll(() => removeInstall(scratch));

const stageFake =
  (text: string) =>
  (dir: string): void => {
    for (const name of ["plainport", "restic", "rclone"])
      writeFileSync(join(dir, name), `#!/bin/sh\necho ${text}\n`);
  };

describe("versionName", () => {
  test("a release installs under its version; a dev build under its version, build time and commit", () => {
    expect(versionName("0.1.0", "abc1234", new Date("2026-10-04T12:34:56Z"))).toBe("0.1.0");
    expect(versionName("0.1.0-dev", "abc1234", new Date("2026-10-04T12:34:56Z"))).toBe(
      "0.1.0-dev+20261004123456.abc1234",
    );
  });
});

describe("installVersion and rollback", () => {
  const prefix = join(scratch, "unit");

  test("installs a read-only version tree behind current, with bin/plainport pointing through current", () => {
    const first = installVersion(prefix, "0.1.0", stageFake("one"));
    expect(first).toEqual({ ok: true, version: "0.1.0", previous: undefined, reused: false });
    const paths = layout(prefix);
    expect(readlinkSync(paths.current)).toBe("versions/0.1.0");
    expect(readlinkSync(paths.bin)).toBe(join(paths.current, "plainport"));
    expect(realpathSync(paths.bin)).toBe(realpathSync(join(paths.versions, "0.1.0", "plainport")));
    expect(statSync(join(paths.versions, "0.1.0")).mode & 0o222).toBe(0);
    expect(statSync(join(paths.versions, "0.1.0", "restic")).mode & 0o777).toBe(0o555);
    expect(readState(prefix)).toEqual({ current: "0.1.0", previous: undefined, versions: ["0.1.0"] });
  });

  test("a second version records the first as the rollback target and keeps both", () => {
    const second = installVersion(prefix, "0.2.0", stageFake("two"));
    expect(second).toEqual({ ok: true, version: "0.2.0", previous: "0.1.0", reused: false });
    expect(readState(prefix)).toEqual({ current: "0.2.0", previous: "0.1.0", versions: ["0.1.0", "0.2.0"] });
    expect(readFileSync(layout(prefix).bin, "utf8")).toContain("echo two");
  });

  test("--rollback swaps current and previous, and a second rollback swaps them back", () => {
    expect(rollback(prefix)).toEqual({ ok: true, from: "0.2.0", to: "0.1.0" });
    expect(readState(prefix)).toMatchObject({ current: "0.1.0", previous: "0.2.0" });
    expect(readFileSync(layout(prefix).bin, "utf8")).toContain("echo one");
    expect(rollback(prefix)).toEqual({ ok: true, from: "0.1.0", to: "0.2.0" });
  });

  test("reinstalling a version that is already installed activates it without staging again", () => {
    let staged = false;
    const again = installVersion(prefix, "0.1.0", () => {
      staged = true;
    });
    expect(again).toEqual({ ok: true, version: "0.1.0", previous: "0.2.0", reused: true });
    expect(staged).toBe(false);
  });

  test("a failed stage leaves the install as it was and no staging folder behind", () => {
    const before = readState(prefix);
    const failed = installVersion(prefix, "0.3.0", () => {
      throw new Error("build broke");
    });
    expect(failed.ok).toBe(false);
    expect(readState(prefix)).toEqual(before);
  });

  test("rollback with nothing to roll back to, and a foreign bin/plainport, are refused", () => {
    const fresh = join(scratch, "fresh");
    expect(rollback(fresh).ok).toBe(false);
    installVersion(fresh, "0.1.0", stageFake("one"));
    expect(rollback(fresh)).toMatchObject({ ok: false });
    const foreign = join(scratch, "foreign");
    mkdirSync(join(foreign, "bin"), { recursive: true });
    writeFileSync(join(foreign, "bin/plainport"), "not ours");
    const refused = installVersion(foreign, "0.1.0", stageFake("one"));
    expect(refused.ok).toBe(false);
    expect(readFileSync(join(foreign, "bin/plainport"), "utf8")).toBe("not ours");
  });
});

// The real script: builds the binary through scripts/build.ts into a temp prefix, with stand-in restic and rclone.
describe("scripts/install", () => {
  const top = join(scratch, "e2e");
  const prefix = join(top, "prefix");
  const tools = join(top, "tools");
  const script = join(import.meta.dir, "install");
  const env = { PATH: "/usr/bin:/bin", HOME: join(top, "home") };
  const run = (...args: string[]) => {
    const ran = Bun.spawnSync([script, "--prefix", prefix, "--tools", tools, ...args], {
      env: { ...env, PATH: `${join(process.execPath, "..")}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: ran.exitCode, out: ran.stdout.toString(), err: ran.stderr.toString() };
  };
  const version = readFileSync(join(import.meta.dir, "../VERSION"), "utf8").trim();
  let first: ReturnType<typeof run>;
  let second: ReturnType<typeof run>;

  beforeAll(() => {
    mkdirSync(tools, { recursive: true });
    mkdirSync(env.HOME, { recursive: true });
    for (const name of ["restic", "rclone"]) {
      writeFileSync(join(tools, name), "#!/bin/sh\nexit 0\n");
      chmodSync(join(tools, name), 0o755);
    }
    // A checkout-looking folder above the prefix: an installed build must never walk up into it (N1).
    writeFileSync(join(top, "tools.lock.json"), "{}");
    const target = hostTarget();
    if (target !== undefined) {
      mkdirSync(join(top, ".tools", target), { recursive: true });
      writeFileSync(join(top, ".tools", target, "restic"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(top, ".tools", target, "restic"), 0o755);
    }
    first = run();
    second = run();
  }, 180_000);

  test("installs the built binary with restic and rclone beside it, and plainport --version runs", () => {
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    const state = readState(prefix);
    expect(state.current).toStartWith(`${version}`);
    for (const name of ["plainport", "restic", "rclone"])
      expect(existsSync(join(layout(prefix).versions, state.current ?? "", name))).toBe(true);
    const ran = Bun.spawnSync([layout(prefix).bin, "--version"], { env, stdout: "pipe" });
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.toString()).toContain(version);
    expect(lstatSync(layout(prefix).bin).isSymbolicLink()).toBe(true);
  });

  test("a second install becomes current and --rollback returns to the first", () => {
    expect(second.code).toBe(0);
    const state = readState(prefix);
    expect(state.versions).toHaveLength(2);
    expect(state.previous).toBe(state.versions[0]);
    expect(state.current).toBe(state.versions[1]);
    const back = run("--rollback");
    expect(back.code).toBe(0);
    expect(readState(prefix)).toMatchObject({ current: state.previous, previous: state.current });
    expect(back.out).toContain(`${state.previous}`);
  });

  test("an installed dev build never walks up into a checkout, and its missing-tool fix says to reinstall (N1)", () => {
    const state = readState(prefix);
    const dir = join(layout(prefix).versions, state.current ?? "");
    chmodSync(dir, 0o755);
    rmSync(join(dir, "restic"));
    chmodSync(dir, 0o555);
    const home = join(top, "n1-home");
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
  });
});
