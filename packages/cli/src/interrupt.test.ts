// SIGINT and SIGTERM to plainport stop every child it is running, whole process groups included, before it exits
// 130. Children run in their own session, so the terminal's Ctrl-C never reaches them by itself.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = { PATH: "/usr/bin:/bin" };
let dir: string;
const parents: Bun.Subprocess[] = [];
const groups: number[] = [];

const members = (pgid: number): string[] =>
  Bun.spawnSync(["/usr/bin/pgrep", "-g", String(pgid)], { stdout: "pipe", env })
    .stdout.toString()
    .split("\n")
    .filter(Boolean);

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-interrupt-")));
});
afterEach(async () => {
  for (const parent of parents.splice(0)) {
    parent.kill("SIGKILL");
    await parent.exited;
  }
  const left = groups.splice(0).filter((pgid) => members(pgid).length > 0);
  for (const pgid of left) process.kill(-pgid, "SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  if (left.length > 0) throw new Error(`process groups left behind: ${left.join(", ")}`);
});

/** A plainport-like process: the macOS host, stopOnSignals, and one long child whose group id it prints. */
const startParent = async (
  script: string,
): Promise<{ parent: Bun.Subprocess<"ignore", "pipe", "pipe">; pgid: number }> => {
  const fixture = join(dir, "parent.ts");
  writeFileSync(
    fixture,
    `import { createMacosHost } from ${JSON.stringify(join(import.meta.dir, "../../host-macos/src/index.ts"))};\n` +
      `import { stopOnSignals } from ${JSON.stringify(join(import.meta.dir, "interrupt.ts"))};\n` +
      "const host = createMacosHost();\n" +
      `const done = host.run({ command: "/bin/sh", args: ["-c", ${JSON.stringify(script)}], cwd: ${JSON.stringify(dir)},\n` +
      `  env: { PATH: "/usr/bin:/bin" }, killGraceMs: 300, onLine: (line) => console.log(line.text) })\n` +
      "  .then((result) => (result.ok ? 0 : result.exitCode));\n" +
      "stopOnSignals(host, done, { stderr: (text) => process.stderr.write(text) });\n" +
      "process.exitCode = await done;\n",
  );
  const parent = Bun.spawn([process.execPath, fixture], {
    cwd: dir,
    env: { ...env, HOME: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  parents.push(parent);
  const reader = parent.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`the parent ended early: ${await new Response(parent.stderr).text()}`);
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const pgid = Number(text.split("\n")[0]);
  groups.push(pgid);
  return { parent, pgid };
};

describe("interrupt: signals to plainport stop its children", () => {
  test("SIGINT stops a plain child's whole group, then plainport exits 130", async () => {
    const { parent, pgid } = await startParent("echo $$; sleep 60 & sleep 60");
    expect(members(pgid).length).toBeGreaterThan(0);
    parent.kill("SIGINT");
    expect(await parent.exited).toBe(130);
    expect(members(pgid)).toEqual([]);
    expect(await new Response(parent.stderr).text()).toContain("stopping");
  });

  test("SIGTERM stops a child that traps TERM (KILL after the grace period), then plainport exits 130", async () => {
    const { parent, pgid } = await startParent('trap "" TERM; echo $$; while :; do sleep 1; done');
    parent.kill("SIGTERM");
    expect(await parent.exited).toBe(130);
    expect(members(pgid)).toEqual([]);
  });
});
