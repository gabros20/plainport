import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { agentIssues } from "./run.ts";
import { agentArgs, sandboxEnv } from "./sandbox.ts";

test("harness keeps every plainport home and config path in the temporary area", () => {
  const env = sandboxEnv("/tmp/agent-smoke", "/tmp/agent-smoke/bin:/usr/bin", "/tmp/tools");
  for (const key of [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "GROK_HOME",
    "PLAINPORT_CONFIG",
    "TMPDIR",
    "npm_config_cache",
  ])
    expect(env[key]).toStartWith("/tmp/agent-smoke/");
  expect(env.PLAINPORT_STORE_PASSWORD).toBeUndefined();
  expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(agentArgs("claude")).toContain("--no-session-persistence");
  expect(agentArgs("codex")).toContain("--ephemeral");
  expect(agentArgs("codex")).toContain("workspace-write");
});

test("harness keeps reported confusion from Claude and Codex without scoring tool output", () => {
  const note = '{"contractIssues":["The message was unclear."]}';
  const lines = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: note }] } }),
    JSON.stringify({ type: "result", result: note }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: note } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", text: note } }),
  ];
  expect(agentIssues(lines)).toEqual(["The message was unclear."]);
  expect(agentIssues([JSON.stringify({ type: "result", result: '{"contractIssues":[]}' })])).toEqual([]);
  expect(agentIssues([])).toEqual(["Agent did not supply its final contractIssues list."]);
});

test("harness parses complete JSON issue objects with delimiters inside strings", () => {
  for (const text of [
    'Done.\n```json\n{"contractIssues":["The response ended in ]} without a hint", "quote: \\" { }"]}\n```',
    'Earlier {"other": true}. Final {"contractIssues":["The response ended in ]} without a hint", "quote: \\" { }"]}',
  ])
    expect(agentIssues([JSON.stringify({ type: "result", result: text })])).toEqual([
      "The response ended in ]} without a hint",
      'quote: " { }',
    ]);
});

test("Codex retains login home but directs runtime databases and logs into the temporary area", () => {
  const args = agentArgs("codex", "/tmp/plainport-agent-smoke-unique");
  expect(args).toContain('sqlite_home="/tmp/plainport-agent-smoke-unique/codex-state"');
  expect(args).toContain('log_dir="/tmp/plainport-agent-smoke-unique/codex-log"');
  expect(args).toContain('history.persistence="none"');
});

test("harness finds the final JSON object after prose with an unmatched brace", () => {
  const text = 'The help mentioned { placeholders.\n```json\n{"contractIssues":["Missing hint"]}\n```';
  expect(agentIssues([JSON.stringify({ type: "result", result: text })])).toEqual(["Missing hint"]);
});

test("harness finds final issues after an unfinished JSON string in prose", () => {
  const line = readFileSync(new URL("transcripts/unfinished-prose.json", import.meta.url), "utf8");
  expect(agentIssues([line])).toEqual(["Missing next-step hint"]);
});
