# ADR-0014 — Agent state moves to the same agent only, fail closed (2026-10-01)

**Context.** Claude Code, Codex and Grok Build key a project's sessions and memory by its absolute path, so a
project that lands at a different path loses them. Their on-disk formats are partly undocumented and change
between versions.

**Decision.** One `AgentAdapter` per agent copies that agent's per-project state to the same agent on the
target, rewrites only the keys its resume reads, verifies through the agent's own read-only commands, and cleans
up only through the agent's own commands. Adapters declare tested versions; an unknown version or a failed
encoding self-check downgrades that agent to handoff notes. Claude Code and Codex adapters ship at M4; Grok
Build follows in M5 and travels as handoff notes until then. Converting sessions between agents is left to the
agents' own importers. Credentials, OAuth tokens and trust decisions never move.

**Why.** Rewriting keys, not content, keeps the blast radius small; failing closed means a format change costs a
handoff note, never a corrupted agent home. agent-yadogae's fail-closed checks and marker-token tests showed
how to prove it.

**Consequences.** Tests run in sandboxed homes (`HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`), never the
real ones, with each supported agent version pinned in CI and marker-token round trips.

**Status.** Accepted (owner, 2026-10-01).

**Design.** Agent state: sessions, memory and trust; Plugin interfaces (`AgentAdapter`); Prior art →
agent-yadogae, herdr Teleport.
