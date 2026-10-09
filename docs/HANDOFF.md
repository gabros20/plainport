# plainport: handoff

4 October 2026

plainport was designed in a claude.ai conversation between 29 September and 2 October 2026, and milestone M1 was built on 3 and 4 October 2026 with `/orchestrate`. This file says where the project stands, so any coding agent can pick up from here.

## Where things stand

- **M1 (local core) closed on 4 October 2026, released as v0.1.0 on 9 October 2026; use v0.1.1 (10 October), which fixes `scripts/install`'s Ctrl-C handling.** The v0.1.0 tag's CI run stayed red on test-only issues (a VERSION-dependent install test and Linux timing races in test helpers), fixed after the tag; v0.1.1's CI is green. plainport offloads a project to a local store and onloads it back on one Mac:
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
- **The delete guard has limits (D87).** All of them need a process acting on purpose, or a layout nobody builds by accident:
  - The guard's walk and the delete are two separate walks. A store, mount or working copy moved into a trash between them is deleted; Node has no `openat`-style descent to close the gap.
  - A same-device bind mount on Linux is invisible to the device check. Plainport's own stores and restic repositories are still caught by their markers. M3 brings Linux hosts, and `/proc/self/mountinfo` with them.
  - The guard protects plainport stores and restic repositories only. Anything else parked in a stripped folder (a borg repository, a bare git repo, a database under `node_modules/`) is not in the snapshot and goes with the trash, by the contract that stripped means regenerable.
  - If neither the stub nor `registry.roots` holds a root's id, `--snapshot S` under an uncertain head keeps asking for `--snapshot S`. It needs a damaged registry on top of a damaged catalog; nothing is deleted.
- **A doubtful catalog is detected only from local evidence (D86).** Onload checks the stub's and the registry's snapshot against the readable events. With neither, a skipped newer event shows only as a `catalog.event-skipped` warning and onload restores the older head. A second device hits this by construction, so M2 should treat any skipped event newer than the head as doubt.
- **`init --store-path` can re-point an unreachable pinned name.** If the new path cannot be reached, the name is re-pointed before the identity can be checked. D45 then refuses every use of the wrong disk, so nothing is lost, but D85's "before anything is written" bends. It also allows the legitimate D68 flow of re-pointing an unplugged disk. M2 decides whether to tighten it.
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
- **D86:** a skipped state-changing event makes onload refuse (`catalog.head-uncertain`); `--snapshot S` is the way on.
- **D87:** one guarded deleter checks every recursive delete (`delete.guard-refused`); the detached delete's refusal is a note beside the trash, and offload reports `deleteStarted`.
- **D88:** `recover` rolls back a restore-mode onload interrupted at its start.

ADR-0005 (libraries) was marked "confirm in M1". The Stack section in `DESIGN.md` records what M1 confirmed; accept it when you review.

## How the release was reviewed

Three final whole-branch rounds ran after the last task. Rounds 1 and 2 used Fable and Codex gpt-6-astra, a cross-family pair; astra's round 1 is where D83 to D86 came from, and round 2 led to D87 and D88. Round 3, on the D87 and D88 fixes, was Fable alone, standing in because Codex's weekly quota ran out until 2026-10-09. Round 3 found no Critical issue; its contrived findings are in the known limits above. An astra pass over the final tree was not possible before the tag, so a Codex review of the guard (D87) once the quota returns would be a cheap second opinion.

## Next: milestone M2, remote stores

Scope, from `docs/ROADMAP.md`: SFTP and S3 stores through the rclone blob store; catalog events over stores; Keychain secrets; leases, head check, conflicts and `plainport resolve`. Gate: the two-Mac race ends in `conflicted`, never in lost work.

M2 starts with:

1. **The M2 plan file.** Write `docs/plans/M2-remote-stores.md` from the outline in `ROADMAP.md` and get it approved (ADR-0019). Branch `m2-remote-stores`.
2. **Test environments as code.** `compose.yaml` (MinIO pinned by digest, `atmoz/sftp`, `rest-server --append-only`, Toxiproxy), `scripts/testenv up|down`, R2 and B2 test buckets with scoped keys referenced as `op://`, and the Linux CI job running the containers.
3. **The rclone blob store and the store contract suite**, including create-if-absent. D50 needs a conditional write for the root claim on stores without it; retest rclone's `If-None-Match` on the pinned version first.
4. **Carried from M1:** `onload --dry-run` (D71, a real agent need from the live eval); the D69 scan items due in M2 (tags not on any remote, nested repositories in the plan); `init` folder sizes (D70); a per-call deadline for host file-system calls on network mounts (D32); the two-device lease view.
5. **Before that:** the owner-run real-project gate (D78) and the ADR-0022 review.

Out of scope until later: devices and moves (M3), agent adapters and the kit (M4), the TUI (M6).

## Carried into M2

Open minors from the M1 reviews that are worth tracking. Each was checked against the code or `git log` on 2026-10-10; items fixed in the release waves are left out, and so is anything under Known limits. No contract or install items remain open.

**Core safety**

- **Orphan trash claim.** A kill between the journal's removal and the claim's removal (D67) leaves an `<op>.claim` with no trash folder, and nothing sweeps it. `gc` should remove claims whose trash is gone and whose claimer is dead.
- **Trash claim boot window (N13).** `trash-claim.ts` treats a 120 s difference as the same boot, so a clock step after boot can make a live claim read as an earlier boot's and let a second deleter run. The worst case is a second delete of already-committed trash. The fix needs a boot-session id in the host port and a claim schema change.
- **`rootMode` under an uncertain head.** `onload --snapshot S` cannot restore the folder's recorded mode when the event that holds it is the unreadable one (D86).
- **Package managers may download themselves.** Hydration inherits the user's environment, so with Corepack a version check or install can fetch the package manager (network and disk). Set a Corepack download policy for installs.

**Gate and eval**

- **Gate coverage.** `scripts/gate-m1.ts` compares type, mode, content hash and link target, not hard-link identity, xattrs, ACLs or flags. It accepts onload exit 10 as well as 0, with a later state check as the backstop. Its raw `--out` JSON is not attached to the release notes. Peak RSS is the larger of plainport's tree and restic.
- **Eval scoring.** `passed` in `evals/agent-smoke/scorer.ts` requires zero contract issues, which is stricter than the four objective checks. Split it into `passed` (objective) and `clean` (no confusion), and record the split as a decision.

**Tests and flake watch**

- **T1 under load:** the cli onload round trip waits on a slow detached delete, and the crash-matrix "restic committed" row timed out once. Both passed alone and in the final full run.
- **T1 under load:** the recover D64 `offload.release.detached` test failed once and passed 3 of 3 on rerun.
- **`recover.test.ts` in the Linux container:** one unexplained failure in 80 runs (the first run, log not kept). The 40 logged runs at 674cc4a were green.
- **A reproducible Linux test recipe.** A local `oven/bun` container run showed 32 runner and scan failures that the GitHub Ubuntu runner does not. The container needs `docker --init` (zombie reaping) and has no git fsmonitor daemon, which accounts for 17 of them. Put the recipe in `scripts/testenv` with the M2 test environments.
- **Temp folder leak.** The suite leaves `plainport-example-*` folders in `$TMPDIR` (`packages/cli/src/testing.ts`).

**UX**

- **Git background maintenance** creating or removing lock files during an offload changes the fingerprint. The offload retries once, then refuses (fail closed, nothing lost). Exclude `.git/*.lock` from the fingerprint, or stop maintenance the way D52 stops fsmonitor.
- **Non-git projects.** The offload plan lists no gitignored files; add a human line, "not a git repository: every file travels except stripped dependency folders".

## Loose ends

- **plainkeep `archive` gap.** It deletes the working tree after `git bundle` without checking for uncommitted, untracked or ignored files. Fix it in the plainkeep repository; see Prior art in `DESIGN.md`.
- **The Mac mini** was offline in Tailscale on 2 October 2026, so `ssh mini` is configured but untested. M3 needs it.

## First prompt for the coding agent

> Read AGENTS.md, docs/HANDOFF.md, docs/ROADMAP.md and docs/adr/README.md. Then write the M2 plan (`docs/plans/M2-remote-stores.md`) and ask the owner to approve it before running `/orchestrate` on branch `m2-remote-stores`.
