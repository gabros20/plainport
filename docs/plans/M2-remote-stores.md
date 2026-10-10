# M2 · Remote stores: orchestrate plan

Status: **draft, waiting for the owner's approval.** Run on branch `m2-remote-stores` once the owner decisions below
are answered:

```text
/orchestrate docs/plans/M2-remote-stores.md strategy=staged review=dual
```

**Milestone gate.** Two sandboxed plainport instances racing on one store (the two-Mac race) end in `conflicted`,
never in lost work: on a local store (T1), on MinIO and on an SFTP container (T2), and on Cloudflare R2 (T3) when the
owner's buckets and the Mac mini are available. If T3 cannot run, the gate passes at T2 and HANDOFF records T3 as
pending.

**Before Task 1 (owner).** Answer the decisions below; the orchestrator records the answers as ADR-0023 ("M2
decisions") in the commit that approves this plan. Read the flagged decisions in ADR-0022, since M2 builds on them.
The real-project gate with hydration on (D78) is still suggested, not required.

---

## Owner decisions needed

Each question is a place where `DESIGN.md` is silent or ambiguous, or where M2 changes a persisted format or the
public contract. A task that reaches a question still open stops with `DESIGN_CONFLICT`.

**Q1. S3 store credentials and layout** (config is input, strict; Tasks 5 and 8). Today an `s3` store has `endpoint`,
`bucket` and one `secret`, which DESIGN says holds "restic password + access keys", and no prefix inside the bucket.
- (a) One reference whose value bundles the password and the key pair as JSON.
- (b) Separate references: `secret` (restic password), `accessKeyId` and `secretAccessKey`, all required for `s3`,
  plus optional `region` and `path` (a prefix inside the bucket, default none).
- (c) Like (b), but the key pair comes from the AWS environment and profile chain.

*Recommendation: (b).* Each value is one Keychain item or one 1Password field (`op://vault/item/field`), and `path`
lets several roots (one repository per root, D48) and T3's per-run prefixes share a bucket. Consequence: a config
with these keys is refused by v0.1.x (its config schema is strict), so rolling back after adding an S3 store means
removing that store's lines first.

**Q2. Create-only writes and the root claim on stores without a conditional write** (D50; Task 7). rclone's
`If-None-Match` is unproven on 1.75.1, B2 rejects the header (ADR-0018), and rclone has no exclusive create on SFTP.
Events need none (ULID names, D41); the root claim does.
- (a) Require a conditional write: a store without one cannot serve a root.
- (b) A direct, SigV4-signed HTTP `PUT` with `If-None-Match: *` for the claim only, where the backend accepts it
  (MinIO, R2); refuse B2 and SFTP.
- (c) A claim protocol that needs only list-after-write consistency: write `meta/v1/root-claims/<root>.json`, list
  the claims, and go on only when yours is the only one or `meta/v1/root.json` already names your root; then write
  `root.json`. When several claims show and `root.json` is absent, every claimant refuses (`store.root-contested`,
  fail closed; the fix names the claim file to remove by hand).

*Recommendation:* use the conditional write wherever Task 7 proves the rclone adapter sends it, and (c) everywhere
else. (c) is provable with T0 interleaving tests and adds no HTTP stack. Its stuck case needs two roots' first
offloads to one fresh store at the same instant.

**Q3. Sealed catalog events** (ADR-0013 says "bucket and VPS stores"; Task 10). Three parts:
- *The key.* (a) HKDF-SHA256 from the repository's master key, read with `restic cat masterkey` inside
  `engine-restic`: no new secret, whoever can open the repository can read its catalog, and it survives M3's
  per-device restic keys. (b) A random 32-byte key per store, held as one more secret reference with a 1Password
  recovery copy. (c) HKDF from the repository password, which breaks once M3 gives each device its own restic key.
- *Which stores.* (i) `s3` only; (ii) `s3` and `sftp`; (iii) per store, chosen at `store add` with a default by kind
  and pinned on this device, so a store reached as `local` on one device and `sftp` on another (D68) stays one store.
- *The format.* The same key, `meta/v1/events/<ulid>.json`, holding `{"v":1,"sealed":"xchacha20poly1305","nonce","ct"}`
  with the key name as associated data. `store.json` and `root.json` stay plain: they hold only ULIDs.

*Recommendation:* key (a), verified on the pinned restic first, with (b) as the fallback; stores (iii), sealed by
default for `s3` and `sftp`, plain for `local`. A store pinned as sealed that serves a plaintext event has it left
out of the fold (`catalog.unsealed-event`), never trusted. The mirror keeps opened events, so offline `ls` works.
Replication (M3) re-seals, since each repository has its own master key.

**Q4. Where this device keeps per-store facts** (the seal pin, measured capabilities, the last test; Tasks 9 and 10).
`registry.json` is `{v: 1}` with a strict schema, so v0.1.1 refuses any field M2 adds and `scripts/install --rollback`
would break.
- (a) `registry.json` v2: v0.2 reads v1 and v2; a rollback cannot read it.
- (b) A new file per store, `~/.local/state/plainport/stores/<store id>.json` (`{v: 1, sealed, capabilities,
  testedAt}`), which v0.1 never reads.

*Recommendation: (b).*

**Q5. New catalog event types at `v: 1`** (D74; Task 14). M2 writes one new type, `resolved`. A v0.1.x reader
skips an unknown type (D17), and since it changes state, folds as uncertain (D86) and refuses head-dependent defaults:
it fails closed and is never wrong. Every existing type is strict, so even an "additive optional" field makes a
v0.1.x reader skip the whole event.
- (a) New types at `v: 1`; no new fields on existing types in M2; HANDOFF states that every device reading a store
  v0.2 wrote runs v0.2.
- (b) Bump everything M2 writes to `v: 2`.
- (c) Make readers ignore unknown fields from v0.2 on.

*Recommendation: (a).* Decide (c) before M3, when version skew across paired devices becomes real.

**Q6. A fork found after the commit** (Task 13). Two devices can both pass the head check and both append, which is
the race the gate runs. The fold then shows `conflicted` with both snapshots kept, so no work is lost either way.
- (a) Release as today: both folders go to the trash, and `resolve` works from the store.
- (b) Read the catalog again right before release's rename, where D52's fingerprint guard runs. When this
  operation's snapshot is in a fork, keep the folder, write no stub and exit 8 with `catalog.head-moved` (data
  kind `fork-after-commit`, additive). `recover` does the same check from `committed` on, and stays pending while
  the store does not answer, where today it goes by the journal alone (D24).

*Recommendation: (b).* DESIGN's step 7 promises that nothing local is deleted on a conflict, and the theirs ref
(Task 15) needs the local copy. Cost: one catalog read before release, and recover needs the store after a commit.

**Q7. What `resolve` does in M2** (Tasks 14 and 15). DESIGN says "keep one head, or both under two names".
- (a) `--keep <snapshot>` only. It appends `resolved` naming the kept snapshot and the tips it settles. The others
  stay in the repository and remain restorable with `restore --snapshot`. Keeping both means restoring the other
  side by side (`restore --snapshot <id> --to <path>`) and filing it as a new project (`offload --root … --as …`).
- (b) Also `--both --as <address>`, which forks a new project id from a snapshot. That needs a `forkedFrom` format,
  the same one M3's `move --copy` needs.

*Recommendation: (a)* now, and (b) with `move --copy` in M3. While this device holds a working copy, `--keep` must
name that copy's snapshot: you bring their work in through the theirs ref, then keep yours.

**Q8. The store commands' risk classes, and what `store remove` does** (Task 9).
- `store list`: `read`.
- `store test`: `safe_write`. It writes, reads and deletes one probe key under `meta/v1/probes/`, and reports a
  refused delete as "append-only" rather than as a failure; `--read-only` only reads.
- `store add`: `safe_write`. It writes only plainport's own setup files (`store.json`, an empty restic repository, the
  root claim) to a store you named; no project data. The alternative is `confirm`, since it sends bytes off the
  machine.
- `store remove`: `confirm`, and local only. It forgets the name in `managed.toml` and on this device, deletes
  nothing on the store, and refuses (`store.in-use`) while a root pins the store or this device has projects shelved
  there.

*Recommendation:* as listed, with `store add` as `safe_write`.

**Q9. A project and its store before replication** (M3; Task 11). A project's events live on the store it was
offloaded to. Another store's catalog has no base for it, so an offload there would start a second history, and an
onload there sees an incomplete head.
- (a) Refuse an offload to a store other than the one that holds the project's head (`store.history-elsewhere`,
  exit 6; the fix names that store).
- (b) Allow it as a new first offload: a fork across stores.

*Recommendation: (a).*

**Q10. Secret providers in M2** (Task 5). The outline names Keychain only.
- `keychain:<service>/<account>`, read through `/usr/bin/security find-generic-password -w` and written only by
  `store add --secret-stdin`, through `security -i` with the command on stdin, never in argv.
- `op:` (`op://vault/item/field`), read through `op read` with the CLI's own sign-in.
- `se:` and `bw:` stay refused until M3 and M5.

*Recommendation:* build both `keychain:` and `op:` now. T3's bucket keys and the owner's recovery passwords already
live in 1Password.

**Q11. `init --store-path` re-pointing an unreachable pinned name** (HANDOFF known limit; Task 9).
- (a) Keep it. D45 still refuses the wrong disk at use.
- (b) Refuse to re-point a pinned name to a path that does not answer with the pinned id. Re-pointing an unplugged
  disk's name stays possible by editing `config.toml`, which D68 checks at use.

*Recommendation: (b)*, so D85's "before anything is written" holds.

**Q12. Three small persisted-format additions** (Tasks 1 and 2):
- (i) The trash claim (`<op>.claim`, local) gains an optional `bootSession`, read from the host (macOS
  `kern.bootsessionuuid`, Linux `/proc/sys/kernel/random/boot_id`). This fixes N13's 120-second window, and old
  claims keep the old rule.
- (ii) Offload adds the restic tag `plainport:mode=<octal>` (D26 encoding), so `onload --snapshot S` under an
  uncertain head can set the folder's mode when the event holding `rootMode` is the unreadable one.
- (iii) Fingerprint v3 leaves out git's transient lock and pid files inside `.git` (`*.lock`, `gc.pid`), so
  background `git maintenance` stops failing offloads; the files they guard stay in. A journal holding a v2
  fingerprint is still compared as v2.

*Recommendation:* all three. The alternative to (ii) is a warning that the mode is unknown; the alternative to (iii)
is stopping `git maintenance`, which means editing the user's launchd or systemd schedule.

**Q13. The T3 race across two Macs: how the mini gets the test-bucket keys** (Task 17).
- (a) `op` signed in on the mini.
- (b) The laptop resolves the `op://` references and passes the values over SSH on stdin into the child's
  environment: never in argv, never on disk. The keys are scoped to the test bucket and rotated after the run.
- (c) No cross-device bucket race: T3 races two sandboxes on the laptop against R2 and runs only single-device
  checks on the mini.

*Recommendation: (b)* if the owner accepts handing test-scoped keys to the mini; otherwise (c).

**Q14. Confirm what M2 leaves out:**
- Breaking a stale lease (`lease-broken`): a `strict` user sets `leases = "warn"` for that onload.
- Device names in the lease view: it shows the device id until M3's pairing gives names.
- `resolve --both` (Q7).
- B2's native `b2:` backend: M2 reaches B2 through its S3 API, and the native backend arrives with replication.
- The REST server: in the compose file for M3's append-only work, but not a store kind.

*Recommendation:* confirm all five.

---

**Every task, every time.**

- Read `AGENTS.md`, ADR-0023 (the answers above) and the ADRs and `docs/DESIGN.md` sections the task names before
  writing anything.
- Test-first (ADR-0017): write the failing tests that state the acceptance, run them, see them fail, then
  implement. Report the red run and the green run.
- **Never lose work.** The local folder is touched only in release, after a verified commit. Every new saga step or
  after-effect seam is exported, so the crash matrix gains its rows by itself, and gets a rule in
  `OFFLOAD_RECOVERY` or `ONLOAD_RECOVERY`. A step without a rule stays pending, and so must a test that reaches it.
- **One guarded deleter (D87).** Every recursive local delete goes through it. On a store, plainport deletes only its
  own probe keys (`store test`): never an event, a claim, `store.json` or restic data.
- **One process runner** for rclone, restic, ssh, `security`, `op` and git. Calls to secret providers capture stdout
  without streaming it as `log` events.
- **Errors are values.** Every new finding goes into the contract's catalogue with its severity, exit code and fix,
  and into `docs/machine-contract.md`. `bun run contract` is run and its output committed.
- **Secrets stay references.** A secret value lives only in memory and in a child's environment: never in argv (`ps`
  shows it), a file, a log, a journal, config, a fixture or an error message. rclone remotes are defined through
  environment variables, with `RCLONE_CONFIG` pointed at a file that does not exist, so the user's `rclone.conf` is
  never read. Each task that handles a secret runs the canary helper from Task 5 over everything the test wrote and
  printed.
- **Sandboxes only.** Tests never touch the real home, the login Keychain (they use throwaway keychains) or real
  buckets, except Task 17, which works under per-run prefixes with scoped keys. OpenSSH reads `~/.ssh` from the
  passwd home, not `$HOME`, so the home tripwire does not cover it: tests reach ssh only through the shim from Task 7,
  with `-F` pointing at a sandbox config.
- **Tiers are explicit.** Each suite is tagged T0, T1 (`describeT1`) or T2 (`describeT2`, Task 4). A T2 suite that
  finds no test environment fails when `PLAINPORT_TEST_TIER` is 2 or more, naming `scripts/testenv up`; it never
  skips silently.
- **Formats and contract.** Catalog events follow D74 and Q5. A local persisted file stays readable by the previous
  reader where the owner has not decided otherwise (Q4, Q12), so `scripts/install --rollback` to v0.1.1 keeps
  working. Contract changes are additive: `plainport_json` stays 1, and M2 adds no `ProjectState` value (D17); new
  conditions are fine, since that set is open.
- Commit by path (`git add <your files>`), one or more small commits per task, message `m2(task N): …`.
- If the design is wrong or silent on something that matters, stop with `DESIGN_CONFLICT`; don't patch around it.
  `DESIGN.md` changes in the same commit as the behaviour, and so does ADR-0023 for a changed decision.
- Write the report to `.orchestrate/reports/task-N.md`: status, commits, tests added, red and green evidence, the
  tier each test ran at, decisions made, open questions.

**Tiers by task.**

| Task | Tiers | Needs |
| --- | --- | --- |
| 1–3, 12–15 | T0, T1 | the laptop |
| 4 | T2 | Docker or OrbStack |
| 5 | T0, T1 | macOS for the Keychain suite |
| 6 | T0, T1 | pinned rclone |
| 7–11, 16 | T0, T1, T2 | Docker or OrbStack (`scripts/testenv up`) |
| 17 | T3 | the owner's R2 and B2 `op://` references, `op` signed in, `ssh mini` over Tailscale |
| 18 | T1, T2 (T3 when Task 17 passed) | as above |

Everything up to and including the gate is provable at T0 to T2. Only Task 17 needs real buckets or the mini.

**Dependency graph.** 1 → 2 · {2, 3, 4} → {5, 6} · {4, 6} → 7 · {5, 7} → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 →
16 → 17 → 18. Tasks 1, 3 and 4 are `parallel-safe` with each other, and so are tasks 5 and 6.

**Branches.** All work happens locally on `m2-remote-stores`, managed by the orchestrator; no pull requests. At each
phase boundary (after tasks 4, 7, 9, 11, 15 and 18) the orchestrator merges into `main`, pushes, and checks CI on
`main` with `gh run watch`; from Task 4 on, that includes the Linux job running the T2 containers. A red CI stops the
next phase until it's fixed (ADR-0021).

| Phase | Tasks | Ends with |
| --- | --- | --- |
| 1 · Carry-overs and test environments | 1–4 | M1's open minors closed; `scripts/testenv`; T2 in Linux CI |
| 2 · Secrets and the rclone blob store | 5–7 | Keychain and 1Password references; store contract green on fs, rclone, MinIO and SFTP |
| 3 · Remote stores end to end | 8–9 | Offload and onload over SFTP and S3; `store add \| list \| test \| remove` |
| 4 · Catalog over stores | 10–11 | Sealed events; mirror, offline `ls` and the home-store rule on remote stores |
| 5 · Leases and conflicts | 12–15 | Two-device leases; forks at and after the commit; `resolve` and the theirs ref |
| 6 · Proof and release | 16–18 | Remote crash matrix; T3; the two-Mac race; `v0.2.0` |

---

## Task 1 — Core safety carry-overs  `parallel-safe with Tasks 3 and 4`

### Objective
Close the core-safety minors M1's reviews left open, before remote stores build on the same code.

### Context
`docs/HANDOFF.md` "Carried into M2 → Core safety" and "Known limits"; D32, D63, D64, D67, D86, D87; Q12 (i) and (ii);
`docs/DESIGN.md` "Offload process" (the detached delete and its claim) and "Catalog and data model" (restic tags).

### Scope
Owns `packages/core/src/{trash-claim.ts,trash-delete.ts,lock.ts}`, `packages/core/src/recover/trash.ts`, the claim
and boot parts of `packages/core/src/ports/host.ts` and `packages/host-macos/src/host.ts`, the tag and `rootMode`
parts of `packages/core/src/saga/{snapshot.ts,onload.ts}` and `packages/engine-restic/src/engine.ts`, and
`packages/cli/src/housekeeping.ts`.

- **Orphan claims.** `gc` and housekeeping remove an `<op>.claim` (and a stray `.claim.tmp`) whose trash folder is
  gone and whose claimer is not live by D64's test. This is a single-file delete, and the claim is never removed
  while its trash exists.
- **Boot session (Q12 i).** `HostPorts` gains `bootSession()`. A new claim records it, and liveness compares it when
  both sides have one; an old claim keeps the 120-second boot-time rule. The lock's "taken since this boot" test (D63)
  uses the same helper.
- **`rootMode` under an uncertain head (Q12 ii).** Offload adds the `plainport:mode=<octal>` tag. `onload --snapshot S`
  through the tag lookup (D86, D88) sets the folder's mode from it, and without the tag it leaves a new folder's mode
  and says so in the output.
- **Host calls on network mounts (D32).** Store probes (reachability and reading `store.json`) race a deadline
  (default 10 s) and return `store.unreachable` when it passes. The hung call is abandoned, since Bun cannot cancel
  it; the limit is documented.

### Tests first
A claim with no trash and a dead pid is removed, while one with a live pid is kept. A claim from this boot with a
stepped clock (boot time 200 s off, same `bootSession`) reads as live. An old claim with no `bootSession` behaves as in
M1. `onload --snapshot S` with the offloaded event unreadable restores mode `0700` from the tag. A store probe
against a fake `stat` that never returns fails within the deadline.

### Verification
`bun test packages/core -t "claim|lock|gc|onload"` and `bun run test:t1 -t "claim|onload"`, then the crash matrix
(`bun test test/crash-matrix`), unchanged and green.

### Report
`.orchestrate/reports/task-1.md`

### Stop condition
All four items have tests that fail without the change; the crash matrix is green in both variants.

---

## Task 2 — `onload --dry-run` and the planning carry-overs

### Objective
Agents can preview an onload (D71), and the offload plan says what M1 left unsaid: nested repositories, tags on no
remote, non-git projects, and git maintenance no longer fails offloads.

### Context
D36, D38, D69, D71; Q12 (iii); `docs/HANDOFF.md` "Carried into M2 → UX"; `docs/DESIGN.md` "Onload process" and
"Offload process" steps 3 and 5; `docs/machine-contract.md` §6 (the `--dry-run` contract).

### Scope
Owns the planning part of `packages/core/src/saga/onload.ts` (after Task 1), `packages/core/src/plan/`,
`packages/core/src/scan/`, the `onload` command's options and output schema, and its renderer.

- **`onload --dry-run`** is `read` (D18) and changes nothing: it saves no plan, since onload has no `--plan`. It
  reports `restored: "reuse" | "store"` and why, the snapshot and the head it is written over, the landing folder,
  the space needed, findings (occupied path, case collisions, the lease, `catalog.*`), and the hydrate plan (package
  manager, frozen command, toolchain, Corepack). A `block` finding exits 6 with the preview as data, as offload's dry
  run does (D38).
- **D69 items.** Tags that no remote holds are reported under `git.unpushed` (message and `paths`; no new code).
  Nested repositories are listed in the plan (`nested`, additive).
- **Non-git projects.** The human plan adds "not a git repository: every file travels except stripped dependency
  folders".
- **Fingerprint v3 (Q12 iii)** for new plans and journals. Recover and plan approval compare a v2 fingerprint as v2.

### Tests first
`onload --dry-run --json` validates against the schema and writes nothing (a tree snapshot of the sandbox before and
after, store included). It reports reuse for a kept trash, blocks on an occupied path with exit 6 and data, and warns
`lease.held`. A local-only tag shows under `git.unpushed`; a nested repository appears in the plan. Creating
`.git/objects/maintenance.lock` during the upload no longer fails the offload, while an edit to a tracked file still
does. A v2 journal recovers as before.

### Verification
`bun test packages/core -t "onload|plan|scan" && bun test packages/cli -t onload && bun run contract && git diff
--exit-code plainport.json schemas/`

### Report
`.orchestrate/reports/task-2.md`

### Stop condition
`onload` lists `dryRun: true` in `plainport.json`, `docs/machine-contract.md` agrees, and the tests are green.

---

## Task 3 — Small carry-overs: hydration environment, gate tooling and test hygiene  `parallel-safe with Tasks 1 and 4`

### Objective
Close the remaining small minors, so the M2 gate starts from better tools.

### Context
`docs/HANDOFF.md` "Carried into M2 → Core safety" (Corepack), "Gate and eval" and "Tests and flake watch"; D54, D79.

### Scope
Owns the install environment in `packages/core/src/saga/hydrate.ts` and `packages/eco-node/src/hydrate.ts`,
`packages/cli/src/testing.ts`, `evals/agent-smoke/scorer.ts`, `scripts/gate-m1.ts` and a new `scripts/tree-compare.ts`.

- **Corepack.** Installs run with `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`, so they never wait on a prompt, and
  `COREPACK_ENABLE_AUTO_PIN=0`, so Corepack never writes `packageManager` into the user's `package.json`. The hydrate
  report says when Corepack provided the package manager.
- **Tree comparison.** It moves out of `gate-m1.ts` into `scripts/tree-compare.ts`, and compares hard-link groups,
  extended attributes and BSD file flags on top of M1's type, mode, content hash and link target. `gate-m1.ts` uses
  it, and so does the M2 gate. A gate's raw `--out` JSON is attached to the release notes.
- **Eval scoring.** It splits into `passed` (the four objective checks) and `clean` (no contract issues).
- **The temp-folder leak.** `packages/cli/src/testing.ts` removes its `plainport-example-*` folders. A suite-level
  check fails when a run leaves new `plainport-*` folders in `$TMPDIR`.

### Tests first
`package.json` is byte-identical after a Corepack-managed install fixture. Tree comparison finds a broken hard link,
a dropped xattr and a dropped `uchg` flag. The scorer gives `passed` but not `clean` on a recorded transcript with one
confusing message. The leak check fails before the fix.

### Verification
`bun test packages/eco-node packages/cli evals/agent-smoke scripts`

### Report
`.orchestrate/reports/task-3.md`, with the scorer split recorded as a decision.

### Stop condition
All four items are green, and `bun scripts/gate-m1.ts` still passes on one demo project with the new comparison.

---

## Task 4 — Test environments as code  `parallel-safe with Tasks 1 and 3` · `T2`

### Objective
One command brings up the T2 store containers on the laptop and in Linux CI, and CI runs the store suites and a
restic version matrix.

### Context
ADR-0018 (T2, "Environments as code", "Store capabilities are measured"), ADR-0021 (test tiers as commands, Linux CI
job, version matrix); `docs/HANDOFF.md` "Tests and flake watch" (the Linux recipe); `CONTRIBUTING.md`.

### Scope
Owns `compose.yaml`, `scripts/testenv.ts` (and its `scripts/testenv` wrapper), `test/tiers.ts`, the `test:t2`
script in `package.json`, `.github/workflows/ci.yml`, `scripts/ci-workflow.test.ts`, the matrix section of
`tools.lock.json`, `scripts/fetch-tools.ts`, `.gitignore`, and the testing section of `CONTRIBUTING.md`.

- **`compose.yaml`.** Every image is pinned by digest, and every port binds to `127.0.0.1` only:
  - MinIO (SeaweedFS if the image is unavailable, per ADR-0018);
  - `atmoz/sftp`, with a key-only user;
  - `restic/rest-server --append-only`, for M3, with a smoke test only;
  - Toxiproxy, with a proxy in front of MinIO and one in front of SFTP.
- **`scripts/testenv up | down | status | env | linux`.**
  - `up` is idempotent and waits for health checks. It writes `.testenv/` (gitignored): endpoints, credentials
    generated for this run, the SFTP host key and client key, and a sandbox `known_hosts` and ssh config.
  - `down` removes the containers and volumes, and `env` prints the variables tests read.
  - `linux` is the reproducible Linux test recipe: a pinned `oven/bun` container with `--init`, the repository
    mounted, and the known gaps (no git fsmonitor daemon) set out.
  - It works with Docker Desktop, OrbStack and the Ubuntu runner. Agents never build an environment by hand.
- **T2 tier.** `describeT2` and `bun run test:t2` (`PLAINPORT_TEST_TIER=2`), with T2 suites failing rather than
  skipping when `.testenv/` is missing.
- **CI.**
  - The `linux` job runs `scripts/testenv up` and `test:t2`.
  - A new `restic-matrix` job runs `engine-restic`'s T1 suite against restic 0.17.1 (ADR-0006's floor), the latest
    0.18 and the pinned 0.19.1. The matrix versions go into `tools.lock.json` with checksums from the official files,
    `fetch-tools.ts --restic <version>` fetches them, and recorded fixtures exist for each under
    `fixtures/restic/<version>/`.
  - macOS runners have no Docker, so T2 stays on Linux.
- T3 references arrive in Task 17; this task only reserves the `.testenv/t3.env` name in `.gitignore`.

### Tests first
`tiers.test.ts`: `describeT2` runs at tier 2 and fails without `.testenv/`. `ci-workflow.test.ts` pins the T2 step
and the matrix versions. A `fetch-tools` checksum mismatch for a matrix version refuses. A T2 smoke test runs `up`,
reaches MinIO, SFTP (through the sandbox ssh config) and Toxiproxy, then `down` leaves no container or volume behind.

### Verification
`scripts/testenv up && bun run test:t2 -t testenv && scripts/testenv down`, `bun test scripts test/tiers.test.ts`,
`actionlint` if available, and one `scripts/testenv linux` run of `bun run test:t1` with its result in the report.

### Report
`.orchestrate/reports/task-4.md`, including the flake-watch rows from HANDOFF that the Linux recipe reproduced or
cleared.

### Stop condition
`up` and `down` are idempotent, and the CI workflow is valid. The orchestrator confirms the Linux T2 job and the
restic matrix green on `main` at the phase boundary.

---

## Task 5 — Secret providers: env, file, Keychain and 1Password  `parallel-safe with Task 6`

### Objective
Store secrets resolve through a `SecretProvider` port with `env:`, `file:`, `keychain:` and `op:` providers, and no
value ever leaves memory or a child's environment.

### Context
ADR-0013; `docs/DESIGN.md` "Security and encryption" (Key custody, Keychain prompts), "Configuration", "Plugin
interfaces → SecretProvider"; D79; Q1, Q10.

### Scope
Owns `packages/core/src/ports/secrets.ts`, a new `packages/secrets/`, the secret parts of `packages/core/src/store.ts`
(`resolveSecret` moves behind the port; `secretVariables` covers the new references), the `s3` store fields in
`packages/core/src/config/schema.ts` (Q1), and a canary helper in `packages/core/src/testing/`.

- **`keychain:<service>/<account>`.**
  - Reading runs `/usr/bin/security find-generic-password -s <service> -a <account> -w` through the runner, with
    stdout captured, never streamed. "Not found" gives `store.secret-missing`, whose fix is the interactive
    `security add-generic-password -s … -a … -w` (the value is typed, never passed).
  - `set` runs `security -i` with the command on stdin, never in argv.
  - Tests reach a throwaway keychain through a test hook that release builds compile out (D67).
- **`op:`.** `op read <ref>` through the runner, stdout captured. A missing CLI or no sign-in gives
  `store.secret-missing` with the exact fix.
- **`se:` and `bw:`** are refused, naming the milestone that brings them.
- **The install environment (D79)** also drops `AWS_*`, `RCLONE_*` and `OP_*` session variables, and the variables
  that the new references name.
- **The canary helper** plants a unique secret value. It then fails if that value appears in any file under the
  sandbox, in captured stdout or stderr, in an event line, or in the argv of any process the runner started.

### Tests first
- **Each provider:** found, missing, empty, and garbled reference. The value never reaches a `log` event, a
  journal, a file or argv.
- **Keychain (T1, macOS):** a temp keychain created under the sandbox HOME is read and written; `security
  list-keychains -d user` and the default keychain are byte-identical before and after.
- **`op`:** a fake `op` on the sandbox PATH.
- **Schema:** `s3` requires `accessKeyId` and `secretAccessKey`; `keychain:plainport` without an account is refused.

### Verification
`bun test packages/secrets packages/core -t "secret|store" && bun run test:t1 -t keychain && bun run contract`

### Report
`.orchestrate/reports/task-5.md`

### Stop condition
Every provider is green, the canary helper is exported and used, and `DESIGN.md` "Configuration" names the reference
forms M2 reads.

---

## Task 6 — The rclone blob store  `parallel-safe with Task 5`

### Objective
`blob-rclone` implements the `BlobStore` port over the pinned rclone, proven by a store contract suite that every
adapter runs.

### Context
ADR-0006, ADR-0018 ("measured, never assumed"); `docs/DESIGN.md` "Storage: engine and metadata", "Plugin interfaces
→ BlobStore"; D40, D41, D42; `packages/core/src/testing/blob-store-contract.ts`.

### Scope
Owns a new `packages/blob-rclone/`, `packages/core/src/testing/blob-store-contract.ts` (made capability-aware and run
against any factory), `packages/core/src/testing/memory-blob-store.ts` (capability knobs), and an optional batch read
on the port (`getMany`). The batch read is internal, not public contract.

- **Calls** run through the runner:
  - `get` is `rclone cat`; `put` is `rclone rcat` from stdin; `list` is `rclone lsjson -R --files-only`, which
    gives sizes; `stat` is `lsjson --stat`; `delete` is `deletefile`.
  - `getMany` is one `rclone copy --files-from-raw` into a temp folder under plainport's cache, cleaned through the
    guarded deleter.
- **Remotes** come only from environment variables (`RCLONE_CONFIG_<NAME>_*`), with `RCLONE_CONFIG` pointed at a file
  that does not exist and `--cache-dir` under plainport's cache.
- **Bounded network calls.** `--contimeout`, `--timeout`, `--retries 1` and `--low-level-retries`, plus the runner's
  idle and overall deadlines.
- **Exit codes.** On `get` and `stat`, 3 and 4 mean `null`. Exit 5 and connection failures give `store.unreachable`
  (9). Anything else gives `store.failed`, with stderr redacted.
- **Capabilities.** `createIfAbsent` and `replaceIfMatch` are false until Task 7 measures them.
- **Whole writes.** Check whether rclone's partial-upload rename makes a `put` whole on the local and SFTP backends
  of 1.75.1, and record the answer: a reader must never see a torn event.

### Tests first
- Exit-code mapping on recorded rclone stderr fixtures.
- The canary: no secret in argv or in rclone's error output.
- A `rclone.conf` with a poisoned remote, planted in the sandbox, is never used.
- The contract suite fails against a stub adapter, then passes against fs, memory and rclone's `local` backend on a
  temp folder (T1).
- One `getMany` of 200 keys starts one process.

### Verification
`bun test packages/blob-rclone packages/core -t blob && bun run test:t1 -t blob-rclone`

### Report
`.orchestrate/reports/task-6.md`, with the partial-upload finding.

### Stop condition
The contract suite is green on fs, memory and rclone-local, and it is the one suite every later adapter runs.

---

## Task 7 — The store contract on MinIO and SFTP, conditional writes and the root claim  `T2`

### Objective
The rclone blob store passes the contract on MinIO and an SFTP container. rclone's `If-None-Match` is measured, not
assumed, and the root claim holds on stores without a conditional write.

### Context
ADR-0018 (the open `If-None-Match` check), D41, D42, D48, D50, D51; Q2; `docs/DESIGN.md` "Machines → SSH policy";
`packages/core/src/catalog/root-claim.ts`.

### Scope
Owns the T2 tests of `packages/blob-rclone/`, the non-conditional paths of `packages/core/src/catalog/root-claim.ts`
and of `appendEvent` in `packages/core/src/catalog/log.ts`, a new `test/support/ssh-shim.ts`, and a test-only SigV4
probe in `test/support/s3-probe.ts`.

- **SFTP through the system OpenSSH.** rclone's `--sftp-ssh` runs the same `ssh` restic uses, with `BatchMode=yes`
  and `StrictHostKeyChecking=yes`, so the user's `~/.ssh/config` applies to both layers. In tests the shim adds
  `-F <sandbox config>`.
- **`If-None-Match` on 1.75.1.**
  - Measure it through the adapter against MinIO, using the direct probe as the reference.
  - Record the result in ADR-0018's open item, in `DESIGN.md` and in each backend's `capabilities()`.
  - Use the conditional write where the adapter sends it.
- **The root claim (Q2)** uses that conditional write where it exists, and Q2's claim protocol everywhere else.
- **Event appends on stores without a conditional write** put, then read back and compare. A different event under
  the same id is `store.key-exists`, and nothing is written over.
- **Toxiproxy** cuts the link during `put` and `list`. The result is `store.unreachable`, and a later `list` shows
  the whole event or nothing.

### Tests first
- **Claim interleavings (T0, memory store):** every interleaving of two claimants' write, list and settle lets at
  most one proceed, and a contested claim refuses both.
- **Contract (T2):** the suite on MinIO and SFTP, red against the T1-only adapter, then green.
- **Claim race (T2):** two processes claiming one fresh MinIO prefix and one SFTP folder.
- **Toxiproxy cuts (T2):** as above.

### Verification
`scripts/testenv up && bun run test:t2 -t "blob-rclone|root-claim" && bun test packages/core -t "root-claim|log"`

### Report
`.orchestrate/reports/task-7.md`, with the measured capability table: backend, `createIfAbsent`, and how it was
measured.

### Stop condition
The contract is green on fs, rclone-local, MinIO and SFTP; the `If-None-Match` result is recorded; the claim race
never lets two roots on one store.

---

## Task 8 — Remote engine targets and the store opener  `T2`

### Objective
Offload and onload run against SFTP and S3 stores. One store definition gives restic's repository and the catalog
at the same place.

### Context
ADR-0006, ADR-0010; `docs/DESIGN.md` "Storage → Store kinds" and "Layout on every store", "Machines → SSH policy";
D27, D45, D68, D85; Q1.

### Scope
Owns `packages/engine-restic/src/engine.ts` (repository locations and options), `packages/cli/src/stores.ts` (the
opener for `local`, `sftp` and `s3`; `peer` stays `store.unsupported` until M3), the remote parts of
`packages/core/src/store.ts` (setup over a `BlobStore`), and `packages/core/src/catalog/identity.ts` (`store.json`
on stores without a conditional write).

- **Repository locations:**
  - `sftp:<host>:<path>/repo`, with `-o sftp.args=` carrying `BatchMode=yes` and the shim in tests;
  - `s3:<endpoint>/<bucket>/<path>/repo`, with `-o s3.region=` when it is set.
  - Credentials go only in the child's environment (`RESTIC_PASSWORD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`),
    and restic's messages are redacted of values and of URLs with credentials.
- **Failures.** restic's network failures map to `store.unreachable` (9), a missing repository to
  `store.not-set-up`, and a lock to `--retry-lock`, then exit 11.
- **Setup** writes `store.json` (create-only where possible, otherwise write and read back) and then the restic
  repository (`restic init` when `restic cat config` finds none). Two devices racing to set up one fresh store can
  record different ids; the loser then gets `store.identity-changed` (fail closed), which the report states as a
  known limit.

### Tests first
- **Golden tests** for each kind's repository location, options and environment, with the canary over argv.
- **T2 round trips:** offload, then onload, of a fixture project on MinIO and on SFTP, byte-identical by the Task 3
  comparison.
- **A Toxiproxy cut mid-upload** fails the offload before the commit, with the folder untouched (invariant 1).
- **Unreachable and wrong-password** stores map to 9 and to `store.secret-missing` or `store.failed`.

### Verification
`bun test packages/engine-restic packages/cli -t stores && scripts/testenv up && bun run test:t2 -t "remote round
trip"`

### Report
`.orchestrate/reports/task-8.md`, with offload and onload times for the fixture on each kind.

### Stop condition
Both remote kinds round-trip byte-identically, and invariants 1 to 3 hold after the cut.

---

## Task 9 — `store add | list | test | remove`, and `init`  `T2`

### Objective
Stores can be set up, listed, tested and forgotten from the CLI, and `init` gets M2's setup work.

### Context
`docs/DESIGN.md` "CLI design" (`store …`, `init`), "Core API" (`stores.list`, `stores.test`), "Roots → Setting roots
up"; D22, D68, D70, D85; Q4, Q8, Q10, Q11.

### Scope
Owns `packages/cli/src/commands/store.ts`, the store part of `packages/cli/src/commands/init.ts`, the
`stores.list` and `stores.test` parts of core, the per-store state file `~/.local/state/plainport/stores/<id>.json`
(Q4), and the regenerated `plainport.json`, `schemas/` and completions.

- **`store add <name> --kind sftp|s3 …`.** It takes flags for each field (`--host`, `--path`, `--endpoint`,
  `--bucket`, `--region`, and the secret references). With `--secret-stdin` it saves the password into the Keychain
  (Q10). It writes `managed.toml` under its lock and sets the store up: identity, restic repository, and the root
  claim with `--root`. It records the id, and re-running it finishes a setup that stopped half way.
- **`store list`** reads only: kind, location, id, the root served and the last test. `--probe` also checks
  reachability.
- **`store test`** checks reachability, credentials, identity, that the restic repository opens, and the probe
  write, read and delete. It measures `createIfAbsent` and latency, and records the result in the per-store file. A
  refused delete reports `append-only`.
- **`store remove`** behaves as Q8 says.
- **`init`** shows folder sizes (D70), and re-pointing a pinned name is tightened as Q11 says.
- New findings, such as `store.in-use` and `store.root-contested`, are added to the catalogue with fixes.

### Tests first
- Each command's risk gate and its `--json` schema.
- `store add` is idempotent and leaves no secret in `managed.toml` (the canary).
- `store remove` refuses while a root pins the store.
- `store test` on a memory store that refuses deletes reports `append-only`.
- `init --store-path` to an unreachable path for a pinned name refuses and writes nothing.
- T2: `store add` and `store test` against MinIO and SFTP.

### Verification
`bun test packages/cli -t "store|init" && bun run contract && git diff --exit-code plainport.json schemas/ &&
bun run test:t2 -t "store add"`

### Report
`.orchestrate/reports/task-9.md`

### Stop condition
The commands are registered with their risk classes, `docs/machine-contract.md` agrees, and the T2 tests are green.

---

## Task 10 — Sealed catalog events  `T2`

### Objective
On a sealed store, catalog events are XChaCha20-Poly1305 ciphertext that only a device able to open the repository
can read or forge.

### Context
ADR-0009, ADR-0013; `docs/DESIGN.md` "Security and encryption" (Catalog row), "Stack" (`@noble/ciphers`); D45, D74,
D86; Q3, Q4.

### Scope
Owns `packages/core/src/catalog/seal.ts`, the seal path of `appendEvent` and of the mirror sync in
`packages/core/src/catalog/log.ts`, an Engine port method `catalogKey(ctx)` (`engine-restic` derives the key and never
returns the master key), `store add --seal | --no-seal`, the `sealed` column of `store list`, and the seal pin in the
per-store file.

- **The format, key and default** are those of Q3. The associated data is the event's key name, and each event gets
  a random 24-byte nonce.
- **The seal pin** is set at `store add` and checked on every read. On a store pinned as sealed, a plaintext event
  is left out (`catalog.unsealed-event`, a warn that makes the fold uncertain by D86), and a failed open is
  `catalog.seal-failed`. A store not pinned as sealed that serves sealed events refuses, as `store.identity-changed`
  does.
- **The mirror** holds opened events in files with mode `0600`.

### Tests first
- Seal and open round trip.
- One flipped bit, a swapped key name and a wrong key each fail and are left out.
- A plaintext event injected into a sealed store is not folded.
- Invariant 4 holds over a sealed memory store (fast-check, 1,000 cases).
- The engine's `catalogKey` never prints the master key (the canary).
- T2 on MinIO: the bytes stored under `meta/v1/events/` contain no project ULID, path or root key.

### Verification
`bun test packages/core -t seal && bun test packages/engine-restic -t catalogKey && bun run test:t2 -t sealed`

### Report
`.orchestrate/reports/task-10.md`, with whether `restic cat masterkey` worked on 0.17.1 and 0.19.1, or why key (b)
was used.

### Stop condition
`s3` and `sftp` stores seal by default, `local` stays plain, and `DESIGN.md` documents the format.

---

## Task 11 — The catalog over remote stores  `T2`

### Objective
The catalog read path works over remote stores: a fast mirror sync, offline `ls`, doubt about skipped newer events,
and one home store per project.

### Context
`docs/DESIGN.md` "Catalog and data model" (the one read path), "Project lifecycle" (what `ls` and `status` show);
D41, D45, D66, D86; `docs/HANDOFF.md` "Known limits" (a doubtful catalog); Q9.

### Scope
Owns `packages/core/src/catalog/{log.ts,head.ts}`, `packages/blob-fs/src/mirror.ts`,
`packages/core/src/status/projects.ts`, and the `ls` and `status` commands.

- **The sync** is one listing and one batch read of the missing events, with a deadline. A write path always reads
  fresh, and a stale read refuses (existing; proven here on remote kinds).
- **Offline.** With the store cut, `ls` and `status` read the mirror marked `stale` with its last sync, or
  `never-synced`.
- **D86, strengthened.** A skipped state-changing event whose ULID time is newer than the head's event makes the
  head uncertain, even without the stub's or the registry's evidence. A second device hits this by construction.
- **The home store (Q9).** An offload or onload whose project's head lives on another set-up store refuses
  (`store.history-elsewhere`).
- **Several stores.** `ls` merges every set-up store's catalog by project id. A project found in two catalogs gets
  the open condition `several-stores`, preferring the store the registry names.

### Tests first
- A skipped newer event makes onload refuse with `catalog.head-uncertain` on a fresh device.
- `store.history-elsewhere` on an offload with `--store` naming the other store.
- T2: `ls` with Toxiproxy down shows `stale` and the last sync time.
- Syncing 1,000 events from MinIO starts two rclone processes (count assertion), and the time is recorded.

### Verification
`bun test packages/core -t catalog && bun test packages/cli -t "ls|status" && bun run test:t2 -t "catalog remote"`

### Report
`.orchestrate/reports/task-11.md`, with sync times for 100 and 1,000 events.

### Stop condition
All of the above is green, and `DESIGN.md` "Catalog and data model" states the newer-event rule and the home-store
rule.

---

## Task 12 — Leases across devices

### Objective
Two devices see each other's leases: `status` and `ls` say who holds a project, and onload and offload warn, or block
under `strict`.

### Context
`docs/DESIGN.md` "Catalog and data model → Fold rules" (Lease), "Onload process" step 2, "Edge cases → Concurrency";
D40, D43, D54; invariant 5; Q14.

### Scope
Owns the lease view in `packages/core/src/status/projects.ts`, the lease finding in offload's plan
(`packages/core/src/saga/offload.ts`), the lease tests of `onload.ts`, `packages/core/src/testing/invariants.ts` (made
to work over several homes), and a new `test/support/two-devices.ts`. That helper runs two sandboxed instances, with
two HOMEs and two device ids, on one store, and Tasks 13 to 18 use it.

- **The view.** It shows the holder (this device, or `device <short id>`), since when, and the open condition
  `leased-elsewhere`, with `next` saying what to do.
- **Offload.** When another device holds the lease further along the chain, the plan carries `lease.held` (warn,
  allowable). Under `strict` it blocks with exit 8.
- **Onload.** The lease check reads the store fresh; a stale read refuses.

### Tests first
- B onloads while A holds the lease: a warning under `warn`, exit 8 under `strict`.
- B's `status` names A's device.
- An offload from the copy that does not hold the lease warns.
- Invariant 5 holds across both homes after every two-device test, and the helper's own test shows a deliberately
  double lease is caught.

### Verification
`bun test packages/core -t lease && bun run test:t1 -t "two devices"`

### Report
`.orchestrate/reports/task-12.md`

### Stop condition
The two-device helper is exported, and lease warnings, `strict` and the view are green on a local store (T1).

---

## Task 13 — The head check at commit, and forks after the commit

### Objective
A race between two devices always ends with both snapshots kept and nothing deleted. A fork found at the commit or
right after it keeps the folder.

### Context
`docs/DESIGN.md` "Offload process" step 7 and "Journal steps", "Conflict at step 7"; D24, D41, D51, D52, D61; Q6;
`test/crash-matrix/`.

### Scope
Owns `packages/core/src/saga/{offload.ts,release.ts}` and `packages/core/src/recover/recover.ts`. The crash-matrix
rows come by enumeration.

- **The head check at commit** reads the store fresh, never the mirror (existing; proven across two homes).
- **Q6 (b).** Release reads the catalog again right before the rename. Any new step, journal field or after-effect
  seam is exported, with its recover rule. `DESIGN.md` "Journal steps" and `docs/machine-contract.md` (the
  `fork-after-commit` data kind) are updated.
- **A deterministic race** comes from `PLAINPORT_TEST_PAUSE_AT=offload.verified` on both instances: both pass the
  head check, then both commit.

### Tests first
- **Sequential:** the second offload gets `catalog.head-moved` (fork, exit 8), its folder kept.
- **Concurrent:** both commit, both find the fork after the commit, both folders are kept with no stub, the project
  is `conflicted`, and each snapshot restores byte-identical to its folder.
- **Crash rows:** killed between the re-read and the rename; the store unreachable at the re-read, which leaves the
  journal pending and the folder kept; and `recover` with the store back.

### Verification
`bun test packages/core -t "offload|recover" && bun test test/crash-matrix && bun run test:t1 -t "race|crash"`

### Report
`.orchestrate/reports/task-13.md`, with the new row count.

### Stop condition
Both race orders are green, every new step has crash rows in both variants, and invariants 1 to 5 hold after each.

---

## Task 14 — The `resolved` event and `plainport resolve`

### Objective
`plainport resolve` settles a conflicted project by keeping one head. The fold reads its event, and the other
snapshots stay restorable.

### Context
ADR-0009; `docs/DESIGN.md` "Catalog and data model" (event list, fold rules), "CLI design" (`resolve`), "Offload
process → Conflict at step 7"; D17, D41, D44, D60, D74; Q5, Q7.

### Scope
Owns `resolved` in `packages/core/src/catalog/events.ts`, its rule in `fold.ts`, a new
`packages/core/src/saga/resolve.ts`, and the command in a new `packages/cli/src/commands/resolve-conflict.ts`. The
existing `commands/resolve.ts` is the project-argument resolver and stays as it is.

- **The event** (`v: 1`, Q5): `{type: "resolved", project, root, path, keep, over: [the tips it settles]}`.
- **The fold.** A fork whose tips all lie in `over ∪ {keep}` is settled, and the head is `keep` or what is made from
  it. A later fork conflicts again. An `over` or `keep` the catalog does not hold makes the head incomplete (D41).
- **The command.**
  - `resolve <project>` without `--keep` lists the heads (device, time, size, base) and the exact commands, and
    exits 0.
  - With `--keep` it is `confirm`. It takes the project lock and appends the event, and a re-run is a no-op.
  - When this device holds a working copy, `--keep` must name that copy's snapshot (Q7); otherwise it refuses, and
    the fix names `restore --snapshot` and how to keep the copy's work.
  - On a project that is not conflicted it exits 0 and says there is nothing to resolve.

### Tests first
- Fold properties (fast-check, 1,000 cases): any permutation with `resolved` events gives the same state; resolving
  then forking again conflicts.
- The command's gate and schema.
- Across two homes: a fork, then `resolve --keep` on A, then B's onload gets the kept snapshot, and `restore
  --snapshot <dropped>` still works.

### Verification
`bun test packages/core -t "fold|resolve" && bun test packages/cli -t resolve && bun run contract && git diff
--exit-code plainport.json schemas/`

### Report
`.orchestrate/reports/task-14.md`

### Stop condition
The event, the fold rule and the command are green, and `DESIGN.md` and `docs/machine-contract.md` agree.

---

## Task 15 — `refs/plainport/theirs/<snapshot>` through a temporary index

### Objective
While a conflict stands, the other copy shows up in this repository as a commit you can diff and cherry-pick from,
without touching your index, branches, working tree or secrets.

### Context
`docs/DESIGN.md` "Offload process → Conflict at step 7", "Prior art → herdr's Teleport" (temporary index); D33, D34,
D58, D60, D87; Q7.

### Scope
Owns a new `packages/core/src/saga/theirs.ts` and the `--theirs` part of the resolve command. `resolve` writes the
refs by default when this device holds the working copy.

- **Building the commit.**
  - Restore the other head into a staging folder beside the project. Restore is unjournaled, as D60 has it, and
    cleanup goes through the guarded deleter.
  - Fetch its branches read-only into `refs/plainport/theirs/<snapshot>/heads/*`, so its unpushed commits arrive.
  - Then, with `GIT_INDEX_FILE` set to a temp file and `--work-tree` set to the staging folder: `add -A` (which
    honours the tree's ignore rules and this repository's `info/exclude`), `write-tree`, then `commit-tree` with
    their `HEAD` as the parent, and `update-ref refs/plainport/theirs/<snapshot>`.
- **Ignored files** that differ, such as `.env`, are listed in the output, never committed.
- **Isolation.** Git runs with hooks off (`core.hooksPath=/dev/null`), signing off, and D34's config isolation.

### Tests first
- A canary value in the other copy's `.env` never appears in `git cat-file --batch-all-objects`.
- The user's index bytes, `HEAD`, branches, stash, config and `git status --porcelain=v2` are identical before and
  after.
- `git diff HEAD refs/plainport/theirs/<id>` shows the other side's edit.
- The other side's unpushed commit is reachable.
- A crash mid-build leaves only a staging folder, which `gc` removes.

### Verification
`bun test packages/core -t theirs && bun run test:t1 -t theirs`

### Report
`.orchestrate/reports/task-15.md`

### Stop condition
All the tests are green, and `help resolve` explains the ref and how to use it.

---

## Task 16 — The crash matrix over remote stores, and network faults  `T2`

### Objective
Both sagas, including M2's new steps, survive death at every journal step against remote stores and with the store
cut at the worst moments.

### Context
ADR-0017; `docs/DESIGN.md` "Testing and fault injection"; `CONTRIBUTING.md` "The crash matrix"; Tasks 13 to 15.

### Scope
Owns `test/crash-matrix/` (a store dimension and a fault dimension) and `test/support/invariants.ts` usage across
homes.

- The subprocess variant runs every row against MinIO and SFTP (T2), as well as the local store (T1).
- **The fault dimension** uses Toxiproxy to cut the store at `commit.start`, during the event append, at release's
  re-read (Q6), and during onload's restore. `recover` runs once with the store still down, when the operation is
  pending and nothing is deleted, and once with it back.
- `PLAINPORT_CRASH_MATRIX_DAMAGE=1` still fails every row, on every store kind.

### Tests first
The matrix is the test; new rows come from the sagas' exports.

### Verification
`bun test test/crash-matrix && bun run test:t1 -t crash && scripts/testenv up && bun run test:t2 -t crash`

### Report
`.orchestrate/reports/task-16.md`, with row counts per variant, store kind and fault.

### Stop condition
Every row is green in every variant, and the damage mode bites on every store kind.

---

## Task 17 — T3: real buckets and the Mac mini  `T3`

### Objective
Prove M2 against real bucket semantics and the Intel hub, or record exactly why it could not run.

### Context
ADR-0018 (T3), ADR-0013; `docs/ROADMAP.md` "Open items"; Q13; the owner's inputs below.

### Scope
Owns `scripts/testenv.ts t3`, the `test:t3` script (`PLAINPORT_TEST_TIER=3`, `describeT3`), `test/t3/`, and the T3 rows
of the gate report.

- **References.** `.testenv/t3.env` (gitignored) holds only `op://` references. Values are read with `op read` into
  child environments at run time.
- **Prefixes.** Every run works under `plainport-t3/<run ulid>/` in each bucket. Cleanup deletes only that prefix,
  with the scoped key, and the buckets' lifecycle rule is the backstop.
- **Buckets:**
  - the store contract on R2 and on B2 (S3 API);
  - rclone's `If-None-Match` on R2 (a real conditional write) and on B2 (expected to be rejected), with the
    capability table updated;
  - offload and onload round trips with times;
  - sealed events.
- **The mini.**
  - `ssh mini` with `BatchMode=yes`, and `orb version` (ADR-0018's open check).
  - The darwin-x64 build, copied to `~/plainport-t3/<run>/` and not installed: `plainport --version`, and a fixture
    round trip against a temp local store there.
  - The two-Mac race (laptop and mini on R2, Q13), or Q13's (c).
  - Cleanup removes only the run folder the harness made, after checking its marker file.

### Tests first
The harness is tested at T0 with fakes. It refuses to start without every reference, and it refuses a prefix outside
`plainport-t3/`. Cleanup touches only the run's prefix.

### Verification
`scripts/testenv t3 check` (inputs present, `op` signed in, `ssh mini` reachable), then `bun run test:t3`.

### Report
`.orchestrate/reports/task-17.md`, with each check: passed, failed (filed and fixed before Task 18) or pending (the
missing input named).

### Stop condition
Every T3 check passes; or the inputs are missing, and the task ends `pending` with the exact list. That is not a
failure: the gate goes on at T2.

**What the owner provides for T3.**
- 1Password items, referenced as `op://`, for:
  - an R2 bucket (location hint `weur`) with an access key id and secret scoped to it, and its S3 endpoint;
  - a B2 bucket in EU Central with an application key id and key scoped to it, and its S3 endpoint;
  - a restic test password.
- A lifecycle rule on both buckets expiring `plainport-t3/` after seven days.
- `op` signed in on the laptop.
- The Mac mini online in Tailscale, with `ssh mini` working non-interactively, and an answer to Q13.

---

## Task 18 — Gate: the two-Mac race, and release v0.2.0

### Objective
Prove the gate: two sandboxed instances racing on one store end in `conflicted`, never in lost work. Then release
v0.2.0.

### Context
`docs/ROADMAP.md` M2 gate; ADR-0017, ADR-0019, ADR-0020; `CONTRIBUTING.md` "Releases".

### Scope
Owns `scripts/gate-m2.ts` and its test, the gate report, and the release commits.

- **Store kinds.** The local store (T1), MinIO and SFTP (T2), and R2 (T3) when Task 17 passed.
- **Scenarios**, each followed by the Task 3 tree comparison and invariants 1 to 6 across both homes:
  1. The concurrent race (barrier at `offload.verified`): `conflicted`, both snapshots restorable byte-identical to
     their folders at verification, both folders kept, no stub.
  2. The sequential race: the second offload forks with exit 8, and its folder is kept.
  3. Leases under `warn` and under `strict`.
  4. `resolve` with the theirs ref, then `resolve --keep`, an offload, and onload on the other device: `local` and
     byte-identical.
  5. A kill at `commit.start` on one side during the race, then `recover`: still no lost work.
- **Times.** One M1 demo project's offload and onload times on each store kind.
- **The full suite** at T0, T1 and T2, plus contract freshness and gitleaks.

### Tests first
Not applicable: this task runs the gate. The script itself is tested on a fixture with fakes.

### Verification
`bun scripts/gate-m2.ts --tiers 1,2[,3]`, `bun test`, `bun run test:t1`, `scripts/testenv up && bun run test:t2`, and
`bun run contract --check`.

### Report
`.orchestrate/reports/task-18.md`, plus an M2 summary for `docs/HANDOFF.md`: results per store kind, T3 status,
times, and known limits, including Q5's "v0.2 stores need v0.2 on every device".

### Stop condition
Every scenario passes on every available store kind, and the full suite is green. Then the orchestrator:
1. merges into `main` and confirms CI is green, including the T2 job and the restic matrix;
2. cuts release `v0.2.0` (ADR-0020) and sets `0.3.0-dev`;
3. marks ADR-0023 accepted;
4. updates `docs/HANDOFF.md`, `docs/ROADMAP.md` and `CHANGELOG.md`.
