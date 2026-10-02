// `bun run build`: compiles packages/cli/src/main.ts into one binary (ADR-0004). VERSION is baked in by
// packages/cli/src/version.ts. Flags: --outfile <path> (default dist/plainport), --target <bun-target>
// for a cross-compile such as bun-linux-x64.

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dir, "..");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { outfile: { type: "string" }, target: { type: "string" } },
});
const outfile = resolve(values.outfile ?? join(root, "dist", "plainport"));
const command = [
  process.execPath,
  "build",
  "--compile",
  join(root, "packages/cli/src/main.ts"),
  "--outfile",
  outfile,
];
if (values.target !== undefined) command.push(`--target=${values.target}`);

const build = Bun.spawnSync(command, { cwd: root, stdout: "inherit", stderr: "inherit" });
process.exit(build.exitCode ?? 1);
