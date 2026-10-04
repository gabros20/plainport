# plainport: handoff

4 October 2026

plainport was designed in a claude.ai conversation between 29 September and 2 October 2026, and milestone M1 was built on 3 and 4 October 2026 with `/orchestrate`. This file says where the project stands, so any coding agent can pick up from here.

## Where things stand

- **M1 (local core) closed on 4 October 2026, release v0.1.0.** plainport offloads a project to a local store and onloads it back on one Mac:
  - `offload`: plan, preflight, scan, restic snapshot, verify, then release into a trash that a detached delete or `gc` clears;
  - `onload`: restore into staging, verify, swap into place, then a frozen install through the Node plugin (npm, pnpm, Yarn Classic and Berry, Bun);
  - `recover` finishes or rolls back any interrupted operation from its journal;
  - `status`, `ls`, `root add | bind | list | scan`, `hydrate`, `dehydrate`, `restore --to` and `gc`.
- **The contract is public.** Every command is in the registry with its risk class. `plainport.json`, the JSON Schemas and the completions are generated from it. The `--json` envelope, exit codes 0 to 11 and the finding codes are the public contract; `docs/machine-contract.md` documents them.
- **Design:** `docs/DESIGN.md` is the source of truth and now has a Stack section. The claude.ai doc stays as the archive: https://claude.ai/artifact/3qMK5CKtGksjZZwSVnb6iu
- **Decisions:** the 26 design decisions are in `DESIGN.md`. The decisions the M1 run added (D-numbers, cited all over the code and docs) are defined in [ADR-0022](adr/0022-run-decisions-in-m1.md).
- **Install:** `scripts/install` installs a read-only `~/.local/share/plainport/versions/<version>/` behind `current`, with `~/.local/bin/plainport` pointing through it and `--rollback` to the previous version (ADR-0020). An installed build finds restic and rclone only beside itself.

## Gate results

The M1 gate has two parts, and both passed.

**The crash matrix** kills both sagas at every journal step and after every side effect, runs `recover` and checks the six invariants. The in-process variant runs in T0 (`bun test`); the SIGKILL subprocess variant runs in T1 (`bun run test:t1`) and, on macOS, uses a case-sensitive APFS disk image. Typecheck, lint, the contract check and gitleaks were green with it.

**The round trips.** `bun scripts/gate-m1.ts` offloaded and onloaded five public demo projects at pinned commits (D11). Each came back byte-identical (type, mode, content hash and link target, `.git` included) apart from the stripped `node_modules` and `.next`. The unpushed commit, the stash, the index, the edit and the untracked file all came back, `git fsck` passed and no file's mtime changed. To each clone the gate first added a `.env`, an uncommitted edit, a staged file, an untracked file, a stash and an unpushed commit.

| Project (package manager) | Files | Size | Offload | Onload |
| --- | --- | --- | --- | --- |
| nextjs/saas-starter@6e33e58 (pnpm) | 178 | 0.4 MB | 2.79 s | 2.46 s |
| t3-oss/create-t3-turbo@8f945b7 (pnpm and turbo) | 186 | 1.3 MB | 2.89 s | 2.46 s |
| Skolaczk/next-starter@5de3b14 (npm) | 198 | 0.7 MB | 2.90 s | 2.35 s |
| planetscale/nextjs-planetscale-starter@4216f41 (Yarn Classic) | 144 | 0.6 MB | 2.82 s | 2.48 s |
| rajput-hemant/nextjs-template@ff5a6d0 (Bun) | 120 | 0.5 MB | 2.75 s | 2.35 s |

restic peaked at 160 MB or less. These trees are small and nothing was installed, so the times are mostly fixed overhead (four restic calls each way), not throughput on a large project. M5 enforces budgets against this baseline.

**What the gate did not use.** D78: the gate ran on public demo projects with no installs (D11, D13), not on the owner's own projects. The disk allowed no `node_modules` for them, so hydration is proven only on tiny fixtures. Before M2, run the gate once on a real project with hydration on, which is cheap evidence for the "fast return" goal that D13 left unproven. It is suggested, not required.

## Known limits

- **One device.** M1 has no pairing. A lease held on another device shows as `shelved` here until M2's lease work.
- **macOS host only.** Linux hosts arrive with M3. **Local stores only** (a folder or an external disk); SFTP and S3 arrive with M2 and M3.
- **The fingerprint is metadata** (mtime, ctime, size, mode, link target), not a content hash. A change that keeps all of those goes unseen.
- **Manifest verification compares entries and sizes.** File content is left to restic's own authentication, until `--verify full` in M5.
- **`lsof` sees only the current user's processes.** `proc.cwd-shell` is a warning, so an agent that runs `plainport offload .` from inside the project keeps a working directory that is then deleted, as DESIGN intends.
- **Docker and nested repositories (D69).** Docker checks use the current context and `Type=bind` mounts only. Unpushed detection counts `HEAD` and branches, not tags. Nested repositories are not listed in the plan.
- **Hydration runs package scripts (D54, D79).** A project's own `hydrate.command` and hooks never run in M1. `--ignore-scripts` waits for `plainport trust`.
- **No resident process.** Trash older than its deadline is deleted by the next write command or `gc`, not by a timer.
- **The catalog format is frozen at v0.1.0 (D74).** Dev builds before d131f2a do not read stores written by newer builds.
- **Hydration is proven on tiny fixtures only** (D13), and an install keeps only the current and previous versions.

## For the owner to review

The controller made these calls under your delegation of format and API decisions (2026-10-04), or flagged them for review. Each is defined in [ADR-0022](adr/0022-run-decisions-in-m1.md). After v0.1.0 changing a persisted format or the public contract needs you.

- **D12:** NDJSON finding lines are nested, `{type, op, finding}`.
- **D26:** restic tag values are percent-encoded (`%2C`, `%25`); a persisted format.
- **D68:** a config may change a managed store's `kind` only if it reaches the same store identity.
- **D69:** the scan limits above are accepted for M1 and scheduled for M2 and M5.
- **D70:** `init` shows folder sizes from a two-second-budget walk; built with M2's setup work.
- **D72, D75:** empty holders are removed by `rmdir`; offload reports `localCopy` as `deleted`, `kept` or `waiting`.
- **D73, D74:** `stats.stripped` and `rootMode` on the catalog event; schema `v: 1` frozen at the tag.
- **D76:** new finding `project.unregistered` (exit 4).
- **D77:** offload's `trash` key is optional; the dry run omits `arrival` when nothing was stripped.
- **D78:** the gate on public demo projects without installs.
- **D79:** the install environment drops store and tool secrets.
- **D80:** the run decisions live in ADR-0022.
- **D81:** Ctrl-C under `--json` with no saga running prints an `operation.cancelled` envelope.
- **D82:** the known limits above.
- **D83:** a project and a local store may not overlap (`store.inside-project`).
- **D84:** `.plainport-*` holders are never a project destination, and `gc` never deletes inside a registered project.
- **D85:** `init` enforces the store identity pin.
- **D86:** a skipped state-changing event makes onload refuse (`catalog.head-uncertain`).

ADR-0005 (libraries) was marked "confirm in M1". The Stack section in `DESIGN.md` records what M1 confirmed; accept it when you review.

## Next: milestone M2, remote stores

Scope, from `docs/ROADMAP.md`: SFTP and S3 stores through the rclone blob store; catalog events over stores; Keychain secrets; leases, head check, conflicts and `plainport resolve`. Gate: the two-Mac race ends in `conflicted`, never in lost work.

M2 starts with:

1. **The M2 plan file.** Write `docs/plans/M2-remote-stores.md` from the outline in `ROADMAP.md` and get it approved (ADR-0019). Branch `m2-remote-stores`.
2. **Test environments as code.** `compose.yaml` (MinIO pinned by digest, `atmoz/sftp`, `rest-server --append-only`, Toxiproxy), `scripts/testenv up|down`, R2 and B2 test buckets with scoped keys referenced as `op://`, and the Linux CI job running the containers.
3. **The rclone blob store and the store contract suite**, including create-if-absent. D50 needs a conditional write for the root claim on stores without it; retest rclone's `If-None-Match` on the pinned version first.
4. **Carried from M1:** `onload --dry-run` (D71, a real agent need from the live eval); the D69 scan items due in M2 (tags not on any remote, nested repositories in the plan); `init` folder sizes (D70); a per-call deadline for host file-system calls on network mounts (D32); the two-device lease view.
5. **Before that:** the owner-run real-project gate (D78) and the ADR-0022 review.

Out of scope until later: devices and moves (M3), agent adapters and the kit (M4), the TUI (M6).

## Loose ends

- **plainkeep `archive` gap.** It deletes the working tree after `git bundle` without checking for uncommitted, untracked or ignored files. Fix it in the plainkeep repository; see Prior art in `DESIGN.md`.
- **The Mac mini** was offline in Tailscale on 2 October 2026, so `ssh mini` is configured but untested. M3 needs it.

## First prompt for the coding agent

> Read AGENTS.md, docs/HANDOFF.md, docs/ROADMAP.md and docs/adr/README.md. Then write the M2 plan (`docs/plans/M2-remote-stores.md`) and ask the owner to approve it before running `/orchestrate` on branch `m2-remote-stores`.
