# ADR-0005 — Libraries: Zod, smol-toml, a typed command registry (2026-10-02)

**Context.** `docs/HANDOFF.md` proposed a stack beyond the decided runtime. AGENTS.md requires Zod schemas at
every edge and a single command registry from which help, completions and `plainport.json` are generated.

**Decision (proposed).**

| Layer | Choice |
| --- | --- |
| Schemas | Zod, exported as JSON Schema (decided) |
| Commands | A typed registry: argument schema, output schema, risk class and handler per command; `node:util` `parseArgs` parses; help, completions and `plainport.json` are generated |
| Config | TOML via `smol-toml`: read `config.toml`, write `managed.toml` |
| Prompts | `@clack/prompts`, only for `plainport init` in an interactive terminal (plainkeep uses it too) |
| IDs | ULIDs (a small dependency-free implementation or `ulid`) |
| Catalog sealing | `@noble/ciphers` XChaCha20-Poly1305 (M2) |
| Envelope | `age` and `age-plugin-se` as bundled binaries (M3) |
| Tests | `bun test`, fast-check for the fold and planner properties |
| TUI | Ink by default; re-check OpenTUI at M6 |

**Why.** Each is small, pure TypeScript and compiles into the binary. `parseArgs` avoids a CLI framework that
would own help text the registry must generate. Rejected: commander and yargs (they generate their own help),
`@iarna/toml` (unmaintained, no TOML 1.0 writer).

**Consequences.** The registry is the first code M1 writes after the scaffold; every later command is a
registry entry. Once M1 has confirmed these choices, `DESIGN.md` gains a Stack section and this record becomes
Accepted.

**Status.** Proposed, to confirm during M1 phase 1.

**Design.** Core API → Design rules; CLI design; HANDOFF "Proposed stack details".
