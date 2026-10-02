# plainport: handoff from claude.ai

2 October 2026

plainport was designed in a claude.ai conversation between 29 September and 2 October 2026. This file carries what that conversation knew into the repository, so any coding agent can pick up from here.

## Where things stand

- **Design: complete.** `docs/DESIGN.md` is an export of the living design doc as of 2 October 2026 and is now the source of truth. The claude.ai doc stays as the archive: https://claude.ai/artifact/3qMK5CKtGksjZZwSVnb6iu
- **Open questions: none.** All 16 were settled; the **Decisions** section of `DESIGN.md` lists the 26 decisions.
- **Code: none yet.** The next step is milestone M1.
- **M0 prep (2 October 2026, Claude Code session):** git repository created and pushed to the private
  `gabros20/plainport`; ADRs in `docs/adr/` record every design decision plus three new ones (copy plainkeep's
  contract, test-first with the crash matrix, delivery through `/orchestrate`); `docs/ROADMAP.md` stages
  M0–M6; `docs/plans/M1-local-core.md` is the 16-task M1 plan for `/orchestrate`, awaiting approval.
  ADR-0018 (test environments) is filled from the vault note
  `wiki/research/linux-test-hosts-sandboxes-and-stores-2026.md` and live OrbStack checks, and awaits the owner.
  ADR-0020 (versioning, release and install, copied from plainkeep: no signing, no Homebrew, no Renovate) and
  ADR-0021 (factory-floor guardrails) are accepted. `.claude/settings.json` and `CONTRIBUTING.md` (Definition of
  Done, release routine) are in place. SSH alias `mini` is set up on the laptop but untested, because the mini
  was offline in Tailscale.

## Proposed stack details (not yet in DESIGN.md)

Confirm these during M1, then add a Stack section to `DESIGN.md`.

| Layer | Choice | Status |
| --- | --- | --- |
| Runtime | TypeScript on Bun, `bun build --compile` for macOS and Linux (arm64 and x64) | Decided |
| Commands | A typed command registry: Zod argument and output schemas, risk class and handler per command. `util.parseArgs` parses; help, completions and `plainport.json` are generated from the registry | Proposed |
| Schemas | Zod, exported as JSON Schema | Decided |
| Config | TOML via `smol-toml`: read `config.toml`, write `managed.toml` | Proposed |
| Snapshots and metadata | restic and rclone, bundled and pinned | Decided |
| Encryption | `age` plus `age-plugin-se` for the secrets envelope (a third bundled binary, needed from M3); `@noble/ciphers` to seal catalog events | Proposed |
| Remote | The system's OpenSSH | Decided |
| Secrets | macOS `security` CLI for Keychain; `op` CLI for 1Password | Decided |
| Prompts | `@clack/prompts`, only for `plainport init` in an interactive terminal | Proposed |
| Tests | `bun test`, fast-check, MinIO and SFTP containers | Proposed |
| TUI (M6) | Ink by default; re-check OpenTUI at M6, whose README still says it is not production-ready | Decide at M6 |

## Next: milestone M1, local core

Scope: core, journal and recover; restic engine; Node plugin; external-SSD store. CLI: `init`, roots, `offload`, `onload`, `status`, `ls`, with `--dry-run`, the `--json` envelope, exit codes and risk classes.

Gate: the crash matrix is green, and round trips are byte-identical on your own projects.

Suggested order:

1. **Scaffold.** A Bun workspace with only the packages M1 needs (`core`, `cli`, `engine-restic`, `blob-fs`, `eco-node`, `host-macos`), the four scripts from `AGENTS.md`, and macOS CI.
2. **Contract first.** The command registry, risk classes, `--json` envelope and exit codes, with generated `plainport.json` and tests that pin them.
3. **Config and roots.** `config.toml` plus `managed.toml` with the merge rules and write lock; `init`, `root add | bind | list | scan`.
4. **Engine.** The single process runner, then restic: spawn, JSON-lines parsing, exit-code mapping, and a pinned binary for development.
5. **Offload.** The eight-phase saga with its journal, against an external-SSD store; stub file and trash release.
6. **Onload.** Restore, verify, swap, toolchain and hydrate with the Node plugin (pnpm, npm, Yarn, Bun detection).
7. **Status, ls, recover**, then the crash matrix (kill at each journal step) and byte-identical round trips on real projects.

Out of scope for M1: remote stores, devices and moves, agent adapters, the kit, timers and the TUI.

## Loose ends from the conversation

- **plainkeep `archive` gap.** It deletes the working tree after `git bundle` without checking for uncommitted, untracked or ignored files. Fix it in the plainkeep repository; see Prior art in `DESIGN.md`.
- **Stack section.** Add one to `DESIGN.md` once M1 confirms the proposed choices above.

## First prompt for the coding agent

> Read AGENTS.md, docs/HANDOFF.md, docs/ROADMAP.md and docs/adr/README.md. Then run
> `/orchestrate docs/plans/M1-local-core.md strategy=staged review=dual` on branch `m1-local-core`, once the owner has approved the M1 plan.
