# ADR-0007 — The machine contract: envelope, exit codes, risk classes (2026-10-01)

**Context.** People and coding agents drive plainport through the same CLI. Agents need output and refusals they
can act on without reading prose, and the contract must be fixed before anything is built on it.

**Decision.** From M1, before the first command ships:

- Every command declares a risk class: `read`, `safe_write` or `confirm`. A `confirm` command without `--yes`
  (or an approved `--plan <id>`) exits 3 and prints the exact command to re-run. `--dry-run` is always `read`.
- `--json` prints NDJSON: progress, phase and finding lines, then exactly one final envelope
  `{"plainport_json": 1, "ok": …, "verb": …, "data" | "error": …}`, with `error.code` equal to the exit code.
- Exit codes 0–5 mean what they mean in plainkeep; 6–11 are plainport's (blocked or stale plan, verification
  failed, conflict, unreachable, unhydrated, locked); 130 is cancelled.
- Finding codes (`git.unpushed`, `root.unbound`, …) are stable strings with a `fix`.
- A generated `plainport.json` describes every command's arguments, output schema and risk class. Help and
  completions are generated from the same registry. Generated files are never edited by hand.

**Why.** plainkeep proved that refusals which name the next call turn errors into an agent's feedback loop
(ADR-0003). Matching codes 0–5 lets a plainkeep pack pass results through unchanged.

**Consequences.** The envelope, exit codes, finding codes and schemas are public API; changing them is a breaking
change with a version bump. CI pins them with schema validation and snapshot tests.

**Status.** Accepted (owner, 2026-10-01: "plainkeep's contract from M1").

**Design.** Core concepts (one contract); CLI design (exit codes, `--json`); Core API (`Finding`).
