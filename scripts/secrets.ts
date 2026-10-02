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

export type ScanVerdict = { ok: true } | { ok: false; exitCode: number; message: string };

/**
 * gitleaks exits 0 even when its own git call fails: it logs ERR, scans nothing and reports no leaks. So a scan
 * passes only if gitleaks exited 0, logged no ERR line, and, for a full scan, covered at least one commit.
 */
export const scanVerdict = (run: { exitCode: number; output: string; staged: boolean }): ScanVerdict => {
  if (run.exitCode !== 0)
    return { ok: false, exitCode: run.exitCode, message: `gitleaks exited ${run.exitCode}` };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
  const lines = run.output.replace(/\u001b\[[0-9;]*m/g, "").split("\n");
  const error = lines.find((line) => /\bERR\b/.test(line));
  if (error !== undefined)
    return { ok: false, exitCode: 1, message: `gitleaks reported an error: ${error.trim()}` };
  if (!run.staged) {
    const scanned = lines.map((line) => /(\d+) commits scanned/.exec(line)?.[1]).find((n) => n !== undefined);
    if (scanned === undefined || Number(scanned) === 0) {
      return {
        ok: false,
        exitCode: 1,
        message: `a full scan must cover the history, but gitleaks scanned ${scanned ?? "no"} commits`,
      };
    }
  }
  return { ok: true };
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
  const staged = Bun.argv.includes("--staged");
  const run = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  const verdict = scanVerdict({
    exitCode: run.exitCode ?? 1,
    output: run.stdout.toString() + run.stderr.toString(),
    staged,
  });
  if (!verdict.ok) {
    console.error(`bun run secrets: ${verdict.message}`);
    process.exit(verdict.exitCode);
  }
}
