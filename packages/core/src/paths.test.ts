import { describe, expect, test } from "bun:test";
import { resolvePaths } from "./paths.ts";

const HOME = "/sandbox/home";

describe("config: paths", () => {
  test("XDG defaults under HOME", () => {
    const result = resolvePaths({ HOME });
    if (!result.ok) throw new Error(result.finding.message);
    const paths = result.value;
    expect(paths.home).toBe(HOME);
    expect(paths.configDir).toBe(`${HOME}/.config/plainport`);
    expect(paths.configFile).toBe(`${HOME}/.config/plainport/config.toml`);
    expect(paths.configFileSource).toBe("default");
    expect(paths.managedFile).toBe(`${HOME}/.config/plainport/managed.toml`);
    expect(paths.managedLock).toBe(`${HOME}/.config/plainport/managed.toml.lock`);
    expect(paths.stateDir).toBe(`${HOME}/.local/state/plainport`);
    expect(paths.deviceFile).toBe(`${HOME}/.local/state/plainport/device.json`);
    expect(paths.registryFile).toBe(`${HOME}/.local/state/plainport/registry.json`);
    expect(paths.journalDir).toBe(`${HOME}/.local/state/plainport/journal`);
    expect(paths.locksDir).toBe(`${HOME}/.local/state/plainport/locks`);
    expect(paths.plansDir).toBe(`${HOME}/.local/state/plainport/plans`);
    expect(paths.kitLedgerFile).toBe(`${HOME}/.local/state/plainport/kit-ledger.json`);
    expect(paths.cacheDir).toBe(`${HOME}/.cache/plainport`);
  });

  test("absolute XDG_*_HOME variables override HOME; relative ones are ignored, as the XDG spec says", () => {
    const result = resolvePaths({
      HOME,
      XDG_CONFIG_HOME: "/x/config",
      XDG_STATE_HOME: "/x/state",
      XDG_CACHE_HOME: "relative/cache",
    });
    if (!result.ok) throw new Error(result.finding.message);
    expect(result.value.configFile).toBe("/x/config/plainport/config.toml");
    expect(result.value.managedFile).toBe("/x/config/plainport/managed.toml");
    expect(result.value.deviceFile).toBe("/x/state/plainport/device.json");
    expect(result.value.cacheDir).toBe(`${HOME}/.cache/plainport`);
  });

  test("PLAINPORT_CONFIG and --config replace config.toml only; managed.toml stays in the config folder", () => {
    const env = resolvePaths({ HOME, PLAINPORT_CONFIG: "~/dotfiles/plainport.toml" });
    if (!env.ok) throw new Error(env.finding.message);
    expect(env.value.configFile).toBe(`${HOME}/dotfiles/plainport.toml`);
    expect(env.value.configFileSource).toBe("env");
    expect(env.value.managedFile).toBe(`${HOME}/.config/plainport/managed.toml`);

    const flag = resolvePaths(
      { HOME, PLAINPORT_CONFIG: "/ignored.toml" },
      { configFlag: "conf/p.toml", cwd: "/work" },
    );
    if (!flag.ok) throw new Error(flag.finding.message);
    expect(flag.value.configFile).toBe("/work/conf/p.toml");
    expect(flag.value.configFileSource).toBe("flag");
  });

  test("a missing or relative HOME is a finding, never a guess", () => {
    for (const env of [{}, { HOME: "" }, { HOME: "relative/home" }]) {
      const result = resolvePaths(env);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.finding.code).toBe("config.no-home");
      expect(result.exitCode).toBe(6);
      expect(result.finding.fix).toBeDefined();
    }
  });

  test("reads only the env it is given, never os.homedir()", () => {
    const result = resolvePaths({ HOME: "/elsewhere" });
    if (!result.ok) throw new Error(result.finding.message);
    expect(result.value.configDir.startsWith("/elsewhere/")).toBe(true);
  });
});
