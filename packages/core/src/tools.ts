// Where plainport finds the pinned restic and rclone binaries (ADR-0006). The lookup order is:
// 1. $PLAINPORT_TOOLS_DIR, a folder that holds the binaries (for tests and unusual installs);
// 2. the folder of the running plainport binary, where releases bundle them (ADR-0020);
// 3. the checkout's .tools/<os>-<arch>/, which `bun scripts/fetch-tools.ts` fills for development and tests.

import { accessSync, constants, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

export type ToolSource = "env" | "beside-binary" | "dev-tools";

export type ToolPathResult =
  | { ok: true; path: string; source: ToolSource }
  | { ok: false; code: "tool.missing"; message: string; fix: string; searched: string[] };

export type ToolPathContext = {
  env?: Record<string, string | undefined>;
  /** The running plainport binary. Leave it out to use process.execPath when compiled, nothing from source. */
  execPath?: string | undefined;
  /** The checkout's .tools/ folder. Leave it out to use this checkout's when running from source. */
  devToolsDir?: string | undefined;
  target?: Target | undefined;
  isExecutable?: (path: string) => boolean;
};

// A compiled binary serves its own modules from Bun's embedded file system.
const compiled = import.meta.dir.startsWith("/$bunfs/");

const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const toolPath = (name: ToolName, context: ToolPathContext = {}): ToolPathResult => {
  const env = context.env ?? process.env;
  const execPath = "execPath" in context ? context.execPath : compiled ? process.execPath : undefined;
  const devToolsDir =
    "devToolsDir" in context
      ? context.devToolsDir
      : compiled
        ? undefined
        : resolve(import.meta.dir, "../../../.tools");
  const target = "target" in context ? context.target : hostTarget();
  const isExecutable = context.isExecutable ?? isExecutableFile;

  const candidates: { path: string; source: ToolSource }[] = [];
  const toolsDir = env.PLAINPORT_TOOLS_DIR;
  if (toolsDir) candidates.push({ path: join(resolve(toolsDir), name), source: "env" });
  if (execPath !== undefined)
    candidates.push({ path: join(dirname(execPath), name), source: "beside-binary" });
  if (devToolsDir !== undefined && target !== undefined) {
    candidates.push({ path: join(devToolsDir, target, name), source: "dev-tools" });
  }

  for (const candidate of candidates) {
    if (isExecutable(candidate.path)) return { ok: true, ...candidate };
  }
  const searched = candidates.map((candidate) => candidate.path);
  return {
    ok: false,
    code: "tool.missing",
    message: `${name} not found${searched.length > 0 ? `; looked for ${searched.join(", ")}` : ""}`,
    fix: `run \`bun scripts/fetch-tools.ts\` in the plainport checkout, or set PLAINPORT_TOOLS_DIR to a folder that holds ${name}`,
    searched,
  };
};
