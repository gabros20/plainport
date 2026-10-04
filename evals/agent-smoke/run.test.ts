import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "../../packages/contract/src/index.ts";
import type { runProcess } from "../../packages/core/src/index.ts";
import { runEvalWith } from "./run.ts";

test("harness builds, initializes, records a fake agent and removes its entire sandbox", async () => {
  const parent = mkdtempSync(join(tmpdir(), "plainport-eval-test-"));
  let area = "";
  const stages: string[] = [];
  const runner: typeof runProcess = async (_spawner, spec) => {
    area = spec.cwd;
    expect(spec.timeoutMs).toBeGreaterThan(0);
    expect(spec.idleTimeoutMs).toBeGreaterThan(0);
    if (spec.command === "claude") {
      stages.push("agent");
      expect(spec.args).toContain("--no-session-persistence");
      expect(spec.env.PLAINPORT_EVAL_AREA).toBe(area);
      const settings = JSON.parse(readFileSync(join(area, "settings.json"), "utf8"));
      expect(settings.env.HOME).toBe(join(area, "home"));
      expect(settings.env.PLAINPORT_STORE_PASSWORD).toBeUndefined();
      expect(readFileSync(settings.env.PLAINPORT_CONFIG, "utf8")).not.toContain(
        spec.env.PLAINPORT_STORE_PASSWORD as string,
      );
      for (const [index, state] of ["shelved", "local"].entries()) {
        const verb = index === 0 ? "offload" : "onload";
        writeFileSync(
          join(area, "calls", `${index}.json`),
          JSON.stringify({
            startedAt: index,
            argv: [verb, "work:fixture", "--json", "--yes"],
            exitCode: 0,
            stdout: JSON.stringify({ plainport_json: 1, ok: true, verb, data: {} }),
            stderr: "",
            observations: [{ project: "work:fixture", state }],
          }),
        );
      }
      spec.onLine?.({
        stream: "stdout",
        truncated: false,
        text: JSON.stringify({ type: "result", result: '{"contractIssues":[]}' }),
      });
    } else {
      stages.push(stages.length === 0 ? "build" : "init");
      expect(spec.env.HOME).toBe(join(area, "home"));
      expect(spec.env.XDG_CONFIG_HOME).toStartWith(area);
      expect(spec.env.PLAINPORT_CONFIG).toStartWith(area);
    }
    return ok({
      exitCode: 0,
      signal: null,
      stdout: { text: "", droppedBytes: 0 },
      stderr: { text: "", droppedBytes: 0 },
      captured: new Uint8Array(),
      leftoversStopped: false,
      durationMs: 1,
    });
  };
  try {
    const evidence = join(parent, "evidence");
    expect(await runEvalWith("claude", runner, evidence, parent)).toBe(0);
    expect(stages).toEqual(["build", "init", "agent"]);
    expect(existsSync(area)).toBe(false);
    const saved = readdirSync(evidence).find((name) => name.endsWith(".json"));
    const transcript = JSON.parse(readFileSync(join(evidence, saved as string), "utf8"));
    expect(transcript.score.calls).toBe(2);
    expect(transcript.score.passed).toBe(true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("harness records setup failure and still cleans up without starting an agent", async () => {
  const parent = mkdtempSync(join(tmpdir(), "plainport-eval-failure-"));
  let area = "";
  const runner: typeof runProcess = async (_spawner, spec) => {
    area = spec.cwd;
    expect(spec.command).not.toBe("claude");
    return ok({
      exitCode: 1,
      signal: null,
      stdout: { text: "", droppedBytes: 0 },
      stderr: { text: "build failed", droppedBytes: 0 },
      captured: new Uint8Array(),
      leftoversStopped: false,
      durationMs: 1,
    });
  };
  try {
    expect(await runEvalWith("claude", runner, join(parent, "evidence"), parent)).toBe(1);
    expect(existsSync(area)).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
