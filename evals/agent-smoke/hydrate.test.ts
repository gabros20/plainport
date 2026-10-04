import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { posixSpawner, runProcess } from "../../packages/core/src/index.ts";
import { hashTree } from "../../test/crash-matrix/fixture.ts";
import { sandboxEnv } from "./sandbox.ts";

test("dependency-free fixture hydrates with npm ci offline and a sandboxed cache", async () => {
  const area = mkdtempSync(join(tmpdir(), "plainport-eval-hydrate-"));
  try {
    const env = sandboxEnv(area, process.env.PATH ?? "/usr/bin:/bin", join(area, "tools"));
    expect(env.npm_config_cache).toBe(join(area, "home/.npm"));
    expect(env.npm_config_offline).toBe("true");
    for (const dir of ["home", "tmp"]) mkdirSync(join(area, dir), { recursive: true });
    const project = join(area, "fixture");
    cpSync(join(import.meta.dir, "project"), project, { recursive: true });
    const before = hashTree(project, ["node_modules"]);
    const result = await runProcess(posixSpawner, {
      command: "npm",
      args: ["ci"],
      cwd: project,
      env,
      timeoutMs: 30_000,
      idleTimeoutMs: 10_000,
      capture: { maxBytes: 1024 * 1024 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.finding.message);
    expect(result.value.exitCode).toBe(0);
    expect(existsSync(env.npm_config_cache as string)).toBe(true);
    expect(hashTree(project, ["node_modules"])).toEqual(before);
  } finally {
    rmSync(area, { recursive: true, force: true });
  }
});
