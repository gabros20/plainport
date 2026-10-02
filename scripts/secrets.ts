// `bun run secrets`: gitleaks over the whole git history (ADR-0021). gitleaks runs from its Docker image, pinned
// here, so no global install is needed (run decision D1). `--staged` scans only the staged changes, for the
// pre-commit hook. `--redact` keeps secret values out of the output.
//
// Paths are mounted at their host paths. In a linked worktree `.git` is a file pointing into the main checkout's
// common git dir, so that dir is mounted too; without it git inside the container finds no repository and
// gitleaks scans nothing and passes.

import { resolve } from "node:path";

export const IMAGE = "zricethezav/gitleaks:v8.30.1";

const isUnder = (root: string, path: string): boolean => path === root || path.startsWith(`${root}/`);

export const scanCommand = (options: { toplevel: string; commonDir: string; staged: boolean }): string[] => {
  const { toplevel, commonDir, staged } = options;
  const mounts = ["-v", `${toplevel}:${toplevel}:ro`];
  if (!isUnder(toplevel, commonDir)) mounts.push("-v", `${commonDir}:${commonDir}:ro`);
  const scan = staged
    ? ["git", "--staged", "--no-banner", "--redact", "--verbose", toplevel]
    : ["detect", "--source", toplevel, "--no-banner", "--redact", "--verbose"];
  return ["docker", "run", "--rm", ...mounts, IMAGE, ...scan];
};

if (import.meta.main) {
  if (Bun.which("docker") === null) {
    console.error(
      "bun run secrets: docker not found; gitleaks runs in Docker. Start OrbStack or Docker and re-run.",
    );
    process.exit(1);
  }
  const git = (...args: string[]): string => {
    const run = Bun.spawnSync(["git", ...args], {
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (run.exitCode !== 0) {
      console.error(`bun run secrets: git ${args.join(" ")} failed: ${run.stderr.toString().trim()}`);
      process.exit(1);
    }
    return run.stdout.toString().trim();
  };
  const argv = scanCommand({
    toplevel: git("rev-parse", "--show-toplevel"),
    commonDir: git("rev-parse", "--path-format=absolute", "--git-common-dir"),
    staged: Bun.argv.includes("--staged"),
  });
  const run = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });
  process.exit(run.exitCode ?? 1);
}
