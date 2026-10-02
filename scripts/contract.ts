// `bun run contract` regenerates plainport.json, schemas/ and completions/ from the command registry
// (packages/cli/src/generate.ts). `--check` writes nothing and exits 1 when a committed file is stale (CI).

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { REGISTRY } from "../packages/cli/src/commands/index.ts";
import { staleFiles, writeFiles } from "../packages/cli/src/generate.ts";

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { check: { type: "boolean" } } });
  if (values.check) {
    const stale = staleFiles(root, REGISTRY);
    if (stale.length > 0) {
      console.error(
        `bun run contract: stale generated files; run bun run contract and commit:\n  ${stale.join("\n  ")}`,
      );
      process.exit(1);
    }
    console.log("bun run contract: generated files are up to date");
  } else {
    const changed = writeFiles(root, REGISTRY);
    console.log(
      changed.length === 0
        ? "bun run contract: nothing changed"
        : `bun run contract: wrote\n  ${changed.join("\n  ")}`,
    );
  }
}
