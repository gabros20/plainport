# M1 · Local core: orchestrate plan

Status: **draft, awaiting owner approval** (M0 gate). Run on branch `m1-local-core`:

```text
/orchestrate docs/plans/M1-local-core.md strategy=staged review=dual
```

**Milestone gate.** The crash matrix is green, and offload → onload round trips are byte-identical (minus stripped
paths) on copies of the owner's real projects.

**Every task, every time.**

- Read `AGENTS.md` and the ADRs and `docs/DESIGN.md` sections the task names before writing anything.
- Test-first (ADR-0017): write the failing tests that state the acceptance, run them, see them fail, then
  implement. Report the red run and the green run.
- Never touch the real home folder, real stores or agent folders. Tests use temp dirs and a sandboxed `HOME`.
- Commit by path (`git add <your files>`), one or more small commits per task, message `m1(task N): …`.
- If the design is wrong or silent on something that matters, stop with `DESIGN_CONFLICT`; don't patch around it.
- Write the report to `.orchestrate/reports/task-N.md`: status, commits, tests added, red and green evidence,
  decisions made, open questions.

**Dependency graph.** 1 → 2 → 3 → 4 → {5, 7} · 5 → 6 · 7 → 8 → 9 → 10 · 3 → 11 · {6, 8, 10, 11} → 12 → 13 → 14 →
15 → 16. Tasks 5 and 7, and tasks 9 and 11, are `parallel-safe` with each other.

---

## Task 1 — Scaffold the Bun workspace

### Objective
A Bun workspace that installs, type-checks, tests and compiles an empty `plainport` binary on macOS.

### Context
ADR-0004, ADR-0005, ADR-0019; `docs/DESIGN.md` "Core API → Package layout"; `AGENTS.md` "Commands".

### Scope
Owns: root `package.json`, `bunfig.toml`, `tsconfig.json`, `packages/{core,contract,cli,engine-restic,blob-fs,eco-node,host-macos}/`
(each with `package.json`, `src/index.ts`, one smoke test), `.github/workflows/ci.yml`, `README.md` (short).

- Scripts, names fixed by AGENTS.md: `bun install`, `bun test`, `bun run build` (compiles
  `packages/cli/src/main.ts` to `dist/plainport`), `bun run contract` (a stub until Task 4). Add `typecheck`
  and `check:bun`; `check:bun` refuses Bun older than 1.2.21 with the reason, ported from
  `plainkeep/cli/package.json` (ADR-0003, with a provenance comment).
- Strict TypeScript, ESM, workspace protocol references between packages. No runtime dependencies yet except
  `zod`.
- CI: macOS runner, `bun install --frozen-lockfile`, `typecheck`, `test`, `build`, and `dist/plainport --version`.
- Fix `DESIGN.md` "Package layout" from "pnpm workspace" to "Bun workspace" (ADR-0004 records the decision).

### Tests first
`packages/cli` test: the compiled binary prints `plainport <version>` and exits 0. One smoke test per package
importing its index.

### Verification
`bun install && bun run typecheck && bun test && bun run build && ./dist/plainport --version`

### Report
`.orchestrate/reports/task-1.md`

### Stop condition
All verification commands pass locally; CI workflow file is valid (`actionlint` if available, otherwise say so).

---

## Task 2 — Pin restic and rclone for development and tests

### Objective
Reproducible, checksum-verified restic and rclone binaries for every target, fetched by one script.

### Context
ADR-0006 (restic 0.17.1 or later); `docs/DESIGN.md` "Storage: engine and metadata".

### Scope
Owns: `tools.lock.json` (version, URL and SHA-256 per tool and per `darwin-arm64`, `darwin-x64`, `linux-x64`,
`linux-arm64`), `scripts/fetch-tools.ts` (downloads into `.tools/<os>-<arch>/`, verifies SHA-256, refuses on
mismatch), `.gitignore` entry for `.tools/`, a `toolPath(name)` resolver in `packages/core` that prefers
`$PLAINPORT_TOOLS_DIR`, then the binary's own directory, then `.tools/`. Use the latest stable restic and rclone
releases, checksums taken from the projects' official release checksum files.

### Tests first
Checksum mismatch refuses and leaves no file behind; resolver order; `restic version` and `rclone version` run
from `.tools/` and report the pinned versions.

### Verification
`bun scripts/fetch-tools.ts && bun test packages/core -t tools`

### Report
`.orchestrate/reports/task-2.md`

### Stop condition
Both binaries fetched and verified for the host platform; lock file covers all four targets.

---

## Task 3 — The contract package

### Objective
`packages/contract` holds the public contract types: exit codes, the `--json` envelope, risk classes, findings,
events, and the `Result` value type, all as Zod schemas.

### Context
ADR-0003, ADR-0007; `docs/DESIGN.md` "CLI design" (exit codes, `--json`), "Core API" (`Finding`,
`PlainportEvent`, `OperationResult`); plainkeep `docs/machine-contract.md` §1–3 and §6 and
`cli/src/core/guardrail.ts` (copy what fits, add provenance comments; never import from plainkeep).

### Scope
Owns `packages/contract/`. Also creates `docs/machine-contract.md` for plainport: envelope, NDJSON event lines,
exit-code table 0–11 and 130, `--dry-run` contract, risk classes, stability policy.

### Tests first
Frozen exit-code table (a snapshot test that fails on any change); envelope success, error and multi-line
shapes validate; `error.code` equals the exit code; every finding has a stable dotted code and an `allowable`
flag; `Result` never throws for expected failures.

### Verification
`bun test packages/contract && bun run typecheck`

### Report
`.orchestrate/reports/task-3.md`

### Stop condition
Contract schemas exported, JSON Schema export function in place, `docs/machine-contract.md` written.

---

## Task 4 — Command registry, risk gate and generated contract

### Objective
Every command is defined once; help, completions and `plainport.json` are generated from the registry, and the
risk gate behaves exactly as ADR-0007 says.

### Context
ADR-0005, ADR-0007; AGENTS.md rules 3 and 4; `docs/DESIGN.md` "CLI design" (global flags, project arguments).

### Scope
Owns `packages/cli/src/{registry,gate,render,main}.ts` and `plainport.json`, `schemas/*.json`.

- Registry entry: name, summary, argument Zod schema, output Zod schema, risk class, `dryRun` support, handler.
- `node:util` `parseArgs`; global flags `--json`, `--yes`, `--no-input`, `--dry-run`, `--store`, `--config`,
  `--quiet`, `--verbose`; no TTY implies `--no-input`.
- Gate: `confirm` without `--yes` or `--plan` exits 3 and prints the exact re-run; an unregistered command exits 4
  with a did-you-mean; `--dry-run` runs as `read`.
- Renderers: human text to stdout and logs to stderr; `--json` NDJSON with exactly one final envelope.
- `bun run contract` writes `plainport.json` and JSON Schemas; completions for zsh and bash.
- Register `version` and `help` only; later tasks add commands.

### Tests first
Gate exit codes and the exact re-run text; one-final-envelope rule; contract round trip: every registered
command's `--json` output validates against its declared schema; `bun run contract` is idempotent.

### Verification
`bun test packages/cli && bun run contract && git diff --exit-code plainport.json schemas/`

### Report
`.orchestrate/reports/task-4.md`

### Stop condition
Gate, renderers and generation work, and CI fails if `plainport.json` is stale.

---

## Task 5 — Config, paths and device identity  `parallel-safe with Task 7`

### Objective
Load, merge and safely write configuration; create this device's identity.

### Context
`docs/DESIGN.md` "Configuration" and "Catalog and data model → Local state per machine"; ADR-0005.

### Scope
Owns `packages/core/src/config/`, `packages/core/src/paths.ts`, `packages/core/src/device.ts`.
XDG paths with `HOME` overrides; `config.toml` (read only) and `managed.toml` (written with
`managed.toml.lock` plus temp-file-and-rename); precedence flags → env → project `.plainport.toml` →
`config.toml` → `managed.toml` → defaults; tables merge by key, arrays replace; last-good config on parse
failure with a finding; `device.json` with ULID and role.

### Tests first
Precedence table; merge rules; concurrent writers serialize through the lock; a crash between temp write and
rename leaves the old file intact; a broken `config.toml` keeps the last good config and reports it; `config.toml`
is never rewritten.

### Verification
`bun test packages/core -t config`

### Report
`.orchestrate/reports/task-5.md`

### Stop condition
All config tests green in a sandboxed `HOME`.

---

## Task 6 — Roots, project boundaries and `init`

### Objective
`plainport init`, `root add | bind | list | scan` and the project registry.

### Context
ADR-0010; `docs/DESIGN.md` "Roots" (landing rules, setting roots up, project boundaries) and the edge-case table
"Roots and landing paths".

### Scope
Owns `packages/core/src/roots/`, `packages/core/src/registry.ts`, the `init` and `root` commands in the registry.
Overlap and real-path checks (`root.overlap`), project boundary detection, `registry.json`, project address
resolution (address, unique suffix, path, `.`, stub), ambiguous name exits 2 with candidates. `init` works fully
from flags (`--root work=~/work --store <path>`); the interactive scan uses `@clack/prompts` only with a TTY.

### Tests first
Overlapping and symlinked roots rejected; boundary detection on nested repos and grouping folders; every
address form resolves; ambiguous suffix exits 2; `init` without a TTY never prompts.

### Verification
`bun test packages/core -t roots && bun test packages/cli -t init && bun run contract`

### Report
`.orchestrate/reports/task-6.md`

### Stop condition
Commands registered with risk classes, contract regenerated, tests green.

---

## Task 7 — The process runner and host port  `parallel-safe with Task 5`

### Objective
One process runner for every child process, and the host port with a fault-injection seam.

### Context
AGENTS.md rules 5 and 6; `docs/DESIGN.md` "Core API → Design rules"; ADR-0017 (fault injection is part of the
port from M1).

### Scope
Owns `packages/core/src/runner/`, `packages/core/src/ports/host.ts`, `packages/host-macos/` (fs, clock, process
spawning through the runner). Each child runs in its own process group; output goes to a bounded ring buffer and
streams as `log` events; idle deadline and overall deadline; `AbortSignal` cancels the whole group (TERM, then
KILL). The host port exposes `faultAt(step)` used by the crash matrix.

### Tests first
A child that ignores SIGTERM is killed; grandchildren die with the group; output flood stays bounded; idle
deadline fires on silence; overall deadline fires on slow output; abort mid-run leaves no process behind.

### Verification
`bun test packages/core -t runner && bun test packages/host-macos`

### Report
`.orchestrate/reports/task-7.md`

### Stop condition
No leftover processes after the suite (`pgrep` check in the test teardown).

---

## Task 8 — The restic engine

### Objective
`engine-restic` implements the `Engine` port over the pinned restic binary.

### Context
ADR-0006; `docs/DESIGN.md` "Plugin interfaces → Engine", "Offload process" step 6, restic scripting docs.

### Scope
Owns `packages/engine-restic/`. `init`, `snapshot` (`backup --json` with excludes, `--parent`, tags),
`list`, `entries` (`ls --json`), `restore` (with `--overwrite` modes), `check`; JSON-lines parsing into progress
events; exit-code mapping (0 ok, 1 fatal, 3 unreadable files is a hard failure, 10 repo missing, 11 lock, 12
wrong password, 130 interrupted). All runs go through the Task 7 runner. Recorded JSON-lines fixtures per restic
version under `fixtures/restic/<version>/`.

### Tests first
Parsing against recorded fixtures; exit 3 maps to failure, never partial success; real-binary tests (T1) on a temp
repository: init, backup, ls, restore, byte-identical tree.

### Verification
`bun test packages/engine-restic`

### Report
`.orchestrate/reports/task-8.md`

### Stop condition
Fixture and real-binary suites green with the pinned restic.

---

## Task 9 — Scan, git facts and preflight  `parallel-safe with Task 11`

### Objective
One tree walk produces the manifest, the git facts and the fingerprint; preflight produces findings.

### Context
`docs/DESIGN.md` "Offload process" steps 2–3, edge-case tables "Git state", "Files and file systems", "macOS and
the environment".

### Scope
Owns `packages/core/src/scan/`, `packages/core/src/preflight/`, macOS checks in `packages/host-macos/` (`lsof` open
files and cwd, dataless flag, docker bind mounts). Manifest entries: path, type, size, mode, mtime, link target.
Git facts: dirty, untracked, unpushed, stashes, local-only branches, in-progress operations, worktrees. Findings
with stable codes: `git.locked`, `git.worktrees`, `git.is-worktree`, `git.unpushed`, `git.in-progress`,
`fs.unreadable`, `fs.dataless`, `fs.link-outside`, `proc.open-files`, `proc.cwd`, `env.docker-mount`.

### Tests first
A fixture repo per finding; sockets and FIFOs skipped and listed; fingerprint stable across runs and changed by
an edit.

### Verification
`bun test packages/core -t "scan|preflight" && bun test packages/host-macos`

### Report
`.orchestrate/reports/task-9.md`

### Stop condition
Every listed finding has a fixture test.

---

## Task 10 — Node plugin, strip set and the planner

### Objective
`eco-node` proposes strip candidates and hydration; the planner builds the `Plan` that `--dry-run` prints.

### Context
`docs/DESIGN.md` "Offload process" steps 4–5, "Plugin interfaces → EcosystemPlugin", "Node plugin: package
manager detection", edge-case table "Dependencies and hydration"; the human plan output under "CLI design".

### Scope
Owns `packages/eco-node/`, `packages/core/src/plan/`. Package-manager detection table plus the `packageManager`
override; strip candidates; the core drops anything git tracks and applies `strip.keep` and `strip.never`;
`Plan` with include totals, strip entries with reasons, ten largest paths, findings, estimate, `expiresAt`;
approved plans saved under `plans/` and expiring after one hour; `offload --dry-run` renders the plan.

### Tests first
Golden plans for npm, pnpm, Yarn Classic, Yarn Berry (zero-install cache tracked, so kept), Bun and a monorepo; a
tracked `build/` is never stripped; plan expiry; `--dry-run` is `read`.

### Verification
`bun test packages/eco-node && bun test packages/core -t plan && bun run contract`

### Report
`.orchestrate/reports/task-10.md`

### Stop condition
Golden plans green; `offload --dry-run --json` validates against its schema.

---

## Task 11 — `blob-fs` store, catalog events and the fold  `parallel-safe with Task 9`

### Objective
Catalog events on a local-disk store and the pure fold that turns them into project state.

### Context
ADR-0009; `docs/DESIGN.md` "Catalog and data model", "Plugin interfaces → BlobStore", store layout under
"Storage".

### Scope
Owns `packages/blob-fs/`, `packages/core/src/catalog/`. `BlobStore` over `node:fs` with exclusive create and
atomic rename; event schemas (`registered`, `offloaded`, `onloaded`, `checkpointed`, `root-created`,
`root-bound`); fold rules (status by `base` chain, head, lease, conflict); `state.json` cache rebuildable from
events; event mirror under `~/.cache/plainport/`.

### Tests first
fast-check: folding any permutation gives the same state (invariant 4); two `offloaded` with the same `base` give
`conflicted`; at most one lease per project (invariant 5); create-only refuses an existing key.

### Verification
`bun test packages/blob-fs && bun test packages/core -t catalog`

### Report
`.orchestrate/reports/task-11.md`

### Stop condition
Property tests run at least 1,000 cases each and pass.

---

## Task 12 — The offload saga

### Objective
`plainport offload` runs the eight phases with a journal at every boundary and deletes nothing before a verified
commit.

### Context
ADR-0008; `docs/DESIGN.md` "Offload process", "Project lifecycle", "Catalog → The stub", "Testing → invariants".

### Scope
Owns `packages/core/src/saga/offload.ts`, `packages/core/src/journal/`, `packages/core/src/lock.ts`, the
`offload` command. Per-project lock (dead holder broken; held lock exits 11); fingerprint re-check; snapshot via
the engine with tags; manifest verification and re-stat (exit 7 on mismatch); head check; `offloaded` event;
release: rename into `<root>/.plainport-trash/`, write the `.plainport` stub, delete trash from a detached
process; `keepLocalFor`; findings block with exit 6 and `--allow <code>` overrides allowable ones.

### Tests first
Happy path against a temp external-SSD store; edit during upload retries once then fails with nothing deleted;
unreadable file fails the snapshot; stub contents match the schema; journal written at every boundary.

### Verification
`bun test packages/core -t offload`

### Report
`.orchestrate/reports/task-12.md`

### Stop condition
Offload of fixture projects green; invariants 1–3 asserted after each test.

---

## Task 13 — The onload saga and hydration

### Objective
`plainport onload` restores into staging, verifies, swaps, then hydrates; `plainport hydrate` retries.

### Context
ADR-0008; `docs/DESIGN.md` "Onload process", "Node plugin", edge-case tables "Dependencies and hydration" and
"Concurrency and interruption".

### Scope
Owns `packages/core/src/saga/onload.ts`, the `onload`, `hydrate` and `dehydrate` commands, `eco-node` hydrate and
toolchain. Resolve by name, stub or `--snapshot`; preflight (target free or `--to`, free space plus 10%, case
collisions on case-insensitive volumes); restore into `<root>/.plainport-staging/<op>/`; verify against the
snapshot listing; rename swap, remove stub, `onloaded` event; toolchain detection (mise, fnm, Volta or a
warning); frozen install; failure gives `restored-unhydrated` and exit 10; the same head after a fresh offload
renames the trash folder back.

### Tests first
Round trip byte-identical minus stripped paths; occupied target refuses; case-collision blocks on a
case-insensitive `hdiutil` image; failed install leaves files and exits 10; `hydrate` then succeeds offline
against a local registry fixture (or a recorded cache).

### Verification
`bun test packages/core -t onload && bun test packages/eco-node -t hydrate`

### Report
`.orchestrate/reports/task-13.md`

### Stop condition
Round-trip tests green for every package manager in the Task 10 golden set.

---

## Task 14 — `status`, `ls`, `recover` and trash `gc`

### Objective
The read commands and the journal replay.

### Context
ADR-0008; `docs/DESIGN.md` "CLI design" (`ls`, `status`, `recover`, `gc`), "Edge cases → Concurrency and
interruption".

### Scope
Owns the `status`, `ls`, `recover` and `gc` commands and `packages/core/src/recover/`. Replay rules: before the
commit roll back (remove staging, keep the folder), after the commit finish (release); housekeeping at the start
of any command; `unavailable` for unmounted roots.

### Tests first
For each journal phase, a hand-made journal file resolves to the right stable state; `ls --json` and
`status --json` validate against their schemas.

### Verification
`bun test packages/core -t recover && bun test packages/cli -t "status|ls" && bun run contract`

### Report
`.orchestrate/reports/task-14.md`

### Stop condition
Every phase of both sagas has a replay test.

---

## Task 15 — The crash matrix

### Objective
Kill the process at every journal step of both sagas, run `recover`, and check all six invariants.

### Context
ADR-0017; `docs/DESIGN.md` "Testing and fault injection" (invariants, crash matrix row).

### Scope
Owns `tests/crash-matrix/`, `tests/support/invariants.ts`. Two variants: in-process fault injection through
`faultAt(step)`, and a subprocess variant that runs the compiled binary and sends `SIGKILL` when the journal
reaches the step. Fixture projects include `.env`, untracked files, a stash, unpushed commits, symlinks, exec
bits, and a case-sensitive APFS image.

### Tests first
The matrix is the test: enumerate steps from the saga definitions so a new phase adds rows automatically.

### Verification
`bun test tests/crash-matrix`

### Report
`.orchestrate/reports/task-15.md`

### Stop condition
Every row green in both variants; the report lists the row count.

---

## Task 16 — Gate: round trips on real projects

### Objective
Prove the gate on copies of the owner's real projects without risking the originals.

### Context
`docs/ROADMAP.md` M1 gate; ADR-0017.

### Scope
Owns `scripts/gate-m1.ts` and the gate report. The owner names three to five projects of different shapes.
The script clones each with `cp -c` into a temp root, runs offload then onload against a temp store, and compares
tree hashes minus stripped paths. It never touches the originals.

### Tests first
Not applicable: this task runs the gate. The script itself is tested on a fixture project.

### Verification
`bun scripts/gate-m1.ts --projects <owner's list>` and `bun test` (full suite).

### Report
`.orchestrate/reports/task-16.md` plus an M1 summary for `docs/HANDOFF.md`.

### Stop condition
All named projects round-trip byte-identically and the full suite is green; then merge to `main`, tag `m1`,
update `docs/HANDOFF.md` and `docs/ROADMAP.md`.
