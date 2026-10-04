// `bun run build`: compiles packages/cli/src/main.ts into one binary (ADR-0004). VERSION is baked in by
// packages/cli/src/version.ts. Flags: --outfile <path> (default dist/plainport); --target <bun-target> for one
// cross-compile; --target all for every release target, into dist/plainport-<os>-<arch> (CI's compile smoke);
// --installed for the binary scripts/install puts in a version folder (it finds its tools only beside itself).

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export const TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64"] as const;

export type Build = { outfile: string; target?: string; installed?: boolean };
export type BuildPlan = { ok: true; builds: Build[] } | { ok: false; message: string };

export const buildPlan = (
  root: string,
  options: { outfile?: string; target?: string; installed?: boolean },
): BuildPlan => {
  const { outfile, target, installed } = options;
  if (target === "all") {
    if (outfile !== undefined) return { ok: false, message: "--outfile can't be combined with --target all" };
    return {
      ok: true,
      builds: TARGETS.map((name) => ({
        outfile: join(root, "dist", `plainport-${name.slice(4)}`),
        target: name,
        ...(installed === true ? { installed } : {}),
      })),
    };
  }
  if (target !== undefined && !(TARGETS as readonly string[]).includes(target)) {
    return { ok: false, message: `unknown --target ${target}; use one of ${TARGETS.join(", ")} or all` };
  }
  const build: Build = { outfile: resolve(outfile ?? join(root, "dist", "plainport")) };
  if (target !== undefined) build.target = target;
  if (installed === true) build.installed = true;
  return { ok: true, builds: [build] };
};

/**
 * The compile command for one build. Every build defines the crash matrix's hook off, so the composition root's test
 * folds to false and the bundler drops the hook (packages/cli/src/test-hooks.ts, D67). An installed build also defines
 * PLAINPORT_INSTALLED, which makes even a -dev version look for its tools only beside the binary
 * (packages/core/src/tools.ts).
 */
export const buildCommand = (bun: string, root: string, { outfile, target, installed }: Build): string[] => {
  const command = [bun, "build", "--compile", join(root, "packages/cli/src/main.ts"), "--outfile", outfile];
  command.push("--define", "globalThis.PLAINPORT_TEST_HOOKS=false");
  if (target !== undefined) command.push(`--target=${target}`);
  if (installed === true) command.push("--define", "globalThis.PLAINPORT_INSTALLED=true");
  return command;
};

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      outfile: { type: "string" },
      target: { type: "string" },
      installed: { type: "boolean" },
    },
  });
  const plan = buildPlan(root, values);
  if (!plan.ok) {
    console.error(`bun run build: ${plan.message}`);
    process.exit(2);
  }
  for (const build of plan.builds) {
    const ran = Bun.spawnSync(buildCommand(process.execPath, root, build), {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (ran.exitCode !== 0) process.exit(ran.exitCode ?? 1);
  }
}
