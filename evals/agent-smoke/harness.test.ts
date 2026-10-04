import { expect, test } from "bun:test";
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
