// Where plainport keeps its config and per-machine state (DESIGN.md "Local state per machine"). XDG paths, so
// config can live in a dotfiles repo: $XDG_CONFIG_HOME, $XDG_STATE_HOME and $XDG_CACHE_HOME when they are
// absolute (the XDG spec says to ignore relative ones), else ~/.config, ~/.local/state and ~/.cache.
//
// Everything is resolved from the environment passed in, never from os.homedir(): Bun fixes that at start-up,
// and tests run with a sandboxed HOME.

import { dirname, isAbsolute, join, resolve } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";

export type Env = Record<string, string | undefined>;

export interface PlainportPaths {
  home: string;
  configDir: string;
  /** The user's config.toml, which plainport reads and never rewrites. */
  configFile: string;
  /** Where configFile came from: the XDG default, $PLAINPORT_CONFIG or --config. */
  configFileSource: "default" | "env" | "flag";
  /** Beside configFile, wherever --config or $PLAINPORT_CONFIG puts it (DESIGN.md "Configuration", run decision D20). */
  managedFile: string;
  managedLock: string;
  stateDir: string;
  deviceFile: string;
  registryFile: string;
  journalDir: string;
  locksDir: string;
  plansDir: string;
  kitLedgerFile: string;
  cacheDir: string;
}

export interface PathOptions {
  /** The --config flag; it outranks $PLAINPORT_CONFIG. */
  configFlag?: string | undefined;
  /** What a relative --config or $PLAINPORT_CONFIG is resolved against. Default: process.cwd(). */
  cwd?: string;
}

const xdg = (env: Env, name: string, home: string, fallback: string): string => {
  const value = env[name];
  return value !== undefined && isAbsolute(value) ? value : join(home, fallback);
};

/** `~` and `~/…` mean HOME, as a shell would expand them; anything else resolves against cwd. */
export const expandHome = (path: string, home: string, cwd: string): string =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : resolve(cwd, path);

export const resolvePaths = (env: Env, options: PathOptions = {}): Result<PlainportPaths> => {
  const home = env.HOME;
  if (home === undefined || home === "" || !isAbsolute(home)) {
    return fail(
      finding("config.no-home", {
        message:
          home === undefined || home === ""
            ? "HOME is not set, so plainport cannot find its config and state"
            : `HOME is ${JSON.stringify(home)}, which is not an absolute path`,
        fix: "set HOME to your home folder, e.g. export HOME=/Users/<you>, and re-run",
      }),
    );
  }
  const cwd = options.cwd ?? process.cwd();
  const configDir = join(xdg(env, "XDG_CONFIG_HOME", home, ".config"), "plainport");
  const stateDir = join(xdg(env, "XDG_STATE_HOME", home, ".local/state"), "plainport");

  let configFile = join(configDir, "config.toml");
  let configFileSource: PlainportPaths["configFileSource"] = "default";
  if (options.configFlag !== undefined && options.configFlag !== "") {
    configFile = expandHome(options.configFlag, home, cwd);
    configFileSource = "flag";
  } else if (env.PLAINPORT_CONFIG !== undefined && env.PLAINPORT_CONFIG !== "") {
    configFile = expandHome(env.PLAINPORT_CONFIG, home, cwd);
    configFileSource = "env";
  }

  const managedFile = join(dirname(configFile), "managed.toml");
  return ok({
    home,
    configDir,
    configFile,
    configFileSource,
    managedFile,
    managedLock: `${managedFile}.lock`,
    stateDir,
    deviceFile: join(stateDir, "device.json"),
    registryFile: join(stateDir, "registry.json"),
    journalDir: join(stateDir, "journal"),
    locksDir: join(stateDir, "locks"),
    plansDir: join(stateDir, "plans"),
    kitLedgerFile: join(stateDir, "kit-ledger.json"),
    cacheDir: join(xdg(env, "XDG_CACHE_HOME", home, ".cache"), "plainport"),
  });
};
