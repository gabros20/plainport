# ADR-0003 — Reuse plainkeep's contract by copying, never by depending (2026-10-02)

**Context.** The owner wants to avoid reinventing what plainkeep already built and tested. plainkeep's compiled
core (`cli/src/core/`, Bun and TypeScript, about 6,700 lines with tests) is a port of its Python dispatcher. It
resolves verbs in a vault's `bin/` folder, spawns Python to run them, and enforces plainkeep's path-wall and
vault root. It is not a library and has no package boundary.

**Decision.** Copy, adapt and credit the pieces that fit plainport's design, into plainport's own packages and
under plainport's own tests. Never take a runtime or build dependency on the plainkeep repository. A piece that
would bend plainport's core toward plainkeep's shape is not copied. The owner's rule: "use it if it fits, but it
must not shape this app's core if it isn't suitable."

| plainkeep source | What plainport takes | Lands in | Milestone |
| --- | --- | --- | --- |
| `docs/machine-contract.md` §1–3, §6 | Envelope shape (`plainport_json: 1` in place of `ops_json`), error object, exit codes 0–5, `--dry-run` is `read`, stability policy | `docs/machine-contract.md`, `packages/contract` | M1 |
| `cli/src/core/guardrail.ts` (`EXIT_*`, risk verdicts, remediation text) | Risk-class gate: `confirm` without `--yes` exits 3 and prints the exact re-run; an undeclared command is `confirm` | `packages/contract` | M1 |
| `cli/package.json` `check:bun` | Refuse Bun older than 1.2.21, which drops empty-string arguments when spawning | root `package.json` | M1 |
| `cli/src/core/complete.ts` and §8 | Completion contract generated from the registry | `packages/cli` | M1 |
| plainkeep's contract round-trip test | Every command's `--json` output validated against its declared schema in CI | `packages/cli` tests | M1 |
| `cli/src/core/mcp.ts` | Tool list generated from `plainport.json` (pattern only; plainport serves JSON-RPC, MCP optional) | `packages/rpc` | M4 |
| `bin/lib/launchdlib.py`, ADR-022 | launchd plist writing, consent and reversal | `packages/jobs` | M3 |
| `bin/lib/agentskills.py` (skill installer) | Symlink install into each agent's skills folder, refuse to replace a hand-made folder | `packages/agents` kit, `setup agents` | M4 |

Not taken: the dispatcher and resolver (Python verb exec), the vault root and path-wall, the Python SDK
(`lib/api.py`), the plugin trust ceiling.

**Why.** Copying keeps plainport a single compiled binary with no Python floor and no coupling to plainkeep's
release cadence, while still inheriting a contract that has been battle-tested with agents. Matching exit codes
0–5 and the envelope means a future plainkeep pack can pass plainport's output straight through.

**Consequences.** Each copied file starts with a one-line provenance comment naming the plainkeep path and
commit (`gabros20/plainkeep@d7eb27e` as of 2026-10-02). Fixes found later are offered back to plainkeep by hand.
The two contracts may drift; plainport's `docs/machine-contract.md` is authoritative for plainport.

**Status.** Accepted (owner, 2026-10-02).

**Design.** Core concepts (one contract); CLI design; Prior art → plainkeep.
