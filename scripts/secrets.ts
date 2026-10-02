// `bun run secrets`: gitleaks over the whole git history (ADR-0021). gitleaks runs from its Docker image, pinned
// here, so no global install is needed (run decision D1). `--staged` scans only the staged changes, for the
// pre-commit hook. `--redact` keeps secret values out of the output.

import { resolve } from "node:path";

const IMAGE = "zricethezav/gitleaks:v8.30.1";
const root = resolve(import.meta.dir, "..");
const staged = Bun.argv.includes("--staged");

if (Bun.which("docker") === null) {
  console.error(
    "bun run secrets: docker not found; gitleaks runs in Docker. Start OrbStack or Docker and re-run.",
  );
  process.exit(1);
}

const scan = staged
  ? ["git", "--staged", "--no-banner", "--redact", "--verbose", "/repo"]
  : ["detect", "--source", "/repo", "--no-banner", "--redact", "--verbose"];
const run = Bun.spawnSync(["docker", "run", "--rm", "-v", `${root}:/repo:ro`, IMAGE, ...scan], {
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(run.exitCode ?? 1);
