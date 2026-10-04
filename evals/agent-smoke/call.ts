// The temporary PATH wrapper calls this recorder. Observer calls bypass the wrapper and are not agent calls.
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { posixSpawner, runProcess } from "../../packages/core/src/index.ts";
import { lastEnvelope, type Observation } from "./scorer.ts";

if (import.meta.main) {
  const area = process.env.PLAINPORT_EVAL_AREA;
  if (!area) throw new Error("recorder requires PLAINPORT_EVAL_AREA");
  const settings = z
    .object({ binary: z.string(), env: z.record(z.string(), z.string()) })
    .parse(JSON.parse(readFileSync(join(area, "settings.json"), "utf8")));
  const env = { ...settings.env, PLAINPORT_STORE_PASSWORD: process.env.PLAINPORT_STORE_PASSWORD ?? "" };
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const argv = process.argv.slice(2);
  const startedAt = Date.now();
  const execute = (args: string[]) =>
    runProcess(posixSpawner, {
      command: settings.binary,
      args,
      cwd: area,
      env,
      signal: abort.signal,
      timeoutMs: 5 * 60_000,
      idleTimeoutMs: 60_000,
      capture: { maxBytes: 8 * 1024 * 1024 },
    });
  const id = randomUUID();
  const temporary = join(area, "calls", `${id}.tmp`);
  const password = env.PLAINPORT_STORE_PASSWORD;
  const redact = (text: string) => (password ? text.replaceAll(password, "[redacted]") : text);
  const save = (record: object) => {
    writeFileSync(temporary, redact(JSON.stringify({ startedAt, ...record })));
    renameSync(temporary, join(area, "calls", `${id}.json`));
  };
  save({
    argv,
    exitCode: null,
    stdout: "",
    stderr: "",
    observations: [],
    issues: ["Call was interrupted before recording completed."],
  });
  try {
    const result = await execute(argv);
    const exitCode = result.ok ? result.value.exitCode : result.exitCode;
    const stdout = result.ok ? new TextDecoder().decode(result.value.captured) : "";
    const stderr = result.ok
      ? result.value.stderr.text
      : `${result.finding.message}\n${result.finding.fix ?? ""}`;
    const observations: Omit<Observation, "afterCall">[] = [];
    // Read after every invocation, including a refusal: state evidence is independent of the agent's claims.
    if (!abort.signal.aborted) {
      const state = await execute(["status", "work:fixture", "--json"]);
      if (state.ok && state.value.exitCode === 0) {
        const text = new TextDecoder().decode(state.value.captured);
        const parsed = lastEnvelope(text);
        if (parsed.success && parsed.data.ok) {
          const data = JSON.parse(text.trim().split("\n").at(-1) ?? "").data;
          if (data.address === "work:fixture" && typeof data.state === "string")
            observations.push({ project: data.address, state: data.state });
        }
      }
    }
    const issues: string[] = [];
    if (!result.ok) issues.push(`${result.finding.message} ${result.finding.fix ?? ""}`);
    if (result.ok && result.value.stderr.droppedBytes > 0)
      issues.push("Call stderr exceeded its recording limit.");
    save({ argv, exitCode, stdout, stderr, observations, issues });
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    process.exitCode = exitCode ?? 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
