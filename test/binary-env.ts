// What the suites that run the compiled binary share (the crash matrix's subprocess variant, the compatibility suite): the
// environment a hooked binary runs in, the restic copy it finds its tools in, and the build with the test hook on.
//
// The binary refuses every path under the real home (guardFromEnv), so its PATH leaves out folders there (git, lsof and
// find stay), its tools are a copy outside the checkout, and PLAINPORT_TRIPWIRE_REAL_HOME names the real home so a hooked
// build accepts its test rails (packages/cli/src/test-hooks.ts).

import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostTarget } from "../packages/core/src/tools.ts";

export const checkoutRoot = resolve(import.meta.dir, "..");
const REAL_HOME = process.env.PLAINPORT_TRIPWIRE_REAL_HOME ?? "";

/** The test's PATH without the folders under the real home. */
export const binaryPath = (): string =>
  (process.env.PATH ?? "/usr/bin:/bin")
    .split(":")
    .filter((p) => REAL_HOME === "" || !(p === REAL_HOME || p.startsWith(`${REAL_HOME}/`)))
    .join(":");

/** The binary's environment: the sandbox named in full (the tripwire fills in what a child's env leaves out). */
export const binaryEnv = (
  home: string,
  tools: string,
  password: string,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: join(home, ".local/state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local/share"),
  PATH: binaryPath(),
  PLAINPORT_STORE_PASSWORD: password,
  PLAINPORT_TRIPWIRE_REAL_HOME: REAL_HOME,
  PLAINPORT_TOOLS_DIR: tools,
  ...extra,
});

/** A copy of the pinned restic in `dir/tools`, which the binary can read (the checkout's `.tools` is under the real home). */
export const toolsCopy = (dir: string): string => {
  const target = hostTarget();
  if (target === undefined) throw new Error(`no tools for ${process.platform}-${process.arch}`);
  const tools = join(dir, "tools");
  mkdirSync(tools, { recursive: true });
  copyFileSync(join(checkoutRoot, ".tools", target, "restic"), join(tools, "restic"));
  chmodSync(join(tools, "restic"), 0o755);
  return tools;
};

/** Compiles the checkout with the test hook on (`--define globalThis.PLAINPORT_TEST_HOOKS=true`). Throws on failure. */
export const buildHookedBinary = (outfile: string): string => {
  const build = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      join(checkoutRoot, "packages/cli/src/main.ts"),
      "--outfile",
      outfile,
      "--define",
      "globalThis.PLAINPORT_TEST_HOOKS=true",
    ],
    { cwd: checkoutRoot, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(`building the hooked binary: ${build.stderr.toString()}`);
  return outfile;
};
