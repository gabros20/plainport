// The temporary PATH wrapper calls this recorder. Observer calls bypass the wrapper and are not agent calls.
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { posixSpawner, runProcess } from "../../packages/core/src/index.ts";
import { observeOffloadDeletion } from "./deletion.ts";
import { statusEvidence } from "./observation.ts";

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
    const deletionIssues = await observeOffloadDeletion(area, env, argv, exitCode, stdout, {
      signal: abort.signal,
    });
    const evidence = !abort.signal.aborted
      ? statusEvidence(await execute(["status", "work:fixture", "--json"]))
      : { issues: ["Status observation was cancelled."] };
    const observations = evidence.observation ? [evidence.observation] : [];
    const issues: string[] = [...deletionIssues, ...evidence.issues];
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
