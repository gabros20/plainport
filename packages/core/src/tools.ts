// Where plainport finds the pinned restic and rclone binaries (ADR-0006).
//
// If $PLAINPORT_TOOLS_DIR is set (a developer and test override, CONTRIBUTING.md), it is the only place looked
// at, so a test that points it at fakes never silently runs real binaries. Otherwise, in order:
// 1. the folder of the running plainport binary, where releases bundle them (ADR-0020); symlinks to the binary
//    are resolved, so the folder is the real one;
// 2. the checkout's .tools/<os>-<arch>/, which `bun scripts/fetch-tools.ts` fills. This is a development aid:
//    from source it is this checkout's; a development build (VERSION ends in -dev) walks up from the binary to the
//    folder holding tools.lock.json, so `dist/plainport` works after a fetch. A release build never looks there.

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { VERSION } from "./version.ts";

export const TOOL_NAMES = ["restic", "rclone"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;
export type Target = (typeof TARGETS)[number];

/** The release target for a platform and architecture, or undefined when plainport doesn't ship for it. */
export const hostTarget = (
  platform: string = process.platform,
  arch: string = process.arch,
): Target | undefined => {
  const key = `${platform}-${arch}`;
  return (TARGETS as readonly string[]).includes(key) ? (key as Target) : undefined;
};

/** The .tools/ folder of the nearest checkout at or above `start`: the first folder holding tools.lock.json. */
export const checkoutToolsDir = (
  start: string,
  exists: (path: string) => boolean = existsSync,
): string | undefined => {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (exists(join(dir, "tools.lock.json"))) return join(dir, ".tools");
    if (dirname(dir) === dir) return undefined;
  }
};

export type ToolSource = "env" | "beside-binary" | "dev-tools";

export type ToolPathResult =
  | { ok: true; path: string; source: ToolSource }
  | { ok: false; code: "tool.missing"; exitCode: 6; message: string; fix: string; searched: string[] };

/** How this code is running: from source under bun, or as a compiled development or release binary. */
export type BuildKind = "source" | "dev" | "release";

/**
 * Overrides for toolPath, mainly for tests. A key left out or set to undefined takes its default; null means
 * "none" (no binary folder, no .tools/, no target).
 */
export type ToolPathContext = {
  env?: Record<string, string | undefined>;
  /** Default: detected from the module location and the VERSION baked in at build time. */
  build?: BuildKind;
  /** The running plainport binary. Default: process.execPath in a compiled build, none from source. */
  execPath?: string | null;
  /** The .tools/ folder. Default: this checkout's from source, the binary's checkout's in a dev build. */
  devToolsDir?: string | null;
  /** Default: hostTarget(). */
  target?: Target | null;
  isExecutable?: (path: string) => boolean;
};

// A compiled binary serves its own modules from Bun's embedded file system.
const detectedBuild: BuildKind = !import.meta.dir.startsWith("/$bunfs/")
  ? "source"
  : VERSION.endsWith("-dev")
    ? "dev"
    : "release";

const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const defaultDevToolsDir = (build: BuildKind, execPath: string | null): string | null => {
  if (build === "source") return resolve(import.meta.dir, "../../../.tools");
  if (build === "dev" && execPath !== null) return checkoutToolsDir(dirname(execPath)) ?? null;
  return null;
};

export const toolPath = (name: ToolName, context: ToolPathContext = {}): ToolPathResult => {
  const env = context.env ?? process.env;
  const build = context.build ?? detectedBuild;
  const execPath =
    context.execPath === undefined ? (build === "source" ? null : process.execPath) : context.execPath;
  const devToolsDir =
    context.devToolsDir === undefined ? defaultDevToolsDir(build, execPath) : context.devToolsDir;
  const target = context.target === undefined ? (hostTarget() ?? null) : context.target;
  const isExecutable = context.isExecutable ?? isExecutableFile;

  const candidates: { path: string; source: ToolSource }[] = [];
  const toolsDir = env.PLAINPORT_TOOLS_DIR;
  if (toolsDir) {
    candidates.push({ path: join(resolve(toolsDir), name), source: "env" });
  } else {
    if (execPath !== null) candidates.push({ path: join(dirname(execPath), name), source: "beside-binary" });
    if (devToolsDir !== null && target !== null) {
      candidates.push({ path: join(devToolsDir, target, name), source: "dev-tools" });
    }
  }

  for (const candidate of candidates) {
    if (isExecutable(candidate.path)) return { ok: true, ...candidate };
  }
  const searched = candidates.map((candidate) => candidate.path);
  let fix: string;
  if (toolsDir) {
    fix = `put ${name} in ${resolve(toolsDir)}, or unset PLAINPORT_TOOLS_DIR`;
  } else if (build === "release") {
    fix = `reinstall plainport: its ${name} ships beside the plainport binary${execPath === null ? "" : ` in ${dirname(execPath)}`}`;
  } else {
    fix = "run `bun scripts/fetch-tools.ts` in the plainport checkout";
  }
  return {
    ok: false,
    code: "tool.missing",
    // Exit code 6: blocked by a preflight finding (DESIGN.md "Exit codes"); nothing has been touched yet.
    exitCode: 6,
    message: `${name} not found${searched.length > 0 ? `; looked for ${searched.join(", ")}` : ""}`,
    fix,
    searched,
  };
};
