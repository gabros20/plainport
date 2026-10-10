# AGENTS.md — plainport

plainport keeps coding projects portable across machines and storage. `offload` snapshots a project, verifies the snapshot and deletes the local copy; `onload` restores it and reinstalls dependencies; `move` hands a project, and what coding agents remember about it, to another device; `kit` keeps agents' skills and MCP servers the same on every device.

These instructions are stable rules for any coding agent working in this repository. Status and next steps live in `docs/HANDOFF.md`, not here.

## Read first

- `docs/DESIGN.md` is the source of truth for behaviour, including its **Decisions** section. If code and design disagree, stop and ask. When a decision changes with the owner's agreement, update `DESIGN.md` in the same change.
- `docs/HANDOFF.md` says where the project stands and which milestone is next. Work on one milestone at a time.

## Stack

- TypeScript on Bun, compiled to a single binary with `bun build --compile`. No native modules.
- Zod schemas at every edge (events, stubs, plans, config, RPC), exported as JSON Schema.
- External binaries are pinned and bundled: restic (0.18.0 or later) and rclone; age and age-plugin-se arrive with the secrets envelope. The system's OpenSSH and git are used as installed.
- Package layout follows the "Package layout" block in `DESIGN.md`. Create a package only when a milestone needs it.

## Rules that are not negotiable

1. **Never lose work.** The local folder is touched only in the release phase, after the snapshot is verified. Every destructive step is journaled, so `recover` can finish or roll it back.
2. **Gitignored does not mean disposable.** Strip only what an ecosystem plugin declares regenerable and git does not track. `.env` files and local databases travel with the project.
3. **One contract for people and agents.** Every command declares a risk class (`read`, `safe_write`, `confirm`). A `confirm` command without `--yes` exits 3 and prints the exact command to re-run. Exit codes 0 to 5 mean what they mean in plainkeep; 6 to 11 are plainport's own. The `--json` envelope, exit codes and schemas are public API: changing them is a breaking change.
4. **Define commands once.** Each command lives in the command registry with its argument schema, output schema, risk class and handler. Help, completions and `plainport.json` are generated from it; never edit generated files by hand.
5. **Ports for every side effect.** Engine, blob store, host, secrets, transport and agent adapters are injected; the core stays pure and testable with fakes.
6. **One process runner.** Every child process (restic, rclone, git, ssh, package managers, hooks) runs in its own process group, with bounded output, an idle deadline and an overall deadline.
7. **Errors are values with codes.** Exceptions mean bugs; expected failures return a result with an exit code and a finding with a stable code and a fix.
8. **No resident daemon.** Scheduled work is a timer that runs one command and exits. Nothing deletes on a timer; pruning needs `prune --yes`.
9. **Secrets stay references.** Never write a secret value into a file, log, config or agent config; use `op://` items or environment-variable references. Never lend git tokens to another device.
10. **Touch only what plainport installed.** Agent state and kit items change only through each agent's own commands, only for items in plainport's ledger, and an unknown agent version fails closed to handoff notes.

## Testing

- Tests never touch the real home folder, real stores or real agent folders. Use temporary directories and sandboxed homes (`HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`).
- Destructive paths are covered by the crash matrix: kill the process at every journal step, run `recover`, check the invariants in `DESIGN.md`.
- Round trips must be byte-identical apart from stripped paths.
- Every bug fix comes with a test that fails without it.

## Commands

Milestone M1 creates these scripts; keep their names stable:

- `bun install`: install dependencies
- `bun test`: run the test suite
- `bun run build`: compile the `plainport` binary
- `bun run contract`: regenerate `plainport.json` and the JSON Schemas

## Working style

- Small, reviewable changes, each with tests.
- Follow the milestone order in `DESIGN.md`. Don't build ahead of the current milestone's gate.
- CLI messages are plain and specific. A refusal names the finding code and the exact fix.
