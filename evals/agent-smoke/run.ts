import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { posixSpawner, runProcess } from "../../packages/core/src/index.ts";
import { buildCommand } from "../../scripts/build.ts";
import { hashTree } from "../../test/crash-matrix/fixture.ts";
import { statusEvidence } from "./observation.ts";
import { agentArgs, sandboxEnv } from "./sandbox.ts";
import { CallSchema, ObservationSchema, scoreTranscript, type Transcript } from "./scorer.ts";
import { cleanupSession, prepareSessionCleanup } from "./session.ts";

const RecordedCall = CallSchema.extend({
  startedAt: z.number(),
  observations: z.array(ObservationSchema.omit({ afterCall: true })),
});
const Options = z.object({ agent: z.enum(["claude", "codex"]).default("claude") });

/** Extract the agent's final issue list from either provider's JSONL text blocks. No tool output is scored here. */
export function agentIssues(lines: string[]): string[] {
  const issues: string[] = [];
  let found = false;
  const inspect = (text: string) => {
    const starts: number[] = [];
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"' && starts.length > 0) quoted = true;
      if (char === "{") starts.push(index);
      if (char !== "}" || starts.length === 0) continue;
      const start = starts.pop() as number;
      try {
        const parsed = z
          .object({ contractIssues: z.array(z.string()) })
          .safeParse(JSON.parse(text.slice(start, index + 1)));
        if (parsed.success) {
          found = true;
          issues.push(...parsed.data.contractIssues);
        }
      } catch {
        // Other prose is retained in the raw transcript.
      }
    }
  };
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) if (block.type === "text") inspect(block.text);
      }
      if (event.type === "result" && typeof event.result === "string") inspect(event.result);
      if (event.type === "item.completed" && event.item?.type === "agent_message") inspect(event.item.text);
    } catch {
      /* stderr and unstructured lines are retained as evidence. */
    }
  }
  return found ? [...new Set(issues)] : ["Agent did not supply its final contractIssues list."];
}

export function runEval(agent: "claude" | "codex") {
  return runEvalWith(agent, runProcess, resolve(import.meta.dir, "../../.orchestrate/raw"));
}

/** The process port is injected for offline harness acceptance tests. */
export async function runEvalWith(
  agent: "claude" | "codex",
  executeProcess: typeof runProcess,
  rawDir: string,
  temporaryParent = tmpdir(),
  agentHome = homedir(),
) {
  const repo = resolve(import.meta.dir, "../..");
  const area = mkdtempSync(join(temporaryParent, "plainport-agent-smoke-"));
  const stem = `task-16-${agent}-${Date.now()}`;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let sessionCleanup: ReturnType<typeof prepareSessionCleanup> | undefined;
  const cleanedAgentPaths: string[] = [];
  const raw: string[] = [];
  let rawBytes = 0;
  const issues: string[] = [];
  const transcript: Transcript = {
    version: 1,
    project: "work:fixture",
    agentExitCode: null,
    fixtureIntact: false,
    agentIssues: issues,
    calls: [],
    observations: [],
    observationIssues: [],
  };
  // Never serialize this password. Config and the recorder settings contain only its env reference.
  const password = randomBytes(32).toString("hex");
  const redact = (text: string) => text.replaceAll(password, "[redacted]");
  try {
    const path = `${join(area, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`;
    const tools = process.env.PLAINPORT_TOOLS_DIR || join(repo, `.tools/${process.platform}-${process.arch}`);
    const env = sandboxEnv(area, path, tools);
    for (const dir of [
      "bin",
      "tmp",
      "calls",
      "store",
      "work",
      "home/.config/plainport",
      "codex-state",
      "codex-log",
    ])
      mkdirSync(join(area, dir), { recursive: true });
    const project = join(area, "work/fixture");
    cpSync(join(import.meta.dir, "project"), project, { recursive: true });
    // Generate ignored data at runtime, as ADR-0021 requires.
    writeFileSync(join(project, ".env"), "TOKEN=op://fixture/item/token\n");
    const reference = hashTree(project, ["node_modules"]);
    cpSync(join(repo, "plainport.json"), join(area, "plainport.json"));
    writeFileSync(env.PLAINPORT_CONFIG as string, `version = 1\n[offload]\nkeepLocalFor = "24h"\n`);
    const binary = join(area, "plainport-real");
    const execute = (command: string, args: string[]) =>
      executeProcess(posixSpawner, {
        command,
        args,
        cwd: area,
        env: { ...env, PLAINPORT_STORE_PASSWORD: password },
        signal: abort.signal,
        timeoutMs: 5 * 60_000,
        idleTimeoutMs: 60_000,
        capture: { maxBytes: 8 * 1024 * 1024 },
      });
    const build = buildCommand(process.execPath, repo, { outfile: binary });
    const compiled = await execute(build[0] as string, build.slice(1));
    if (!compiled.ok || compiled.value.exitCode !== 0) {
      issues.push(
        `Setup build failed: ${compiled.ok ? compiled.value.stderr.text : compiled.finding.message}`,
      );
    } else {
      const init = await execute(binary, [
        "init",
        "--root",
        `work=${join(area, "work")}`,
        "--store-path",
        join(area, "store"),
        "--device",
        "eval",
        "--yes",
        "--json",
      ]);
      if (!init.ok || init.value.exitCode !== 0) {
        issues.push(
          `Setup init failed: ${init.ok ? new TextDecoder().decode(init.value.captured) : init.finding.message}`,
        );
      } else {
        writeFileSync(join(area, "settings.json"), JSON.stringify({ binary, env }));
        // Shell-quote only executable paths, never JSON.stringify them into shell code.
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        writeFileSync(
          join(area, "bin/plainport"),
          `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(import.meta.dir, "call.ts"))} "$@"\n`,
          { mode: 0o755 },
        );
        // The agent keeps its normal authentication. Only plainport's recorder receives the sandbox env.
        const agentEnv = Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] =>
              entry[1] !== undefined && !entry[0].startsWith("PLAINPORT_"),
          ),
        );
        if (agent === "claude") sessionCleanup = prepareSessionCleanup(agentHome, area);
        const result = await executeProcess(posixSpawner, {
          command: agent,
          args: agentArgs(agent, area),
          cwd: area,
          env: { ...agentEnv, PATH: path, PLAINPORT_EVAL_AREA: area, PLAINPORT_STORE_PASSWORD: password },
          stdin: readFileSync(join(import.meta.dir, "prompt.md"), "utf8"),
          signal: abort.signal,
          timeoutMs: 15 * 60_000,
          idleTimeoutMs: 3 * 60_000,
          outputLimitBytes: 1024 * 1024,
          maxLineBytes: 1024 * 1024,
          onLine: (line) => {
            // Bound the recording too. An incomplete transcript never passes.
            if (rawBytes + line.text.length < 8 * 1024 * 1024) {
              rawBytes += line.text.length;
              raw.push(
                JSON.stringify({ stream: line.stream, text: redact(line.text), truncated: line.truncated }),
              );
            } else if (!issues.includes("Agent transcript exceeded 8 MiB."))
              issues.push("Agent transcript exceeded 8 MiB.");
            if (line.truncated) issues.push("Agent output contained a truncated line.");
          },
        });
        transcript.agentExitCode = result.ok ? result.value.exitCode : result.exitCode;
        if (!result.ok) issues.push(`${result.finding.message} ${result.finding.fix ?? ""}`);
        issues.push(...agentIssues(raw.map((line) => JSON.parse(line).text)));
        const final = statusEvidence(await execute(binary, ["status", "work:fixture", "--json"]));
        transcript.finalObservation = final.observation;
        transcript.observationIssues.push(...final.issues);
      }
    }
    try {
      const restored = hashTree(project, ["node_modules"]);
      transcript.fixtureIntact =
        reference.size === restored.size &&
        [...reference].every(([name, hash]) => restored.get(name) === hash);
    } catch {
      transcript.fixtureIntact = false;
    }
  } catch (error) {
    issues.push(`Eval failed: ${String(error)}`);
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    try {
      const calls = readdirSync(join(area, "calls"))
        .filter((file) => file.endsWith(".json"))
        .map((file) => RecordedCall.parse(JSON.parse(readFileSync(join(area, "calls", file), "utf8"))))
        .sort((a, b) => a.startedAt - b.startedAt);
      transcript.calls = calls.map(({ startedAt: _time, observations: _observations, ...call }) => call);
      transcript.observations = calls.flatMap((call, index) =>
        call.observations.map((observation) => ({ ...observation, afterCall: index + 1 })),
      );
    } catch (error) {
      issues.push(`Call evidence could not be read: ${String(error)}`);
    }
    if (sessionCleanup) {
      try {
        cleanedAgentPaths.push(...cleanupSession(sessionCleanup));
      } catch (error) {
        issues.push(`Agent session cleanup failed: ${String(error)}`);
      }
    }
    rmSync(area, { recursive: true, force: true });
  }
  // These are the only retained artifacts. They hold no config, environment dump or repository password.
  mkdirSync(rawDir, { recursive: true });
  const score = scoreTranscript(transcript);
  writeFileSync(join(rawDir, `${stem}.agent.jsonl`), `${raw.join("\n")}\n`);
  writeFileSync(
    join(rawDir, `${stem}.json`),
    redact(JSON.stringify({ ...transcript, cleanedAgentPaths, score }, null, 2)),
  );
  console.log(JSON.stringify({ ...score, transcript: join(rawDir, `${stem}.json`) }, null, 2));
  return score.passed ? 0 : 1;
}

if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { agent: { type: "string" } } });
  const options = Options.parse(values);
  process.exitCode = await runEval(options.agent);
}
