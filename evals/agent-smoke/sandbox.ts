import { join } from "node:path";

/** A complete child environment, never an overlay on the owner's plainport settings. */
export function sandboxEnv(area: string, path: string, tools: string): Record<string, string> {
  const home = join(area, "home");
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    GROK_HOME: join(home, ".grok"),
    TMPDIR: join(area, "tmp"),
    PATH: path,
    PLAINPORT_TOOLS_DIR: tools,
    PLAINPORT_CONFIG: join(home, ".config/plainport/config.toml"),
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

export function agentArgs(agent: "claude" | "codex"): string[] {
  return agent === "claude"
    ? [
        "-p",
        "--no-session-persistence",
        "--output-format",
        "stream-json",
        "--verbose",
        "--tools",
        "Bash,Read",
        "--allowedTools",
        "Bash",
        "Read",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--settings",
        '{"disableAllHooks":true}',
      ]
    : [
        "exec",
        "--ephemeral",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "--ignore-user-config",
        "--ignore-rules",
        "-",
      ];
}
