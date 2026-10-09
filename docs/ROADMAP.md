# plainport roadmap

9 October 2026 · M0 and M1 closed (`v0.1.0`), M2 next

This is the staged delivery plan for `docs/DESIGN.md`. Each milestone is split into phases, each phase into
tasks that `/orchestrate` can run one by one. The milestone being built has a full plan file in `docs/plans/`; later
milestones are outlined here and get their plan file when the previous gate passes (ADR-0019).

## How to run a milestone

```text
git switch -c m1-local-core
/orchestrate docs/plans/M1-local-core.md strategy=staged review=dual
```

- **One task, one cycle.** The implementer writes the failing tests first, then the code (ADR-0017). Spec review,
  then quality review. A task is done when its verification commands pass through `board exec`.
- **Parallel only where marked.** Tasks tagged `parallel-safe` share no files and may run with
  `strategy=parallel` in worktrees.
- **Phase boundary = a merge to `main`.** All development happens locally on the milestone branch, managed by
  the orchestrator. When a phase's tests are green, the orchestrator merges the branch into `main` and pushes,
  and CI runs on `main` (no pull requests; ADR-0019, ADR-0021).
- **Gate = release.** When the milestone gate passes and CI on `main` is green, cut the release (`v0.<n>.0`, ADR-0020), update `docs/HANDOFF.md` and the status table below.
- **Reality over plan.** A task that finds the design wrong stops with `DESIGN_CONFLICT`. Nobody patches around
  it; the owner decides, and `DESIGN.md` plus an ADR change in the same commit.

## Status

| Milestone | Delivers | Gate | Test tiers | ADRs it needs | Status |
| --- | --- | --- | --- | --- | --- |
| **M0 · Prep** | Repo, ADRs, roadmap, M1 plan, test-environment research, agent permissions, Definition of Done | Docs reviewed; ADR-0018 accepted; M1 plan approved | none | 0001–0021 | Done, 2026-10-02 |
| **M1 · Local core** → `v0.1.0` | Factory floor; core, journal, recover; restic engine; Node plugin; external-SSD store; `init`, roots, `offload`, `onload`, `status`, `ls`; agent eval smoke | Crash matrix green; round trips byte-identical on five pinned public demo projects, without installs (D78) | T0, T1 | 0003–0008, 0010, 0017, 0020–0022 | Done, 2026-10-04, `v0.1.0`: [plan](plans/M1-local-core.md) |
| **M2 · Remote stores** | SFTP and S3 stores; catalog events via rclone; Keychain secrets; leases, head check, conflicts, `resolve` | The two-Mac race ends in `conflicted`, never in lost work | T0–T3 | 0006, 0009, 0013 | Next: outline below, plan file to write |
| **M3 · Machines** | Devices and pairing; per-device bindings; append-only peer stores; `move`; secrets envelope; warm return; offsite replication | A project moves MacBook → Mac mini → VPS → MacBook with git state intact | T0–T4 | 0010–0013, 0018 | Outline below |
| **M4 · Agent-ready** | `serve --stdio`; published contract; `attach`; Claude Code and Codex adapters; kit; handoff notes; arrival plans | An agent runs offload and onload unattended from `--json` alone | T0–T3 | 0007, 0014, 0015 | Outline below |
| **M5 · Hardening** | Grok Build adapter; Python and Rust plugins; `--verify full`; `prune --yes`; forget delay; `doctor --rebuild-catalog`; file-system zoo and network-fault suites | The catalog rebuilds from the repository alone | T0–T4 | 0009, 0012 | Outline below |
| **M6 · Frontends** | TUI; SwiftUI desktop app over JSON-RPC; stubs open on double-click | Owner sign-off | T0–T1 | 0016 | Outline below |

## Test environment tiers

Tools per tier are proposed in ADR-0018, from the vault research note and live checks on the laptop:

| Tier | What | Runs | Proves |
| --- | --- | --- | --- |
| **T0 · Unit and fakes** | `bun test`, fakes for every port, fast-check, fault injection through the host port | Every save, every CI run | Planner, fold, findings, saga logic, crash matrix (in-process) |
| **T1 · Local real binaries** | Real restic and rclone on temp repositories; sandboxed `HOME`s; an `ssh` shim; `hdiutil` APFS images (case-sensitive and not) | Every CI run on macOS | Engine contract, round trips, crash matrix with real `SIGKILL`, two sandboxed instances talking through the shim |
| **T2 · Local Linux peers** | OrbStack Ubuntu machines `hub` and `vps` (cloud-init: sshd, forced-command keys, logind drop-in; about 11 s to recreate); MinIO, `atmoz/sftp`, `rest-server --append-only` and Toxiproxy containers | CI on demand, milestone gates | Store contract, cross-OS round trips, detached jobs with `KillUserProcesses=yes`, network faults |
| **T3 · Real hardware and buckets** | The Intel Mac mini over Tailscale (`ssh mini`); Cloudflare R2 (`weur`, conditional writes); Backblaze B2 EU Central (offsite replica, native `b2:`); per-run prefixes and scoped keys | Milestone gates | darwin-x64 build, real Tailscale latency, real bucket semantics, append-only keys |
| **T4 · Remote VPS** | One Hetzner Cloud CX23 (x86_64, Falkenstein or Nuremberg), SSH only over Tailscale; created for the M3 gate | M3 and M5 gates | The full MacBook → mini → VPS → MacBook move |

## M0 · Prep (done)

| # | Task | Output | Status |
| --- | --- | --- | --- |
| 0.1 | Initialise git, push to `gabros20/plainport` (public, MIT) | `main` on GitHub | Done |
| 0.2 | ADRs for every design decision plus this session's | `docs/adr/` | Done |
| 0.3 | This roadmap and the M1 plan file | `docs/ROADMAP.md`, `docs/plans/M1-local-core.md` | Done, approved |
| 0.4 | Research test hosts, sandboxes and stores (Grok lane, X bookmarks plus web) | Vault note `wiki/research/linux-test-hosts-sandboxes-and-stores-2026.md` | Done; OrbStack claims verified live on the laptop |
| 0.5 | Fill ADR-0018 from the research; owner accepts | `docs/adr/0018-…` | Done, accepted |
| 0.6 | SSH alias `mini` on the laptop | `~/.ssh/config` entry | Done; untested, because the mini was offline in Tailscale on 2026-10-02 |
| 0.7 | Pin restic and rclone for development (`scripts/fetch-tools`, checksums in `tools.lock.json`) | M1 task 2 | Done |
| 0.8 | Versioning, release and install the plainkeep way; factory-floor guardrails | ADR-0020, ADR-0021 | Done |
| 0.9 | Agent permissions and Definition of Done | `.claude/settings.json`, `CONTRIBUTING.md` | Done |

**Gate:** the owner has reviewed the ADRs and this roadmap, ADR-0018 is accepted, and the M1 plan is approved.
M0 is documentation only, so it closes with a commit and no release.

## M1 · Local core

Done on 2026-10-04, released as `v0.1.0` on 2026-10-09. Full plan: [`docs/plans/M1-local-core.md`](plans/M1-local-core.md). Phases:

1. **Scaffold, factory floor and toolchain.** Bun workspace with `core`, `contract`, `cli`, `engine-restic`,
   `blob-fs`, `eco-node`, `host-macos`; the four scripts; `VERSION`, `CHANGELOG.md`, `.bun-version`; Biome,
   gitleaks, the home tripwire; macOS and Linux CI; pinned restic.
2. **Contract.** Command registry, risk classes, `--json` envelope, exit codes, finding codes, generated
   `plainport.json` and completions, contract tests (ported from plainkeep, ADR-0003).
3. **Config and roots.** `config.toml` plus `managed.toml` with merge rules and write lock; `init`,
   `root add | bind | list | scan`; device identity file.
4. **Process runner and engine.** One process runner; restic engine with JSON-lines parsing, exit-code
   mapping and recorded fixtures.
5. **Offload.** Scan, strip set, plan, the eight-phase saga with journal; external-SSD `blob-fs` store; stub and
   trash release.
6. **Onload.** Restore to staging, verify, swap, toolchain and hydrate with the Node plugin.
7. **Status, ls, recover and the gate.** Read commands, `recover`, the crash matrix, the agent eval smoke,
   `scripts/install`, byte-identical round trips on five pinned public demo projects, a performance baseline,
   release `v0.1.0`.

**Gate (D78):** the crash matrix is green, and offload → onload round trips of five public demo projects are
byte-identical apart from stripped paths. The gate ran without installs (D13); one owner-run gate on a real
project with hydration on is suggested before M2. Results and known limits: `docs/HANDOFF.md`. Run decisions:
[ADR-0022](adr/0022-run-decisions-in-m1.md).

## M2 · Remote stores (outline, next)

0. **Test environments as code.** `compose.yaml` (MinIO pinned by digest, `atmoz/sftp`, `rest-server
   --append-only`, Toxiproxy), `scripts/testenv up|down`, R2 and B2 test buckets with scoped keys referenced as
   `op://`; the Linux CI job starts running the containers; restic version matrix in CI.
1. **rclone blob store** and store contract suite against `fs`, MinIO and an SFTP container (T2), then B2 and R2
   (T3). `store add | list | test | remove`. Retest rclone's `If-None-Match` on the pinned version.
2. **Remote engine targets.** restic over SFTP and S3; per-store secrets through the Keychain provider.
3. **Catalog over stores.** Event mirror cache, offline `ls`, sealed events on bucket stores.
4. **Leases and conflicts.** Head check at commit, lease warnings and `strict`, `conflicted` state,
   `plainport resolve` with `refs/plainport/theirs/…` through a temporary index.
5. **Gate.** The two-Mac race (two sandboxed instances on one store) ends in `conflicted`.

## M3 · Machines (outline)

0. **Threat model** (`docs/THREAT-MODEL.md`) before any pairing code. OrbStack `hub` and `vps` machines from
   cloud-init (`scripts/testenv`); `orb version` on the mini; create the Hetzner CX23.
1. **SSH transport** (`transport-ssh`) with the SSH policy; peer RPC skeleton.
2. **Devices and pairing.** `device add | list | role | revoke`; forced-command keys; per-device restic keys;
   root bindings published as events; Linux lingering; installing the matching plainport build on the device
   over SSH (ADR-0020), including `darwin-x64` for the mini.
3. **Peer stores.** `rclone serve restic --stdio --append-only` data plane; append-only suite.
4. **Move.** Plan both sides, destination-first preflight, parked source, detached remote job,
   `attach`, finish; `move --copy`.
5. **Warm return and clone adoption.** Copy-on-write clone, in-place restore, backup checkpoints.
6. **Secrets envelope.** age plus age-plugin-se, grants and revokes.
7. **Jobs and replication.** launchd and systemd timer units (plainkeep's launchd pattern), `store replicate`.
8. **Gate.** MacBook → Mac mini → VPS → MacBook with git state intact (T3 + T4), plus detached-job tests on T2.

## M4 · Agent-ready (outline)

1. **`serve --stdio`** JSON-RPC 2.0 and the published `plainport.json`; MCP tool list generated from it (optional).
   The agent eval from M1 grows into the gate's scripted suite, with agent CLI versions in the CI matrix.
2. **Claude Code adapter**, then **Codex adapter**: inventory, capture, place, verify, cleanup; marker-token
   round trips in sandboxed homes with pinned agent versions.
3. **Handoff notes** and arrival plans.
4. **Agent kit**: `kit plan | apply | diff | capture`, ledger, `setup agents`.
5. **Gate.** An agent runs offload and onload unattended from `--json` alone.

## M5 · Hardening (outline)

Grok Build adapter; Python and Rust plugins; `--verify full`; `prune --yes` and the forget delay;
`doctor --rebuild-catalog`; file-system zoo (symlink loops, sockets, case pairs, NFD names, 4 GB file, 200,000
files); Toxiproxy network-fault suites; performance budgets enforced against the M1 baseline;
`doctor --bundle`. **Gate:** the catalog rebuilds from the repository alone.

## M6 · Frontends (outline)

TUI over the same plans and events (Ink, re-check OpenTUI); SwiftUI desktop app as a sidecar client of
`serve --stdio`; `.plainport` stubs open on double-click.

## Open items

- **ADR-0018** open checks: `orb version` on the mini, and rclone's `If-None-Match` support on the pinned version (M2).
- **The Mac mini** was offline in Tailscale on 2026-10-02, so `ssh mini` is configured but untested.
- **plainkeep `archive` gap** (from HANDOFF): fix in the plainkeep repository, not here.
