// `bun run hooks`: installs a pre-commit shim that runs scripts/pre-commit (Biome, then gitleaks; ADR-0021).
// The shim calls the script from the working tree being committed, so worktrees run their own copy.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const MARKER = "# installed by plainport: bun run hooks";
const SHIM = `#!/bin/sh
${MARKER}
exec "$(git rev-parse --show-toplevel)/scripts/pre-commit" "$@"
`;

export type HookResult = { ok: boolean; message: string };

export const installHooks = (repo: string): HookResult => {
  const run = Bun.spawnSync(["git", "rev-parse", "--git-path", "hooks"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) return { ok: false, message: `not a git repository: ${repo}` };
  const hooks = run.stdout.toString().trim();
  const hook = join(isAbsolute(hooks) ? hooks : join(repo, hooks), "pre-commit");
  if (existsSync(hook)) {
    const current = readFileSync(hook, "utf8");
    if (current === SHIM) return { ok: true, message: `already installed: ${hook}` };
    if (!current.includes(MARKER)) {
      return {
        ok: false,
        message: `${hook} exists and was not written by plainport; move it aside and re-run: bun run hooks`,
      };
    }
  }
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, SHIM);
  chmodSync(hook, 0o755);
  return { ok: true, message: `installed ${hook}` };
};

if (import.meta.main) {
  const result = installHooks(process.cwd());
  (result.ok ? console.log : console.error)(result.message);
  if (!result.ok) process.exit(1);
}
