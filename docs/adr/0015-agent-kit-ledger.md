# ADR-0015 — The agent kit lives in dotfiles and is ledger-owned (2026-10-01)

**Context.** Agents on a newly reached device lack the owner's skills, MCP servers and global instructions.
Writing into agent config files directly would break when their formats change, and touching hand-made items
would destroy the owner's work.

**Decision.** The kit is declared in `~/dotfiles/agents/` (`kit.toml`, `skills/`, `instructions/`). `kit plan`
compares it with what each agent reports through its own read-back commands; `kit apply` installs through the
agents' own CLIs (`claude mcp add --scope user`, `codex mcp add`, `grok mcp add`) and symlinks skills; a
per-device ledger records every item plainport installed with its hash. Updates and removals touch only ledger
items. Secret values are never written; MCP definitions carry environment-variable references.

**Why.** The agents' own commands survive their format changes. The ledger makes "touch only what plainport
installed" (AGENTS.md rule 10) checkable.

**Consequences.** Applying twice changes nothing; a same-named hand-made item is a `kit.conflict` finding and is
left alone. Grok reads Claude Code's locations, so plainport skips Grok when that suffices.

**Status.** Accepted (owner, 2026-10-01).

**Design.** Agent kit: skills, MCP servers and instructions.
