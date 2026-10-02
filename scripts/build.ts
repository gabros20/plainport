// `bun run build`: compiles packages/cli/src/main.ts into one binary (ADR-0004). VERSION is baked in by
// packages/cli/src/version.ts. Flags: --outfile <path> (default dist/plainport); --target <bun-target> for one
// cross-compile; --target all for every release target, into dist/plainport-<os>-<arch> (CI's compile smoke).

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export const TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64"] as const;

export type Build = { outfile: string; target?: string };
export type BuildPlan = { ok: true; builds: Build[] } | { ok: false; message: string };

export const buildPlan = (root: string, options: { outfile?: string; target?: string }): BuildPlan => {
  const { outfile, target } = options;
  if (target === "all") {
    if (outfile !== undefined) return { ok: false, message: "--outfile can't be combined with --target all" };
    return {
      ok: true,
      builds: TARGETS.map((name) => ({
        outfile: join(root, "dist", `plainport-${name.slice(4)}`),
        target: name,
      })),
    };
  }
  if (target !== undefined && !(TARGETS as readonly string[]).includes(target)) {
    return { ok: false, message: `unknown --target ${target}; use one of ${TARGETS.join(", ")} or all` };
  }
  const build: Build = { outfile: resolve(outfile ?? join(root, "dist", "plainport")) };
  if (target !== undefined) build.target = target;
  return { ok: true, builds: [build] };
};

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { outfile: { type: "string" }, target: { type: "string" } },
  });
  const plan = buildPlan(root, values);
  if (!plan.ok) {
    console.error(`bun run build: ${plan.message}`);
    process.exit(2);
  }
  for (const { outfile, target } of plan.builds) {
    const command = [
      process.execPath,
      "build",
      "--compile",
      join(root, "packages/cli/src/main.ts"),
      "--outfile",
      outfile,
    ];
    if (target !== undefined) command.push(`--target=${target}`);
    const build = Bun.spawnSync(command, { cwd: root, stdout: "inherit", stderr: "inherit" });
    if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
  }
}
