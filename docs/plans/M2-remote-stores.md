# M2 · Remote stores: orchestrate plan

Status: **draft, waiting for the owner's approval.** Revised twice from gpt-6-astra's architecture reviews: round 1
(`.orchestrate/review-m2-plan-astra.md`: 2 Critical, 16 Important, 1 Minor, 11 missing tasks) and round 2
(`.orchestrate/review-m2-plan-astra-r2.md`: 6 Important, 2 Minor, R2-1 to R2-8). The tables at the end map every
finding to where this plan resolves it. Run on branch `m2-remote-stores` once the owner decisions
below are answered:

```text
/orchestrate docs/plans/M2-remote-stores.md strategy=staged review=dual
```

**Milestone gate.** Two sandboxed plainport instances racing on one store (the two-Mac race) end in `conflicted`,
never in lost work. "Never lost" means what Q16 makes the owner sign: every verified snapshot stays in the store and
in the catalog, and a folder is deleted only on the terms Q16 states. The gate runs on a local store (T1), on MinIO
and an SFTP container (T2), and on Cloudflare R2 and Backblaze B2 (T3) when the owner's buckets and the Mac mini are
available. Without T3 the gate passes as a stated **T2 result**: HANDOFF lists every backend claim that stays
unverified (R2's and B2's measured semantics, the darwin-x64 hub) as pending.

**Before Task 1 (owner).** Answer the decisions below; the orchestrator records the answers as ADR-0023 ("M2
decisions") in the commit that approves this plan, and amends ADR-0022's D74 as Q1 says. Read the flagged decisions in
ADR-0022, since M2 builds on them. The real-project gate with hydration on (D78) is still suggested, not required.

---

## Owner decisions needed

Each question is a place where `DESIGN.md` is silent or ambiguous, or where M2 changes a persisted format or the
public contract. For each: the options, the planner's view, astra's view, and one final recommendation. **Blocks**
names the first task that stops with `DESIGN_CONFLICT` while the question is open.

### A. Formats, compatibility and the contract

**Q1. Correct D74's wording.** *Blocks Task 7.* D74 says that after v0.1.0 a catalog change is "additive-optional or
bumps `v`". M1's event schemas are strict objects, so an event with any field v0.1.x does not know fails to parse and
is skipped (`catalog.event-skipped`); an unknown type is skipped too. Skipping fails closed only where D86 notices it
(the stub's or registry's snapshot is named by no readable event); a fresh device can accept an older readable head.
- (a) Reword D74: on `v: 1` an added field or type is invisible to v0.1.x readers, not compatible with them;
  compatibility between versions is enforced by the store's format (Q2), never by additivity.
- (b) Keep the wording and make v0.2 readers lenient about unknown fields (D16 keeps inputs plainport parses strict).

Planner: (a). Astra: the compatibility claim is overstated and mixed writers need an explicit exclusion policy, which
(a) plus Q2 provides. **Recommendation: (a).**

**Q2. Mixed versions, adopting M1 stores, and rolling back.** *Blocks Tasks 7, 8 and 19.* Nothing today stops a v0.1.x
device from reading, or writing to, a store a v0.2 device writes M2-only content to. And `store.json` stops only
processes that start after it changes: a v0.1.1 offload that passed its checks before the upgrade can still append and
release afterwards (astra R2-1).
- (a) **Store format 2, a constrained upgrade, and rollback-proof retention.**
  - *Format 2.* `meta/v1/store.json` at `v: 2` holds the store's identity, repository location, catalog seal policy and
    format. v0.1.x refuses a `store.json` it cannot parse, so format 2 stops every v0.1.x process that starts after it.
    Every store v0.2 creates is format 2. An M1 local store stays format 1, and v0.2 writes nothing to it that v0.1.1
    cannot read until `store upgrade`. On a format-1 store, `resolve` and sealing refuse with `store upgrade` as the
    fix.
  - *The upgrade.* `plainport store upgrade <name>` (`confirm`) runs only when the store is quiescent, and refuses
    otherwise (`store.not-quiescent`, naming the reason). The checks it can enforce:
    1. no open journal and no live plainport lock on this device;
    2. no lease, and no offload or onload started but not finished, held by another device in the store's catalog;
    3. no event from another device within a quiet window (default 15 minutes) before the upgrade, re-checked after
       writing a `meta/v1/upgrade-intent.json` marker that v0.2 refuses to bootstrap or offload over.

    What it cannot see, the owner attests with `--others-stopped` (the fix lists the devices the catalog names): every
    other device has no plainport running, detached deletes included.
  - *The residual.* A v0.1.1 process on another device that held no lease (a first offload) and outlasts the window.
    Its event is M1-shaped, so v0.2 still reads it (Q11), and it releases as M1 does: its snapshot is verified, but Q16's
    grace does not apply to it. The owner signs this residual with Q16's.
  - *Rollback.* Every trash v0.2 holds for Q16 (in grace or `conflict-retained`) is journaled at a step v0.1.1 does
    not know, `offload.release.held`. v0.1.1's recover leaves an unknown step pending, and its `gc`, `gc --now` and
    housekeeping never delete a trash whose journal they cannot settle. So a rollback cannot delete held trash. Task 7
    proves this with the real binary.
- (b) Say in HANDOFF that every device must run v0.2.
- (c) Bump every event M2 writes to `v: 2`.

Planner: (a). Astra, round 1: "HANDOFF prose is not a compatibility gate". Astra, round 2: format 2 is useful, but
claiming old-client exclusion needs upgrade quiescence and rollback deletion exclusions; (a) now has both, and Task 7
tests them with v0.1.1 paused before its append and before its release. **Recommendation: (a), accepting the stated
residual.**

**Q3. The `resolved` event type.** *Blocks Tasks 12 and 25.* M2 writes one new event type.
- (a) `resolved` at `v: 1`, written only to format-2 stores (Q2).
- (b) `resolved` at `v: 2`.

Planner: (a), with revision 1's rationale ("v0.1.x fails closed") withdrawn, since Q2 is what keeps v0.1.x away.
Astra: a new type can keep `v: 1`; the rationale was wrong. **Recommendation: (a).**

**Q4. Where this device keeps per-store facts** (the seal pin, the measured semantics, the last test). *Blocks Task
9.* `registry.json` is strict `{v: 1}`; v0.1.1 refuses any added field, which would break `scripts/install --rollback`.
- (a) `registry.json` v2.
- (b) A sidecar per store, `~/.local/state/plainport/stores/<store id>.json` (`{v: 1, …}`), which v0.1 never reads.
  It is written atomically under a lock, and its measured facts are invalidated when the store's endpoint, access kind,
  rclone or restic version changes.

Planner and astra: (b), with astra's atomicity and invalidation rules. **Recommendation: (b).**

**Q5. Small persisted formats** (revision 1's Q12). *Blocks Tasks 1 and 2.*
- (i) **Boot session for trash claims.** Revision 1 added a field to `<op>.claim`. Astra: M1's strict claim parser
  treats an unreadable claim as gone, so after a rollback v0.1.1 would ignore a live v0.2 deleter. Instead, the
  boot session goes into a sibling file, `<op>.claim.boot`, which v0.1.1 never reads; the claim keeps M1's shape.
- (ii) **The restic tag `plainport:mode=<octal>`**, so `onload --snapshot S` under an uncertain head can set the
  folder's mode. Planner and astra agree.
- (iii) **Fingerprint v3** for git maintenance locks. Astra: as specified it fails its own test (the lock changes its
  parent folder's mtime and ctime), it leaves the lock in the snapshot, and `fp` is a published closed value
  (`fp: 2` in the plan output schema, and in M1's journal schema), so v3 is a contract change and breaks rollback of
  open journals. Options: defer to M5 with a full transient-artifact policy across scan, fingerprint, backup and
  verification; or build it now with `fp: 2 | 3` and a `plainport_json` decision. Today such an offload retries
  once and refuses: nothing is lost.

**Recommendation: (i) as a sibling file, (ii) yes, (iii) deferred to M5.**

**Q6. Closed public values.** *Blocks Task 23.* A fork found after the commit needs to say so in offload's exit-8
data, whose `kind` is the closed enum `"fork" | "diverged-after-commit"`.
- (a) A new enum value `"fork-after-commit"`: a contract change.
- (b) Keep `kind: "fork"` and add an optional `detail: "after-commit"`, which published outputs allow (D16).

Planner: (b). Astra: preserve existing public values with optional detail where possible. **Recommendation: (b).**

### B. Stores, secrets and the catalog

**Q7. S3 store credentials and layout.** *Blocks Tasks 15 and 18.*
- (a) One reference bundling the password and the key pair.
- (b) Separate references: `secret` (restic password), `accessKeyId`, `secretAccessKey`, all required for `s3`, plus
  optional `region` and `path` (a prefix inside the bucket).
- (c) The key pair from the AWS environment and profile chain.

Planner: (b). Astra: agree; validate that restic and rclone reach the same location, and state whether temporary
session credentials are supported. **Recommendation: (b); temporary session credentials (`AWS_SESSION_TOKEN`) are not
supported in M2.** A config using these keys is refused by v0.1.x, so a rollback means removing the store's lines.

**Q8. Stores of unknown consistency.** *Blocks Task 6.* Astra: "S3-compatible", "has no conditional write" and
"eventually consistent" are different properties, and the claim protocol and the catalog both rely on visibility,
whole-write publication and complete listings.
- (a) Every backend has a **semantics profile** (Task 6) of typed properties, each with its evidence (`measured`,
  `documented`, `asserted`):
  - read-after-write and list-after-write visibility (yes or no);
  - listing completeness (yes or no);
  - publication (`atomic-put`, `temp-then-rename` or `in-place`);
  - conditional create (yes or no);
  - durability on acknowledgement (`durable`, `acked-unsynced` or `unknown`);
  - cancellation (`never-lands-late` or `may-land-late`).

  Each **operation** has its own eligibility predicate over that profile (Task 6's table):
  - reading the catalog needs only a working listing;
  - appending an event needs whole publication and read-after-write;
  - an election needs a conditional create, or visibility both ways plus complete listings;
  - releasing a folder after a commit also needs durability admitted by Q21.

  A missing conditional create is not a weakness on its own: it only routes elections to the fallback. A store that
  fails a predicate refuses that operation (`store.semantics-unknown`, naming the property) and stays usable for the
  others. The owner may assert a property per store in config, which `store test` reports as asserted.
- (b) Allow any store, with a warning.

Planner and astra: (a); astra's round 2 asked for typed properties and per-operation eligibility (R2-6).
**Recommendation: (a).**

**Q9. Bootstrap and the root claim.** *Blocks Tasks 8 and 18.* Astra's Critical: two devices that both see no
repository can both run `restic init` at one location; restic's absence check and its key and config writes are not
one transaction, so two master keys can land in one repository. Revision 1's claim protocol (its Q2 c) does not
cover this, and needs stronger consistency than it stated.
- (a) One `repo/` per store, and an exclusive bootstrap lock that needs a conditional create; stores without one cannot
  be set up by plainport.
- (b) **Per-attempt repositories and an elected publication.** Each bootstrap attempt initialises restic at its own
  location, `repos/<attempt ulid>/`, so two initialisers never write the same repository. The attempt that wins the
  election publishes `store.json` v2 naming its repository. Elections use a conditional create where Task 17 proves
  one, and otherwise the sole-candidate rule on a store whose profile is strong (Q8). A loser stops, leaves its
  repository in place, never writes, and is listed by `store test` with the manual cleanup. Bootstrap is journaled
  and recoverable. The root claim uses the same election. Removing a contested candidate by hand is safe only after
  stopping plainport on every device, and the fix says so.
- (c) Revision 1's claim protocol, with no bootstrap protocol.

Planner: (b). Astra: Q2(c) disagreed as written; the fix is an exclusive, recoverable bootstrap protocol covering
identity, repository initialisation, root claim and seal configuration. Round 2 agrees, noting that contention may
produce no winner. **Recommendation: (b).**

The fallback can safely end with **no winner**: both candidates visible, both refuse. The store then needs the
quiesced manual cleanup before anyone retries. M1 local stores keep `repo/`; a format-2 `store.json` can also name
`repo/`.

**Q10. Sealed catalog events.** *Blocks Tasks 10 and 20.*
- *Key:* (a) HKDF-SHA256 from the repository's master key (`restic cat masterkey`); (b) a random per-store key held as
  one more secret reference; (c) HKDF from the repository password, which breaks with M3's per-device keys.
- *Policy:* authoritative per store, in `store.json` v2 and fixed at bootstrap, and pinned by each device at first
  contact, so a store that later flips the policy is refused.
- *Migration:* sealing an existing plaintext store in place is refused in M2. An M1 store stays plain; a store is
  sealed only when it is created.

Planner: (a). Astra: agree in principle; specify the exact derivation, the envelope, a version independent of the
event's, and rotation before freezing; never fall back silently to (b) for an existing store. **Recommendation: key
(a) under Task 10's versioned spec, policy and migration as stated, sealed by default for new `s3` and `sftp` stores.
If the spec finds (a) unworkable, the task stops and the owner decides (b); there is no silent fallback.**

**Q11. Snapshot locations by store id, not alias.** *Blocks Task 9.* `stored` maps a store's name to its restic
snapshot id, and onload looks up `stored[<this device's name>]`, so two devices calling one store `archive` and `nas`
cannot read each other's snapshots.
- (a) **Location by containment.** Until M3's replication, every snapshot event has exactly one `stored` entry, and
  that entry always describes the store whose catalog holds the event. A reader therefore takes the location from the
  store it read the event from and never interprets the key. Writers keep the rule:
  - on format-2 stores the key is that store's id;
  - on format-1 stores it is M1's alias, for v0.1.1;
  - a test asserts both.

  An event with zero or several entries is skipped as unsupported and makes the fold uncertain until M3 defines
  multi-store locations, with a discriminator such as a `v` bump. No key is ever classified by its shape, so a
  ULID-shaped M1 alias is harmless.
- (b) Classify keys by shape: a ULID is a store id, anything else an alias. Astra R2-5: M1 allows any store name, so
  a ULID-shaped alias would be misread.
- (c) Defer to M3's replication.

Planner, round 1: (b). Astra: stable ids, yes; key shape, no; state and validate the containment rule. Planner, round
2: agree. **Recommendation: (a).**

**Q12. A project's home store before replication.** *Blocks Task 21.*
- (a) An offload to store S refuses unless S's catalog holds this copy's base (or it is a first offload)
  (`store.history-elsewhere`, naming the store whose catalog or mirror holds the base, or "unknown"). Stores are
  compared by id, and an offline home store still refuses by its mirror.
- (b) Allow a new history on another store.

Planner and astra: (a), by stable id and recorded provenance. **Recommendation: (a).**

**Q13. Store commands.** *Blocks Task 19.*
- `store list`: `read`.
- `store test`: `safe_write`. It writes, reads and deletes one probe key and reports `delete: denied | allowed |
  unreachable`. A denied delete is never reported as "append-only", which would need repository-wide proof (M3).
- `store add`: `safe_write`. It runs bootstrap or adopts an existing store, and sends only setup files.
- `store upgrade` (Q2): `confirm`.
- `store remove`: `confirm` and local only; it refuses `store.in-use`.

Planner and astra agree, with astra's wording for `store test`. **Recommendation: as listed.**

**Q14. Secret providers.** *Blocks Task 15.* `keychain:<service>/<account>` (read with `security
find-generic-password -w`, written only by `store add --secret-stdin` through `security -i` on stdin) and `op:` (`op
read`). `se:` and `bw:` stay refused. Astra: agree, after the runner's sensitive mode, with bounded waits for prompts and
safe quoting of `security -i`'s command line. **Recommendation: both, after Task 5, with a 30-second deadline on any
provider call.** A Keychain GUI prompt that is not answered in time is `store.secret-missing`.

**Q15. `init --store-path` re-pointing an unreachable pinned name.** *Blocks Task 19.* Planner and astra: refuse it.
Re-pointing an unplugged disk stays possible through `config.toml`, checked at use (D68). **Recommendation: refuse.**

**Q21. Durability: which stores may delete a local folder after a commit.** *Blocks Tasks 6, 17 and 24.* Astra
(R2-6): S3 providers document that an acknowledged write is durable. rclone's SFTP backend acknowledges after the
server's rename, with no fsync, so a server crash shortly after the acknowledgement can lose the event or restic's
packs while the local folder is already gone.
- (a) Release (the delete) only on `durable` stores. SFTP stores can then take checkpoints and onload, but every
  offload keeps its folder.
- (b) **Admit `acked-unsynced` stores with proof that the write survived.** Before Q16's checked delete, re-read the
  event and check that restic still lists the snapshot (`restic cat snapshot`), no earlier than the grace period after
  the commit. Missing data keeps the trash and reports `store.lost-write`. The boundary, written into DESIGN: a server
  that loses acknowledged data later than the grace period (a disk failure, say) is out of scope, as it is for any
  single store.
- (c) Admit SFTP with no extra check.

Planner: (b). Astra did not pick an option: state the fault model, the evidence and any owner-approved exception, and
make the gate refuse unsupported profiles. **Recommendation: (b).** The same proof runs on every remote store, since
it costs one read after the grace. The gate checks that a store failing the predicate refuses offload's release.

### C. Races, leases and conflicts

**Q16. What M2 promises in a race.** *Blocks Tasks 14, 23, 24 and 29.* Astra: no finite sequence of reads closes the
gap between a device's last read and its rename. A appends, re-reads and sees only itself, then B appends; A releases
and B keeps its folder. Revision 1's "both folders kept" cannot be guaranteed.
- (a) **Snapshots only.** Every verified snapshot is kept in the store and the catalog. A device keeps its folder when
  its own operation sees the fork before its rename (at the commit or at the re-read); otherwise its work lives only
  in its snapshot.
- (b) **(a) plus a conflict grace.** On a remote store, release still renames into the trash and writes the stub, but
  the trash is held for a grace period (default 15 minutes, `offload.conflictGrace`). Every delete entrance (the
  detached delete, housekeeping, `gc`, `recover`'s delete-trash) reads the catalog fresh before deleting. A fork that
  names the operation's snapshot keeps the trash as `conflict-retained`; an unreachable store keeps it and tries
  later. The promise: **a released folder is deleted only after a catalog read, taken at least the grace period after
  its commit, showed no fork naming its snapshot.** The residual: a fork appended after that read. A retained trash
  comes back through M1's reuse path: once `resolve` keeps its snapshot, `onload` renames it back.

  Before the rename, a fork keeps the folder in place. After the rename, the trash is held under a durable
  `offload.release.held` journal step, which settles nothing and blocks nothing but a second release. Task 24 gives
  the whole state machine (astra R2-3).
- (c) Exclusive coordination with fencing. This needs a conditional write on every store, so not in M2.

Planner: (b). Astra: keep the extra check, but have the owner agree to a narrower guarantee or design coordination,
and specify behaviour after the rename, after the stub and during delayed deletion. (b) does all three.
**Recommendation: (b), with the promise and the residual written into DESIGN and HANDOFF as the owner signs them.**

**Q17. What a lease is.** *Blocks Tasks 14 and 22.* Astra: two devices can onload at the same moment under `strict`,
each seeing no holder; the fold then picks one lease, but both commands succeeded.
- (a) **Advisory.** A lease is the fold's single selected holder. `warn` allows a second working copy; `strict` refuses
  an onload when a holder is observed at its fresh read, but does not exclude a simultaneous one. Invariant 5 becomes
  "the fold names at most one holder, and a device that observed a holder under `strict` never onloads". The race
  that slips through ends, at offload, in a fork, never in a lost update.
- (b) Exclusive acquisition with fencing: a conditional write on every store.

Planner and astra: (a) for M2, stated plainly. **Recommendation: (a).**

**Q18. `resolve`, the theirs refs, and their risk classes.** *Blocks Tasks 12, 25 and 26.*
- **`resolve <project> --keep <snapshot>`** (`confirm`) appends `resolved {keep, over, supersedes}` under Task 12's
  causal model, which round 2 completed:
  - `over` = the tips its fresh read observed, minus `keep`, so the event it writes passes the validation it is
    judged by;
  - `supersedes` = every active resolution of the project that read observed;
  - resolutions form a dependency graph: invalid references, self-reference and cycles are invalid;
  - concurrent incompatible resolutions stay conflicted until one supersedes both;
  - every kept snapshot descending from a rejected tip and not itself rejected is a live tip again, whenever it was
    made, so late work conflicts again and never vanishes.
- **A working copy here.** While this device holds one, `--keep` must name that copy's recorded snapshot (Task 23).
  `resolve` is allowed while this project's only open journals are held trash (`offload.release.held`).
- **Read-only inspection** is `status` (each head's device, time, size and base).
- **The theirs refs** come from a separate `plainport compare <project>` (`safe_write`). It writes, in one atomic
  transaction, only `refs/plainport/theirs/<snapshot>/{worktree,index,HEAD}` and `…/heads/*`: sibling leaves, so
  the refs can coexist (astra R2-4).
- **`resolve --both`** waits for M3's fork format.

Planner: revision 1 put the refs inside `resolve`. Astra, round 1: agree with `--keep` only, given complete causality
and retained-copy bookkeeping; ref creation needs its own risk declaration. Astra, round 2: "disagree as written",
since production contradicted validation, `supersedes` had no rules, and the ref layout cannot exist. All three are
fixed as above. **Recommendation: as listed.**

**Q19. The T3 race across two Macs: the mini's test keys.** *Blocks Task 28.* (a) `op` signed in on the mini; (b) the
laptop resolves the references and passes the values over SSH on stdin into the child's environment; (c) race two
sandboxes on the laptop only. Astra: (b) when explicitly accepted, with test-scoped keys, a fixed stdin protocol, a
restricted child environment and a documented rotation step. **Recommendation: (b) with astra's conditions;
otherwise (c).**

**Q20. Confirm what M2 leaves out.** *Blocks nothing.*
- Breaking a stale lease (`lease-broken`). `warn` lets a second working copy exist; it never breaks or moves the lease.
- Device names in the lease view (ids until M3's pairing).
- `resolve --both`.
- B2's native `b2:` backend (M2 reaches B2 through its S3 API).
- The REST server as a store kind.
- Fingerprint v3 (Q5 iii).
- Proof that a device key cannot delete snapshots: invariant 6 in M2 means plainport issues no delete or overwrite of
  snapshots or events, and key-level proof arrives with M3's append-only keys.

Planner and astra agree. **Recommendation: confirm.**

---

**Every task, every time.**

- Read `AGENTS.md`, ADR-0023 (the answers above) and the ADRs and `docs/DESIGN.md` sections the task names before
  writing anything.
- Test-first (ADR-0017): write the failing tests that state the acceptance, run them, see them fail, then implement.
  Report the red run and the green run. A spec task's tests are executable: fakes, property tests and expected-outcome
  tables, not prose.
- **Never lose work.** The local folder is touched only in release, after a verified commit, and deleted only on Q16's
  terms. Every new saga step or after-effect seam is exported, so the crash matrix gains its rows by itself, and gets a
  rule in `OFFLOAD_RECOVERY`, `ONLOAD_RECOVERY` or the bootstrap table. A step without a rule stays pending.
- **One guarded deleter (D87).** Every recursive local delete goes through it. On a store, plainport deletes only its
  own probe keys and its own publication temporaries: never an event, a claim, a candidate, `store.json`, a repository
  or restic data. A recorder in the test harness fails any test whose rclone or restic calls include another delete,
  `forget` or `prune`.
- **One process runner,** and from Task 5 its sensitive mode for every call whose output may hold a secret
  (`security`, `op`, `restic cat masterkey`).
- **Errors are values.** Every new finding goes into the contract's catalogue and `docs/machine-contract.md` with its
  severity, exit code and fix.
- **Secrets stay references.** A secret value lives only in memory and in a child's environment: never in argv, a
  file, a log, a journal, config, a fixture, a finding or an error message. rclone remotes come only from environment
  variables, with `RCLONE_CONFIG` pointing at a file that does not exist. Every task that touches a secret or the
  master key runs Task 5's canary helper over files, output, events, findings and argv.
- **Sandboxes only.** Tests never touch the real home, the login Keychain or real buckets, except Task 28 (per-run
  prefixes, scoped keys). OpenSSH reads `~/.ssh` from the passwd home, not `$HOME`, so tests reach ssh only through
  Task 17's shim with `-F` pointing at a sandbox config.
- **Tiers are explicit.** Each suite is tagged T0, T1 (`describeT1`), T2 (`describeT2`) or T3 (`describeT3`). A T2
  or T3 suite that finds no environment fails, naming the command to run; it never skips silently.
- **Formats and contract follow Task 7's compatibility matrix.** A task that adds or changes a persisted format, a
  closed public value or a schema adds its row to the matrix and the matrix's test, including a run of the real
  v0.1.1 binary where the format can reach it. `plainport_json` stays 1; M2 adds no `ProjectState` value (D17); new
  conditions are fine, since that set is open.
- **Shared files.** `DESIGN.md` is section-owned: each task names the sections it edits, and two tasks marked
  `parallel-safe` never edit the same one. Only a task that changes the command registry runs `bun run contract`, and
  no two parallel tasks do. Only a task that adds a workspace package touches `bun.lock`, and no two parallel tasks
  do.
- Commit by path (`git add <your files>`), one or more small commits per task, message `m2(task N): …`.
- If the design is wrong or silent on something that matters, stop with `DESIGN_CONFLICT`; don't patch around it.
  `DESIGN.md` changes in the same commit as the behaviour, and so does ADR-0023 for a changed decision.
- Write the report to `.orchestrate/reports/task-N.md`: status, commits, tests added, red and green evidence, the
  tier each test ran at, decisions made, open questions.

**Tiers by task.**

| Task | Tiers | Needs |
| --- | --- | --- |
| 1–3, 5–14, 22–26 | T0, T1 | the laptop (Task 7 also builds v0.1.1 from its tag) |
| 4, 17–21, 27 | T0, T1, T2 | Docker or OrbStack (`scripts/testenv up`) |
| 15 | T0, T1 | macOS for the Keychain suite |
| 16 | T0, T1 | pinned rclone |
| 28 | T3 | the owner's R2 and B2 `op://` references, `op` signed in, `ssh mini` over Tailscale |
| 29 | T1, T2 (T3 when Task 28 passed) | as above |

**Dependency graph.**

- 1 → 2.
- 3, 4 and 5 run beside 1 and 2.
- {2, 3, 4, 5} → {6, 7} → 8 → 9 → {10, 12, 13}.
- 10 → 11, and {11, 12, 13} → 14.
- {5, 14} → 15 → 16 → 17 → 18 → 19 → 20 → 21 → 22 → 23 → 24 → 25 → 26 → 27 → 28 → 29.

`parallel-safe` groups: {1, 3, 4, 5}; {6, 7}; {10, 12, 13}. Tasks 15 and 16 are not parallel-safe: both add a workspace
package and so touch `bun.lock`.

**Branches.** All work happens locally on `m2-remote-stores`, managed by the orchestrator; no pull requests. At each
phase boundary (after tasks 5, 9, 14, 17, 21, 26 and 29) the orchestrator merges into `main`, pushes, and checks CI
on `main` with `gh run watch`; from Task 4 on, that includes the Linux job running the T2 containers. A red CI stops
the next phase until it's fixed (ADR-0021). Each boundary states which remote workflows work:

| Phase | Tasks | What works at the merge |
| --- | --- | --- |
| 1 · Carry-overs, test environments, sensitive output | 1–5 | M1 behaviour plus the carry-overs; T2 containers in CI; no remote store yet |
| 2 · Store groundwork | 6–9 | Specs, fakes and tests for semantics, formats, bootstrap and store identity; local stores only |
| 3 · Catalog groundwork | 10–14 | Crypto spec, codec, resolution model, offline views, gate schedules, all on fakes; local stores only |
| 4 · Secrets and the rclone blob store | 15–17 | Secret references; blob store contract and measured semantics on MinIO and SFTP; no remote offload yet |
| 5 · Remote stores end to end | 18–21 | Bootstrap, offload, onload, sealing and the catalog over SFTP and S3 (single device) |
| 6 · Leases and conflicts | 22–26 | Advisory leases, forks, retained trash, `resolve --keep`, `compare` |
| 7 · Proof and release | 27–29 | Remote crash matrix, T3, the gate, `v0.2.0` |

---

## Task 1 — Core safety carry-overs  `parallel-safe with Tasks 3, 4 and 5`

### Objective
Close the core-safety minors M1's reviews left open, in a way a rollback to v0.1.1 survives.

### Context
`docs/HANDOFF.md` "Carried into M2 → Core safety" and "Known limits"; D32, D63, D64, D67, D86, D88; Q5 (i) and
(ii); `docs/DESIGN.md` "Offload process" (the detached delete and its claim) and "Catalog and data model" (restic
tags).

### Scope
Owns:
- `packages/core/src/{trash-claim.ts,trash-delete.ts,lock.ts}`. `trash-delete.ts` is the detached claim writer.
- `packages/core/src/recover/trash.ts` and `packages/cli/src/housekeeping.ts`.
- The boot-session parts of `packages/core/src/ports/host.ts` and `packages/host-macos/src/host.ts`.
- The tag and `rootMode` parts of `packages/core/src/saga/{snapshot.ts,onload.ts}` and
  `packages/engine-restic/src/engine.ts`.
- DESIGN sections: "Offload process" (the claim sentence) and "Catalog and data model" (the tag list).

Items:
- **Orphan claims.** `gc` and housekeeping remove an `<op>.claim`, its `.claim.boot` and a stray `.claim.tmp` once
  the trash folder is gone and the claimer is not live by D64's test.
- **The boot session (Q5 i).** `HostPorts.bootSession()` reads macOS `kern.bootsessionuuid` or Linux
  `/proc/sys/kernel/random/boot_id`. The detached delete writes `<op>.claim.boot` before the claim, and the claim keeps
  M1's shape. Liveness uses the boot session when both files exist, and M1's rule otherwise. The lock's "since this
  boot" test (D63) shares the helper.
- **`rootMode` under an uncertain head (Q5 ii).** Offload adds `plainport:mode=<octal>`. `onload --snapshot S` through
  the tag lookup (D86, D88) applies it, or says the mode is unknown.
- **Host calls on network mounts (D32).** Store probes race a 10-second deadline and return `store.unreachable`.
  Bun cannot cancel the hung call, which is documented.

### Tests first
- A claim with no trash and a dead pid is removed; a live one is kept.
- A stepped clock with the same boot session reads as live.
- The compatibility row: a v0.1.1 claim reader parses a claim written by this task.
- `onload --snapshot S` with the offloaded event unreadable restores mode `0700` from the tag.
- A probe against a `stat` that never returns fails within the deadline.

### Verification
`bun test packages/core -t "claim|lock|gc|onload" && bun run test:t1 -t "claim|onload" && bun test test/crash-matrix`

### Report
`.orchestrate/reports/task-1.md`

### Stop condition
Every item has a test that fails without it; the crash matrix is green in both variants.

---

## Task 2 — `onload --dry-run` and the planning carry-overs

### Objective
Agents can preview an onload (D71), and the offload plan lists nested repositories, tags on no remote and non-git
projects.

### Context
D18, D36, D38, D69, D71; `docs/HANDOFF.md` "Carried into M2 → UX"; `docs/DESIGN.md` "Onload process" and "Offload
process" steps 3 and 5; `docs/machine-contract.md` §6. The git-maintenance fingerprint item is deferred (Q5 iii).

### Scope
Owns:
- The planning part of `packages/core/src/saga/onload.ts` (after Task 1).
- `packages/core/src/plan/` and `packages/core/src/scan/`.
- The `onload` command's options, output schema and renderer, and the regenerated contract files.
- DESIGN sections: "Onload process" (the dry run) and "Offload process" step 5.

Items:
- **`onload --dry-run`** is `read` and saves no plan. It reports:
  - `restored: "reuse" | "store"` and why;
  - the snapshot and the head it is written over;
  - the landing folder and the space needed;
  - findings;
  - the hydrate plan (package manager, frozen command, toolchain, Corepack).

  A `block` finding exits 6 with the preview as data (D38).
- **D69.** Tags held by no remote go under `git.unpushed` (message and `paths`). Nested repositories appear in the plan
  as `nested`, an additive field.
- **Non-git projects** get a human line: "not a git repository: every file travels except stripped dependency
  folders".

### Tests first
`onload --dry-run --json` validates and writes nothing: the sandbox and the store are byte-identical before and after.
It reports reuse for a kept trash, blocks on an occupied path with exit 6 and data, and warns `lease.held`. A local-only
tag and a nested repository both show in the plan. A compatibility-matrix row is added for the new optional output
fields.

### Verification
`bun test packages/core -t "onload|plan|scan" && bun test packages/cli -t onload && bun run contract && git diff
--exit-code plainport.json schemas/`

### Report
`.orchestrate/reports/task-2.md`

### Stop condition
`onload` lists `dryRun: true` in `plainport.json`, `docs/machine-contract.md` agrees, and the tests are green.

---

## Task 3 — Small carry-overs: hydration environment, gate tooling and test hygiene  `parallel-safe with Tasks 1, 4 and 5`

### Objective
Close the remaining small minors, so the M2 gate starts from better tools.

### Context
`docs/HANDOFF.md` "Carried into M2" (Corepack, "Gate and eval", "Tests and flake watch"); D54, D79.

### Scope
Owns the install environment in `packages/core/src/saga/hydrate.ts` and `packages/eco-node/src/hydrate.ts`,
`packages/cli/src/testing.ts`, `evals/agent-smoke/scorer.ts`, `scripts/gate-m1.ts` and a new `scripts/tree-compare.ts`.

- **Corepack.** Installs run with `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` and `COREPACK_ENABLE_AUTO_PIN=0`, so Corepack
  never waits on a prompt and never writes into the user's `package.json`. The hydrate report names Corepack when it
  supplied the manager.
- **Tree comparison.** `scripts/tree-compare.ts` compares type, mode, content hash, link target, hard-link groups,
  extended attributes and BSD flags. Both gates use it, and a gate's raw `--out` JSON is attached to the release notes.
- **Eval scoring** splits into `passed` (the objective checks) and `clean` (no contract issues).
- **The temp-folder leak.** `packages/cli/src/testing.ts` removes its `plainport-example-*` folders, and a suite-level
  check fails when a run leaves new `plainport-*` folders in `$TMPDIR`.

### Tests first
`package.json` is byte-identical after a Corepack-managed install fixture. Tree comparison catches a broken hard link,
a dropped xattr and a dropped `uchg` flag. The scorer gives `passed` but not `clean` on a recorded transcript. The leak
check fails before the fix.

### Verification
`bun test packages/eco-node packages/cli evals/agent-smoke scripts`

### Report
`.orchestrate/reports/task-3.md`, with the scorer split recorded as a decision.

### Stop condition
All four items are green, and `bun scripts/gate-m1.ts` passes on one demo project with the new comparison.

---

## Task 4 — Test environments as code  `parallel-safe with Tasks 1, 3 and 5` · `T2`

### Objective
One command brings up the T2 store containers on the laptop and in Linux CI, with the fault controls the later tasks
need, and CI runs the store suites and a restic version matrix.

### Context
ADR-0018 (T2, "Environments as code"), ADR-0021 (tiers as commands, Linux CI, version matrix); `docs/HANDOFF.md`
"Tests and flake watch"; `CONTRIBUTING.md`.

### Scope
Owns:
- `compose.yaml`, `scripts/testenv.ts` and its wrapper, `test/tiers.ts`, the `test:t2` and `test:t3` scripts.
- `.github/workflows/ci.yml` and `scripts/ci-workflow.test.ts`.
- The matrix section of `tools.lock.json` and `scripts/fetch-tools.ts`.
- `.gitignore` and the testing section of `CONTRIBUTING.md`.

Items:
- **`compose.yaml`.** Every image is pinned by digest, and every port binds to `127.0.0.1`:
  - MinIO (SeaweedFS if the image is unavailable);
  - `atmoz/sftp` with a key-only user;
  - `restic/rest-server --append-only`, smoke only, for M3;
  - Toxiproxy, in front of MinIO and SFTP.
- **`scripts/testenv up | down | status | env | restart <service> | linux`.**
  - `up` is idempotent and health-checked, and writes `.testenv/` (gitignored): endpoints, credentials generated for
    the run, SFTP keys, a sandbox `known_hosts` and ssh config.
  - `restart` restarts one container for durability tests.
  - `linux` is the reproducible Linux test recipe: pinned `oven/bun`, `--init`, the known gaps set out.
- **Fault controls.** Named Toxiproxy profiles: `cut` (reset both ways), `latency`, `slow-close`, and `lost-ack`
  (forward the request whole, then reset before the response). Task 14's schedules and Task 27's matrix use them by
  name.
- **Tiers.** `describeT2` and `describeT3`, failing without their environment. `test:t2` sets
  `PLAINPORT_TEST_TIER=2`; `test:t3` sets 3.
- **CI.**
  - The `linux` job runs `scripts/testenv up` and `test:t2`.
  - A `restic-matrix` job runs `engine-restic`'s T1 suite on restic 0.17.1, the latest 0.18 and the pinned 0.19.1,
    with checksums in `tools.lock.json` and fixtures under `fixtures/restic/<version>/`.
  - macOS runners have no Docker.

### Tests first
`tiers.test.ts` covers the T2 and T3 gating. `ci-workflow.test.ts` pins the T2 step and the matrix. A checksum mismatch
for a matrix version refuses. A T2 smoke test runs `up`, reaches every service, shows each Toxiproxy profile acting
(the `lost-ack` request reaches MinIO while the client sees a reset), and leaves nothing behind after `down`.

### Verification
`scripts/testenv up && bun run test:t2 -t testenv && scripts/testenv down`, `bun test scripts test/tiers.test.ts`,
`actionlint` if available, and one `scripts/testenv linux` run of `bun run test:t1`.

### Report
`.orchestrate/reports/task-4.md`, including the flake-watch rows the Linux recipe reproduced or cleared.

### Stop condition
`up` and `down` are idempotent, the profiles are proven, and the workflow is valid. The orchestrator confirms the Linux
T2 job and the matrix green on `main` at the phase boundary.

---

## Task 5 — Sensitive process output and the canary  `parallel-safe with Tasks 1, 3 and 4`

### Objective
A process whose output may hold a secret can never leak it, whether it succeeds or fails. The leak test every later
task uses exists before any secret provider or master-key read.

### Context
Astra's Critical 2: `lastOutput` in `packages/core/src/runner/runner.ts` puts stdout's last lines into timeout and
cancellation findings when stderr is empty. AGENTS rule 6 and rule 9; D79.

### Scope
Owns the sensitive mode of `packages/core/src/runner/` (`runner.ts`, `types.ts`, `ring-buffer.ts`) and its
host-macos spawner wiring, and a new `packages/core/src/testing/canary.ts`.

- **The sensitive mode** (`sensitive: true` on a run):
  - stdout is captured privately, bounded, and returned only in the ok value;
  - nothing from stdout or stderr reaches `log` events, `onOutput` callbacks, diagnostic tails, finding messages,
    error data or thrown errors, on every path: success, non-zero exit, idle and overall timeout, cancellation,
    malformed output, spawn failure and output overflow;
  - a failure names the command's label, the exit or stop reason, and byte counts only;
  - the private buffer is overwritten when the run ends.
- **The canary helper** plants unique values, including split and partial forms and each component of a structured
  secret (the master key's `encrypt`, `mac.k` and `mac.r` in base64 and hex). It fails a test if any of them appears in:
  files under the sandbox; captured stdout and stderr; event lines; findings; the argv of any process the runner
  started; or a thrown error.

### Tests first
A fake child prints a canary, then:
- exits 0;
- exits 1;
- hangs (idle timeout);
- prints slowly (overall timeout);
- is cancelled;
- prints half the canary and hangs;
- prints malformed JSON;
- floods past the buffer.

On every path the canary is absent everywhere the helper looks, and present in the ok value only on success. The
helper's own test shows it catches a deliberately leaky runner.

### Verification
`bun test packages/core -t "runner|canary" && bun run test:t1 -t runner`

### Report
`.orchestrate/reports/task-5.md`

### Stop condition
Every failure path is covered for both modes, and the existing runner tests are unchanged and green.

---

## Task 6 — Remote consistency and publication spec  `parallel-safe with Task 7`

### Objective
A precise, testable statement of what plainport needs from a store, and fakes that break each requirement, before
any adapter exists.

### Context
Astra's Important 4 and 5 and missing task 2; ADR-0006, ADR-0018; D24, D41, D42, D45; Q8, Q9.

### Scope
Owns:
- A new DESIGN section, "Remote stores: consistency and publication".
- `StoreSemantics` in `packages/core/src/ports/blob-store.ts`.
- `packages/core/src/testing/{semantic-blob-store.ts,blob-store-contract.ts}`.
- A new `packages/core/src/catalog/publish.ts`.

Items:
- **`StoreSemantics`** (Q8), typed properties, each with its evidence (`measured`, `documented`, `asserted`) or
  `unknown`:
  - `readAfterWrite` and `listAfterWrite` (boolean);
  - `listComplete` (boolean; pagination returns every key);
  - `publication` (`atomic-put | temp-then-rename | in-place`);
  - `conditionalCreate` (boolean);
  - `durability` (`durable | acked-unsynced | unknown`);
  - `cancellation` (`never-lands-late | may-land-late`).

  `capabilities()` stays for compatibility and derives from it.
- **Eligibility per operation** (Q8, Q21), one exported predicate each, in a DESIGN table:

  | Operation | Needs |
  | --- | --- |
  | `read` (catalog, `ls`) | a listing that works |
  | `append` | `publication ≠ in-place`, `readAfterWrite` |
  | `elect` | `conditionalCreate`, or `readAfterWrite ∧ listAfterWrite ∧ listComplete` |
  | `commit` | `append` and `elect` |
  | `release` (delete a local folder) | `commit` and `durability = durable`, or `durability = acked-unsynced` with Q21's post-grace proof |

  `unknown` fails every predicate that names the property, and `may-land-late` makes a cancelled put count as possibly
  landed. A missing `conditionalCreate` alone only routes elections to the fallback.
- **The semantic fake** wraps the memory store with switches for each weakness: delayed visibility, a listing that
  omits recent keys, a torn in-place write, lost acknowledgements (the write lands, the call fails), and late landing
  after cancellation.
- **Publication rules.**
  - An event is published whole: `atomic-put` stores put directly; `temp-then-rename` stores upload to
    `meta/v1/tmp/<op>-<nonce>` and rename. A torn key is never visible under `meta/v1/events/`.
  - The unique-writer assumption is stated: an event key is a fresh ULID from its writer.
  - A retry first reads the key and compares it through an injected `SameEvent(existing, intended)` interface
    (R2-8). This task tests it with a byte-equality fake; Task 11 supplies the codec's opened-content comparison and
    owns its acceptance test.
  - Temporaries are swept only by their own operation's recovery.
- **The elected publication primitive** (`publish.ts`), the one rule bootstrap and the root claim use:
  - a conditional create when proven;
  - otherwise, on a store passing `elect`: write a candidate, list, and proceed only as the sole candidate or when
    the published key already names you; publish; read back;
  - the outcomes are `won`, `lost` (a winner is published, and it is named) and `contested` (no winner: every visible
    candidate refuses). `contested` is a safe, expected outcome (R2-7);
  - removing a candidate by hand needs every plainport process quiesced first, and the finding's fix says so.
- **Refusals.** An operation whose predicate fails refuses with `store.semantics-unknown`, naming the property.

### Tests first
- The contract suite gains semantic cases, and the memory and fs stores pass every predicate.
- Each fake weakness is caught by at least one test, and each predicate refuses on the profile that lacks its
  property.
- Every interleaving of two and three claimants (fast-check over schedules) ends with **at most one** `won`; schedules
  where all candidates become visible before any listing end `contested`; and the fallback refuses on a profile that
  fails `elect`.
- A lost acknowledgement followed by a retry gives one event, not two (with the byte-equality fake).

### Verification
`bun test packages/core -t "publish|semantic|blob"`

### Report
`.orchestrate/reports/task-6.md`

### Stop condition
The DESIGN section, the profile type, the fake and the primitive are merged, with every requirement tied to a test.

---

## Task 7 — The format and compatibility matrix  `parallel-safe with Task 6`

### Objective
Every persisted format and every closed public value M2 touches has a row saying what each released reader does with
it, and executable tests that run the real v0.1.1 binary.

### Context
Astra's Important 10 and 13 and missing task 4; D16, D17, D73, D74; Q1, Q2, Q3, Q5, Q6, Q11.

### Scope
Owns:
- A new DESIGN section, "Formats and compatibility".
- A new `test/compat/`, with a builder that compiles v0.1.1 from its tag in a temporary `git worktree` (removed after)
  and caches the binary under `.tools/compat/`.
- `docs/machine-contract.md` §7.
- The D74 amendment in ADR-0022 (Q1).

The matrix lists every persisted format: catalog events by type, `store.json` (v1, and v2 per Q2), `root.json`, the
election candidates, the per-store sidecar, `registry.json`, `managed.toml` and `config.toml` keys, journals, plans,
claims and `.claim.boot`, stubs, restic tags, and the mirror. It also lists every closed public value: exit codes,
`ProjectState`, offload's `kind`, the plan's `fp`, phases.

Each row gives:
- what v0.1.1 does when it reads the format: parses it, skips it with a finding, or refuses;
- what a rollback to v0.1.1 leaves working;
- whether a v0.1.1 writer can reach the format, and what stops it;
- how an M1 store is adopted.

### Tests first
- **Adoption (T1).** v0.2 opens an M1 local store, onloads and offloads on it, and v0.1.1 still reads everything v0.2
  wrote there (format 1 stays readable).
- **Exclusion.** v0.1.1 refuses a format-2 `store.json` before writing anything.
- **Running old clients (R2-1).** The real v0.1.1, built with the crash matrix's test hooks and paused with
  `PLAINPORT_TEST_PAUSE_AT`, either before its event append or before its release.
  - While it holds a lease, `store upgrade` refuses (`store.not-quiescent`).
  - Without a lease (a first offload) and with `--others-stopped`, the upgrade proceeds. The resumed v0.1.1 appends an
    M1-shaped event that v0.2 reads correctly (Q11), and its release behaves as M1's: the documented residual.
  - The `upgrade-intent` marker blocks a v0.2 offload during the window.
- **Rollback deletion (R2-1).** With trash held at `offload.release.held` (in grace and `conflict-retained`), v0.1.1's
  `recover`, `gc`, `gc --now`, housekeeping at the start of a write command, and a detached delete it starts each
  leave the held trash in place.
- **Rollback.** v0.1.1 recovers a journal v0.2 left open on a format-1 store.
- **Claims.** v0.1.1 parses a claim written beside a `.claim.boot`.
- **Contract.** Every published schema in `schemas/` at v0.1.1 still validates v0.2's output for the same command (the
  contract snapshot diff is additive).

Rows for later tasks start as `test.todo` entries the owning task must turn on. A guard test fails the gate while any
todo remains.

### Verification
`bun run test:t1 -t compat && bun test test/compat`

### Report
`.orchestrate/reports/task-7.md`, with the matrix.

### Stop condition
The matrix covers every format in the inventory, the existing rows pass against the real v0.1.1, and D74 is amended.

---

## Task 8 — The bootstrap protocol and its recovery

### Objective
Setting up a store is exclusive and recoverable. No two initialisers ever write one restic repository, and identity,
repository location, root and seal policy are published once.

### Context
Astra's Critical 1; ADR-0008, ADR-0010; D45, D48, D50, D51, D85; Q2, Q9, Q10; Tasks 6 and 7.

### Scope
Owns:
- A new `packages/core/src/saga/bootstrap.ts` (journal steps, after-effect seams and `BOOTSTRAP_RECOVERY`).
- The `store.json` v2 schema in `packages/core/src/catalog/identity.ts`.
- The root claim's move onto the elected publication in `packages/core/src/catalog/root-claim.ts`.
- A fake engine `init` that can be paused and delayed.
- DESIGN sections: "Storage → Layout on every store" and a new "Bootstrap".

The protocol (Q9 b):
1. Journal `bootstrap.begin` with an attempt id.
2. `restic init` at `repos/<attempt>/`.
3. Write the candidate.
4. Hold the election through Task 6's primitive.
5. Publish `store.json` v2 `{v: 2, id, repo, catalog: {seal}, format: 2}`.
6. Read it back.
7. Record the id on this device.

The election has three outcomes (R2-7):
- **Won:** publish.
- **Lost:** a winner is published. Report `store.bootstrap-lost`, naming the winner.
- **Contested:** no winner, since every visible candidate refuses. Report `store.bootstrap-contested`, naming the
  candidates and the quiesced cleanup.

A losing or contested attempt writes nothing after its candidate, and its repository is left for `store test` to list.
The root claim is the same election under `meta/v1/root-claims/`, with the same three outcomes. Adopting an existing
store authenticates its published repository with this device's password before recording it.

### Tests first
- Two simultaneous initialisers, with different passwords, delayed config writes and lost acknowledgements (Task 6's
  fake), publish **at most one** repository. When one is published, the other's commands never touch it. When the
  schedule makes both candidates visible before either lists, both end `contested` and nothing is published.
- After a contested run, the documented cleanup (quiesce, remove the candidates) lets a single retry win.
- A kill at every bootstrap step, then `recover`, settles to "published by this attempt", "lost", "contested" or
  "rolled back (nothing published)". These are the crash-matrix rows.
- A third device adopts the winner.
- A format-1 local store is adopted without rewriting it.

### Verification
`bun test packages/core -t "bootstrap|root-claim|identity" && bun test test/crash-matrix`

### Report
`.orchestrate/reports/task-8.md`

### Stop condition
The protocol is green on fakes for every schedule and crash row, and its compatibility rows (Task 7) are on.

---

## Task 9 — Stable store identity

### Objective
Snapshot locations, home-store decisions and per-store facts use store ids, never a device's alias for a store.

### Context
Astra's Important 9 and missing task 3; D45, D68, D85; Q4, Q11, Q12; `packages/core/src/saga/onload.ts`
(`stored[store.name]`).

### Scope
Owns:
- `stored` lookups everywhere they occur: onload, restore, recover, views.
- The `stored` writer in offload, keyed by id on format-2 stores and by alias on format-1.
- The per-store sidecar (Q4) in a new `packages/core/src/stores-state.ts`.
- DESIGN sections: "Catalog and data model" (the `stored` paragraph) and "Local state per machine".

Rules (Q11, location by containment; R2-5):
- A snapshot event with exactly one `stored` entry, read from store S, is located on S. The key is never
  interpreted, so neither its shape nor this device's alias for S matters.
- An event with zero or several entries is skipped as unsupported (`catalog.event-skipped`, reason
  `stored-multiple`) and taints its project as uncertain, until M3 defines multi-store locations.
- Writers keep the containment rule: one entry, keyed by S's id on format-2 stores and by this device's alias on
  format-1 stores (for v0.1.1, which looks up `stored[<its alias>]`).
- The sidecar holds the seal pin, the semantics profile with its evidence, the last test, and the facts it was
  measured against (endpoint, access kind, tool versions), and invalidates on any change.

### Tests first
- Two homes call one store `archive` and `nas`, and each reads the other's snapshots (format 2).
- One store under two names on one device.
- `local` and `sftp` access to the same store (D68) give one id.
- A legacy M1 event read from S resolves to S.
- A ULID-shaped M1 alias (a store named `01J…` that is not its id) resolves to S. It is read on one device, then
  after `store upgrade`, then from another device with a different alias.
- An event with two `stored` entries is skipped and taints its project.
- Every event this build writes has one entry, keyed as above (a writer-side assertion run over the whole suite).
- A changed root default while the old store is offline still finds the snapshot by id.
- Sidecar invalidation, and an atomic write under a lock.

### Verification
`bun test packages/core -t "stored|store identity|stores-state" && bun run test:t1 -t compat`

### Report
`.orchestrate/reports/task-9.md`

### Stop condition
No code path looks up `stored` by name, and the compatibility rows are on.

---

## Task 10 — The versioned crypto spec  `parallel-safe with Tasks 12 and 13`

### Objective
The catalog seal is fully specified and versioned on its own, with test vectors, before any store is sealed.

### Context
Astra's Important 12 and missing task 6; ADR-0013; `docs/DESIGN.md` "Security and encryption", "Stack"
(`@noble/ciphers`); Q10.

### Scope
Owns:
- A new `packages/core/src/catalog/seal.ts` (pure: no I/O) and its vectors under `fixtures/seal/`.
- `@noble/ciphers` in `bun.lock`.
- A new DESIGN subsection, "Security and encryption → Catalog seal v1".

The spec, which the task may change only through `DESIGN_CONFLICT`:
- **Input keying material:** the 64 bytes `encrypt (32) ‖ mac.k (16) ‖ mac.r (16)`, base64-decoded from `restic cat
  masterkey`'s JSON. The order is fixed, and anything else is refused.
- **Derivation:** HKDF-SHA256 with salt = the UTF-8 store id, info = `plainport catalog seal v1`, and 32 bytes of
  output.
- **Key id:** the first 8 bytes of HMAC-SHA256(key, `plainport kid v1`), in hex.
- **The envelope**, one JSON line: `{"pp_seal":1,"alg":"xchacha20poly1305","kdf":"hkdf-sha256-restic-master-v1",
  "kid","nonce","ct"}`, with base64url fields.
- **Associated data:** `pp_seal\0v1\0<store id>\0<event key>`.
- **Nonce:** 24 random bytes.
- **Versioning.** `pp_seal` versions the envelope and KDF apart from the event's `v`. An unknown `pp_seal` or `kdf` is
  `catalog.seal-failed`.
- **Rotation.**
  - A password change leaves the master key, and so the catalog key, unchanged.
  - Removing a password does not revoke a master key someone already read: stated as a limit.
  - Replacing a compromised master key means a new repository and re-sealed events, which is M3 and M5 work. M2
    only fails closed on a `kid` mismatch.
- **No fallback.** A random-key fallback is never chosen silently (Q10).

### Tests first
- Test vectors: fixed master key, store id, event key and nonce give fixed bytes.
- One flipped bit in the ciphertext, the nonce, the AAD or the kid fails, as do a swapped event key, a swapped store id
  and an unknown version.
- Fast-check round trips (1,000 cases).

### Verification
`bun test packages/core -t seal`

### Report
`.orchestrate/reports/task-10.md`

### Stop condition
The spec is in DESIGN, the vectors are committed, and the module is pure and green.

---

## Task 11 — The unified catalog codec

### Objective
One codec reads and writes every catalog event on every path: live, recovery, mirror and tests. A sealed store can
never be misread as an absent or uncommitted event.

### Context
Astra's Important 11 and missing task 7; `packages/core/src/catalog/log.ts` (`appendEvent`, `readEvents`,
`eventForOp`), `packages/core/src/recover/recover.ts` (its direct `OffloadedEventSchema` parse); D24, D41, D42, D45,
D62; Task 10.

### Scope
Owns a new `packages/core/src/catalog/codec.ts`, every event read and write in `log.ts`, `head.ts` and
`recover/recover.ts`, the mirror's bookkeeping in `packages/blob-fs/src/mirror.ts`, and the test helpers that build
event files.

- `encode(event, policy)` gives transport bytes. `decode(bytes, key, policy)` gives an event or a typed skip reason:
  torn, not JSON, schema, wrong id, unknown type, `unsealed-event`, `seal-failed`.
- **Idempotent appends.** The codec implements Task 6's injected `SameEvent` interface by comparing opened events,
  so a sealed retry with a new nonce counts as the same event. This task owns the acceptance test of that integration
  (R2-8).
- **The mirror** stores opened bytes, plus a record of each transport file's name and size, which M1's cache digest
  uses. Transport bytes and opened bytes are never confused.
- **Recovery** reads through the codec, so recover works with an empty mirror on a sealed store.
- **Every skip reason feeds D86** (Task 21 adds the rule for when doubt applies).

### Tests first
- A grep-style test fails if any module outside the codec parses `meta/v1/events/` bytes.
- At every offload and onload commit boundary, recover with an empty mirror on a sealed fake store settles exactly as
  on a plain one (crash rows, both store kinds).
- A sealed append whose acknowledgement is lost, then retried, gives one event.
- The digest changes when a transport file changes size.

### Verification
`bun test packages/core -t "codec|catalog|recover" && bun test test/crash-matrix`

### Report
`.orchestrate/reports/task-11.md`

### Stop condition
All event I/O goes through the codec, and the crash matrix is green with sealed and plain fakes.

---

## Task 12 — The causal resolution model  `parallel-safe with Tasks 10 and 13`

### Objective
The fold settles conflicts by a stated causal rule with expected outcomes for every hard history, before any command
writes a `resolved` event.

### Context
Astra's Important 7 and missing task 8; ADR-0009; D41, D43; Q3, Q18.

### Scope
Owns `resolved` in `packages/core/src/catalog/events.ts` (`{v: 1, type: "resolved", project, root, path, keep, over:
[ulid], supersedes: [ulid]}`, written only to format-2 stores, Q2; `supersedes` may be empty), its rule in `fold.ts`,
a pure `resolutionFor(state, keep)` that implements the production rule for Task 25, and the DESIGN fold rules.

The model (Q18, completed for R2-2). It uses only the event set, never clocks or who observed what.

1. **Validation.** A resolution R is *invalid* when:
   - `over` is empty;
   - `keep ∈ over`;
   - any `keep`, `over` or `supersedes` reference belongs to another project, or is the wrong kind of event (a
     `supersedes` entry must be a `resolved` event);
   - R supersedes itself;
   - R lies on a cycle of `supersedes` edges. A writer can only supersede events it read, so a cycle means a broken
     or forged writer, and every resolution on it is invalid.

   An invalid R is skipped with `catalog.event-skipped` (reason `resolution-invalid`) and taints its project as
   uncertain. An R whose references are well formed but name a snapshot or resolution the catalog does not hold yet is
   *incomplete*: like a missing base (D41), it makes the head incomplete until the events arrive.
2. **Active resolutions** are the valid, complete ones that no valid resolution supersedes, directly or through a
   chain.
3. **Incompatibility.** Two active resolutions are incompatible when one's `keep` is in the other's `over`. Any
   incompatible pair leaves the project `conflicted` (a resolution conflict, `head = null`) until a later resolution
   supersedes both. Active resolutions with the same `keep`, or with disjoint concerns, combine.
4. **Rejected snapshots** are the union of the active resolutions' `over` sets.
5. **Live tips** are the snapshot tree's tips that are not rejected. A tip made from a rejected snapshot is not itself
   rejected, so work made on a rejected line, whenever it was made and whoever knew of the resolution, is live and
   conflicts again: it never vanishes. A continuation of the kept line is the single live tip, and the project stays
   settled.
6. **Status.**
   - One live tip and no incompatible pair: settled, and the head is that tip.
   - Two or more live tips: `conflicted`, and `heads` are the live tips.
   - With no resolutions this is exactly M1's rule: two or more tips is a fork.
7. **Production rule** (Task 25 writes only events this model judges valid):
   - `keep` must be a live tip in the writer's fresh read;
   - `over` = the live tips it read, minus `keep`;
   - `supersedes` = every active resolution it read.

### Tests first
An expected-outcome table, one row per history, each with the exact `status`, `head`, `heads` and `conflicts`:
- a plain fork resolved;
- the kept line continued after the resolution (settled, head moves);
- competing resolutions, keep X and keep Y (conflicted), then one superseding both (settled);
- two resolutions agreeing on `keep` with different `over` sets (combined);
- partial overlap;
- a delayed descendant of a rejected tip, made before the resolution but delivered after it (conflicted);
- a descendant made after the resolution (conflicted);
- a nested fork;
- invalid cases, each skipped and tainting: `keep ∈ over`, empty `over`, a `supersedes` naming another project's
  resolution, a `supersedes` naming an `offloaded` event, self-supersession, a two-cycle, another project's snapshot;
- incomplete cases: an unknown `over` snapshot, an unknown `supersedes` target (head incomplete until delivered);
- the production rule's output, for every row where a writer acts, is valid under the validation rules.

Then fast-check permutation invariance (1,000 cases) over histories built from those rows.

### Verification
`bun test packages/core -t "fold|resolved"`

### Report
`.orchestrate/reports/task-12.md`

### Stop condition
Every table row passes, and the DESIGN fold rules state the model.

---

## Task 13 — Credential-independent offline views  `parallel-safe with Tasks 10 and 12`

### Objective
`ls` and `status` work from a store's mirror without resolving any secret, opening the engine or deriving the seal
key, and say exactly why the store itself could not be read.

### Context
Astra's Important 17 and missing task 9; D45, D66; `packages/core/src/status/projects.ts`,
`packages/cli/src/commands/resolve.ts` (`viewDeps`).

### Scope
Owns the store-opening path of `packages/core/src/status/projects.ts` and `viewDeps`, and the conditions it adds.
DESIGN section: "Project lifecycle → What `ls` and `status` show".

- Views open the mirror by the pinned store id first, then try the store.
- A store failure becomes a condition beside the mirror's data:
  - `stale` or `never-synced` (as in M1);
  - `secret-unavailable` (a missing, signed-out or denied provider, or a missing password);
  - `store-unreachable`;
  - `seal-key-unavailable`.
- Provider calls are bounded by Q14's deadline.
- Write commands still refuse uncertain or unavailable stores.

### Tests first
With fakes, separately:
- network loss;
- a missing `op`;
- a signed-out `op`;
- a denied Keychain read;
- a missing password;
- a key derivation failure;
- a never-synced store.

Each shows the mirror's projects with the right condition and no secret prompt beyond the deadline. A write command in
each case refuses.

### Verification
`bun test packages/core -t "views|status" && bun test packages/cli -t "ls|status"`

### Report
`.orchestrate/reports/task-13.md`

### Stop condition
No view path resolves a secret before reading the mirror.

---

## Task 14 — Adversarial gate schedules and independent invariants

### Objective
The race schedules and the per-device invariants the gate needs exist as executable tests before the features they
judge. What M1 can already run runs now; the rest are named and must be turned on by their owning tasks.

### Context
Astra's Important 15 and 18 and missing task 10; ADR-0017; `docs/DESIGN.md` "Testing and fault injection"
(invariants); Q16, Q17; `packages/core/src/testing/invariants.ts`.

### Scope
Owns:
- `test/support/two-devices.ts`: two or three sandboxed homes and device ids on one store.
- `test/support/schedules.ts`.
- The per-device rewrite of `packages/core/src/testing/invariants.ts`.
- New pause seams in the sagas, as exports, compiled out of release builds (D67).
- DESIGN's invariants list (with Q16 and Q17 applied).

Pause seams: `offload.head-checked` (after a passing head check), `offload.committed`, `offload.release.reread`,
`onload.lease-checked`, and `trash.delete.checked`.

Schedules, each with the outcome every device must observe, written by device:
- **S1 sequential:** B checks after A commits, so B forks before its commit.
- **S2 both checked:** both pass the head check, then both append.
- **S3 asymmetric:** A appends and releases before B appends (Q16's residual).
- **S4 strict onloads:** two simultaneous strict onloads (Q17).
- **S5 lost acknowledgement** at the event append.
- **S6 delayed visibility** of the other's event (fake store).
- **S7 resolution races:** competing resolutions, and a resolution while the other device's journal is pending.
- **S8 D87 aliases:** a remote store reachable through a local mount or alias placed under a stripped folder.

Invariants, independent of the implementation:
1. A deleted folder's snapshot is verified, committed and in the store.
2. **Per device:** a stub exists iff this device's own last completed operation shelved the project. It no longer
   reads the global catalog status, which a later fork changes.
3. No leftovers from finished operations.
4. Fold permutation.
5. **Per Q17:** the fold names at most one holder, and no device that observed a holder under `strict` onloaded.
6. **M2 scope:** a recorder shows no forget, prune or delete of snapshots or events.

### Tests first
- The invariants' own tests: each catches a seeded violation.
- S1 runs green on a local store now.
- The other schedules are registered as `test.todo` with the task that turns each on (S2, S3 and S5: Task 23; S4:
  Task 22; S6: Task 21; S7: Task 25; S8: Task 24).
- A guard test lists the todos and fails at the gate if any remains.

### Verification
`bun test test/support packages/core -t invariants && bun run test:t1 -t schedules`

### Report
`.orchestrate/reports/task-14.md`

### Stop condition
The harness, seams, invariants and schedule list are merged; S1 is green; every other schedule names its owner.

---

## Task 15 — Secret providers: env, file, Keychain and 1Password

### Objective
Store secrets resolve through a `SecretProvider` port over the sensitive runner, and no value ever leaves memory or a
child's environment.

### Context
ADR-0013; `docs/DESIGN.md` "Security and encryption", "Configuration", "Plugin interfaces → SecretProvider"; D79; Q7,
Q14; Task 5.

### Scope
Owns:
- `packages/core/src/ports/secrets.ts` and a new `packages/secrets/` (in `bun.lock`).
- The secret parts of `packages/core/src/store.ts`.
- The `s3` fields of `packages/core/src/config/schema.ts` (Q7).
- DESIGN section: "Configuration" (the reference forms).

Items:
- **`keychain:`** runs `/usr/bin/security find-generic-password -s -a -w` in sensitive mode with Q14's deadline.
  `set` goes through `security -i`, with the command on stdin and each argument quoted by a tested encoder.
  "Not found" gives `store.secret-missing`, whose fix is the interactive `security add-generic-password … -w`.
- **`op:`** runs `op read` in sensitive mode.
- **`se:` and `bw:`** are refused, naming their milestone.
- **The install environment (D79)** also drops `AWS_*`, `RCLONE_*` and `OP_*` variables.
- **Tests use a throwaway keychain** through a test hook that release builds compile out.

### Tests first
- Each provider: found, missing, empty, garbled reference, timeout and cancellation, with the canary on every path.
- The `security -i` encoder: values with spaces, quotes, backslashes and newlines round trip, and a value that would
  inject a second command is refused.
- T1 on macOS: the user's search list and default keychain are byte-identical before and after.
- A fake `op` covers signed-out and hanging.
- Schema: `s3` requires the new references; `AWS_SESSION_TOKEN` is never read.

### Verification
`bun test packages/secrets packages/core -t "secret|store" && bun run test:t1 -t keychain && bun run contract`

### Report
`.orchestrate/reports/task-15.md`

### Stop condition
Every provider is green with the canary, and the compatibility row for the new config keys is on.

---

## Task 16 — The rclone blob store

### Objective
`blob-rclone` implements the `BlobStore` port and Task 6's publication rules over the pinned rclone, with no
publication semantics it cannot supply.

### Context
Astra's Important 5; ADR-0006; `docs/DESIGN.md` "Plugin interfaces → BlobStore"; Task 6; rclone 1.75.1's `rcat`
writes in place on SFTP (`O_TRUNC`).

### Scope
Owns a new `packages/blob-rclone/` (in `bun.lock`) and an optional batch read on the port (`getMany`, internal).

- **Calls**, all through the runner: `get` is `cat`; `list` is `lsjson -R --files-only`; `stat` is `lsjson --stat`;
  `delete` is `deletefile`, for probe keys and own temporaries only.
- **Publication.**
  - On S3 a `put` is `rcat` straight to the key (atomic-put: an object appears only when complete).
  - On SFTP a `put` is `rcat` to `meta/v1/tmp/<op>-<nonce>`, then `moveto` the final key. Task 17 measures whether
    that rename is atomic and whether it refuses an existing target.
  - Where no whole publication is proven, the profile says `none`, and Task 6's refusals apply.
- **`getMany`** is one `copy --files-from-raw` into a temp folder, cleaned through the guarded deleter.
- **Remotes** come from environment variables only, with `RCLONE_CONFIG` pointing at a missing file and a cache dir
  under plainport's cache. Network calls are bounded (`--contimeout`, `--timeout`, `--retries 1`) on top of the
  runner's deadlines.
- **Exit codes.** On `get` and `stat`, 3 and 4 mean `null`. Exit 5 and connection failures are `store.unreachable`.
  Anything else is `store.failed`, with stderr redacted.
- **`semantics()`** reports `unknown` for every measured property until Task 17.

### Tests first
- Exit-code mapping on recorded stderr fixtures.
- The canary over argv and error output.
- A poisoned `rclone.conf` in the sandbox is never used.
- The contract suite against rclone's `local` backend (T1).
- An observer listing `meta/v1/events/` during a slow SFTP-style upload (the local backend with the temp-then-rename
  path) never sees the key before it is whole.
- A kill before and after the rename leaves either nothing under `events/` or the whole event, plus at most one
  temporary that recovery sweeps.

### Verification
`bun test packages/blob-rclone packages/core -t blob && bun run test:t1 -t blob-rclone`

### Report
`.orchestrate/reports/task-16.md`

### Stop condition
The contract suite is green on rclone-local, and no profile claims more than the adapter does.

---

## Task 17 — Semantics on MinIO and SFTP, and the conditional-write retest  `T2`

### Objective
Measure each backend's semantics profile on real servers, record it, and pass the store contract and the elected
publication there.

### Context
ADR-0018 (the open `If-None-Match` check); Q8, Q9; Tasks 6 and 16; `docs/DESIGN.md` "Machines → SSH policy".

### Scope
Owns:
- The T2 tests of `packages/blob-rclone/`.
- A new `test/support/ssh-shim.ts`: OpenSSH with `-F <sandbox config>`, `BatchMode=yes` and
  `StrictHostKeyChecking=yes`.
- A test-only SigV4 probe in `test/support/s3-probe.ts`.
- The measured rows of the DESIGN semantics table.

Measurements:
- **MinIO:**
  - read-after-write and list-after-write;
  - pagination beyond 1,000 keys;
  - durability across `scripts/testenv restart minio`;
  - `If-None-Match` through the adapter, with the direct probe as the reference.
- **SFTP through the system OpenSSH** (`--sftp-ssh`):
  - whether `moveto` is atomic and whether it refuses an existing target;
  - visibility;
  - durability: `acked-unsynced`, since rclone's SFTP backend sends no fsync. It becomes `durable` only if a tested
    adapter path actually invokes `fsync@openssh.com` and the server supports it; a server advertising the extension
    is not enough (R2-6).
- Each result goes into the backend's profile and the sidecar (`measured`). MinIO and AWS-style S3 are `durable` by
  documentation, and the report cites the source.

### Tests first
- **Eligibility per operation** on the measured profiles:
  - SFTP passes `read`, `append`, `elect` and `commit`, and passes `release` only through Q21's post-grace proof;
  - a profile forced to `publication: in-place` refuses `append`;
  - one forced to `durability: unknown` refuses `release`, while its offload commits, keeps the trash and reports
    why.
- The contract and semantic suites on MinIO and SFTP.
- Task 6's election on both: two processes, 50 rounds.
- `lost-ack` on a put: the retry finds the landed event.
- `cut` during a list fails as `store.unreachable`, never as a short listing.
- A MinIO restart after an acknowledged put keeps the event.

### Verification
`scripts/testenv up && bun run test:t2 -t "blob-rclone|semantics|publish"`

### Report
`.orchestrate/reports/task-17.md`, with the measured profile table and the `If-None-Match` result recorded in
ADR-0018's open item.

### Stop condition
Both backends have measured profiles, the contract is green on fs, rclone-local, MinIO and SFTP, and the election
never admits two.

---

## Task 18 — Remote engine targets and bootstrap on real stores  `T2`

### Objective
restic reaches SFTP and S3 stores at the bootstrapped repository location, and bootstrap holds against real
simultaneous initialisers.

### Context
ADR-0006, ADR-0010; `docs/DESIGN.md` "Storage → Store kinds"; D27, D45, D68, D85; Q7, Q9; Tasks 8 and 17.

### Scope
Owns `packages/engine-restic/src/engine.ts` (repository locations and options) and `packages/cli/src/stores.ts` (the
opener for `local`, `sftp` and `s3`; `peer` stays `store.unsupported`). It wires Task 8's saga to the real engine and
blob store.

- **Repository locations:** `sftp:<host>:<path>/<repo>` through the shim's ssh in tests, and
  `s3:<endpoint>/<bucket>/<path>/<repo>` with `s3.region` when set. `<repo>` comes from `store.json` v2.
- **The two layers agree.** A test proves restic and rclone address the same prefix (Q7): a marker written through one
  is found through the other.
- **Credentials** go only in the child's environment, and messages are redacted.
- **Failures.** Network failures are `store.unreachable`, a missing repository is `store.not-set-up`, and a lock is
  `--retry-lock`, then 11.

### Tests first
- Golden tests for locations, options and environment, with the canary.
- T2 bootstrap: two processes with different passwords on one fresh MinIO prefix and one SFTP folder produce one
  repository, and the loser's restic is never pointed at the winner's.
- A kill at each bootstrap step, then `recover`.
- T2 single-device round trip: offload then onload of a fixture, byte-identical by Task 3's comparison. Until Task 24
  builds Q21's post-grace proof, the test's SFTP profile asserts `durability: durable` in its sandbox config (evidence
  `asserted`). Without that assertion, the same offload commits and keeps its folder (`release` is refused), and a
  test shows that too.
- A `cut` mid-upload fails before the commit, with invariants 1 to 3 holding.

### Verification
`bun test packages/engine-restic packages/cli -t stores && scripts/testenv up && bun run test:t2 -t "bootstrap|remote
round trip"`

### Report
`.orchestrate/reports/task-18.md`, with times per kind.

### Stop condition
Both remote kinds bootstrap safely and round-trip byte-identically.

---

## Task 19 — `store add | list | test | upgrade | remove`, and `init`  `T2`

### Objective
Stores can be set up, adopted, upgraded, listed, tested and forgotten from the CLI, and `init` gets M2's setup work.

### Context
`docs/DESIGN.md` "CLI design" (`store …`, `init`), "Core API" (`stores.list`, `stores.test`); D22, D68, D70, D85;
Q2, Q4, Q8, Q13, Q14, Q15.

### Scope
Owns `packages/cli/src/commands/store.ts`, the store part of `packages/cli/src/commands/init.ts`, core's `stores.list`
and `stores.test`, and the regenerated contract files.

- **`store add`** runs bootstrap, or adopts an existing store after authenticating it. It writes `managed.toml` under
  its lock. `--secret-stdin` saves to the Keychain.
- **`store list`** reads only; `--probe` also checks reachability.
- **`store test`** measures the profile and writes it to the sidecar, reports `delete: denied | allowed |
  unreachable`, and lists losing bootstrap repositories and contested candidates with the manual steps (quiesce first).
- **`store upgrade`** (Q2's constrained procedure, R2-1) moves a format-1 store to format 2. It refuses
  (`store.not-quiescent`, naming the first reason) while any of these holds:
  - this device has an open journal or a live plainport lock;
  - the store's catalog shows a lease, or an unfinished offload or onload, held by another device;
  - the catalog shows an event from another device within the quiet window;
  - `--others-stopped` is missing. Its fix lists the devices the catalog names and says to stop plainport on each,
    detached deletes included.

  Otherwise it writes `meta/v1/upgrade-intent.json` (v0.2 refuses bootstrap and offload while the marker stands),
  waits out the window, re-reads, and only then replaces `store.json` atomically and removes the marker. A re-read
  that finds new foreign activity aborts and removes the marker. A crash leaves the marker, which `store upgrade`
  resumes or `recover` clears. The store must hold this device's pinned id.
- **`store remove`** behaves as Q13 says.
- **`init`** shows folder sizes (D70) and refuses re-pointing per Q15.
- New findings: `store.in-use`, `store.bootstrap-lost`, `store.bootstrap-contested`, `store.root-contested`,
  `store.semantics-unknown`, `store.not-quiescent`.

### Tests first
- The risk gate and schema of every command.
- `store add` is idempotent and leaves no secret in `managed.toml`.
- `store upgrade`, then v0.1.1, refuses the store; Task 7's running-old-client and rollback-deletion rows are turned
  on.
- `store upgrade` refuses in each `store.not-quiescent` case, a crash at each step resumes or clears, and foreign
  activity during the window aborts with the marker removed.
- `remove` refuses while in use.
- `test` on a delete-denying fake says `denied`, not "append-only".
- `init` re-pointing an unreachable path refuses and writes nothing.
- T2: `add` and `test` on MinIO and SFTP.

### Verification
`bun test packages/cli -t "store|init" && bun run contract && git diff --exit-code plainport.json schemas/ && bun run
test:t2 -t "store add"`

### Report
`.orchestrate/reports/task-19.md`

### Stop condition
The commands are registered with their risk classes, `docs/machine-contract.md` agrees, and the tests are green.

---

## Task 20 — Sealing on stores  `T2`

### Objective
New `s3` and `sftp` stores seal their catalog per Task 10's spec, under a policy fixed at bootstrap and pinned by each
device.

### Context
ADR-0013; Q10; Tasks 5, 8, 10, 11 and 19.

### Scope
Owns:
- An Engine port method `catalogKey(ctx)`: `engine-restic` runs `restic cat masterkey` in sensitive mode and returns
  only the derived key.
- The seal policy in bootstrap (`store add --seal | --no-seal`, defaulting by kind).
- The device pin in the sidecar.
- The codec wiring that hands the key to `encode` and `decode`.
- `store list`'s sealed column.

Rules:
- A store pinned sealed refuses plaintext events (`catalog.unsealed-event`, which feeds D86).
- A store pinned plain refuses a seal flip (`store.identity-changed`).
- An M1 store cannot be sealed in place (Q10).

### Tests first
- `catalogKey` gives the same key across two passwords on one repository, on restic 0.17.1 and 0.19.1 (matrix), with
  the canary over every master-key component.
- A `kid` mismatch fails closed.
- T2 on MinIO: the bytes under `meta/v1/events/` hold no project ULID, path or root key.
- An empty-mirror recover on a sealed remote store at every commit boundary (Task 11's rows on a real store).

### Verification
`bun test packages/core packages/engine-restic -t "seal|catalogKey" && bun run test:t2 -t sealed`

### Report
`.orchestrate/reports/task-20.md`

### Stop condition
Sealed by default for new remote stores, the pins enforced, and the compatibility rows on.

---

## Task 21 — The catalog over remote stores  `T2`

### Objective
The catalog read path works over remote stores: a fast mirror sync, conservative doubt about unreadable events, and
the home-store rule.

### Context
Astra's Important 6; D41, D45, D86; Q12; Tasks 11 and 13.

### Scope
Owns the sync in `packages/core/src/catalog/log.ts`, the doubt rule in `head.ts`, the home-store check in the offload
and onload preflights, and the multi-store merge in `status/projects.ts`.

- **The sync:** one listing, one batch read, a deadline. A write path always reads fresh.
- **Doubt without the clock.**
  - An event skipped for any codec reason (`event-skipped`, `unsealed-event`, `seal-failed`) whose project cannot be
    authenticated makes every head-dependent decision on that store uncertain (`catalog.head-uncertain`), whatever
    its ULID's time.
  - One whose project is known taints that project only.
  - It clears when the event reads.
- **The home store (Q12):** `store.history-elsewhere` unless the target catalog holds this copy's base, by store id,
  using the mirror when the home store is offline.
- **Several stores.** `ls` merges catalogs by project id, and a project in two catalogs gets the condition
  `several-stores`.
- This task turns on schedule S6 (delayed visibility).

### Tests first
- Negative clock skew, equal timestamps, and a damaged event that sorts before the readable head: each refuses.
- An unreadable sealed event of unknown project taints the store; a known project's taints only that project.
- `history-elsewhere`, with the home store offline.
- T2: a 1,000-event sync starts two rclone processes, and the time is recorded.
- S6 green.

### Verification
`bun test packages/core -t catalog && bun test packages/cli -t "ls|status" && bun run test:t2 -t "catalog remote"`

### Report
`.orchestrate/reports/task-21.md`

### Stop condition
The doubt and home-store rules are in DESIGN, and S6 is on.

---

## Task 22 — Advisory leases across devices

### Objective
Two devices see each other's leases. `strict` refuses an observed holder, and the docs say plainly that a lease is
advisory (Q17).

### Context
`docs/DESIGN.md` "Fold rules → Lease", "Onload process" step 2; D40, D43, D54; Q17; Task 14.

### Scope
Owns the lease view in `status/projects.ts`, the lease finding in offload's plan, the onload lease tests, and DESIGN's
lease paragraph (advisory wording).

- **The view** shows the holder (this device or `device <short id>`), since when, and the condition
  `leased-elsewhere`.
- **Offload** warns `lease.held` when another device holds the lease further along the chain; `strict` blocks it with
  exit 8.
- **Onload** reads fresh, and `strict` refuses an observed holder.
- This task turns on schedule S4: two simultaneous strict onloads may both succeed. The test asserts each device's own
  observation and invariant 5 as Q17 defines it, and that their later offloads fork rather than lose anything.

### Tests first
- `warn` and `strict` across two homes.
- B's `status` names A's device.
- An offload from the non-holding copy warns.
- S4 green.

### Verification
`bun test packages/core -t lease && bun run test:t1 -t "two devices|schedules"`

### Report
`.orchestrate/reports/task-22.md`

### Stop condition
The lease view and checks are green, and the DESIGN wording is advisory.

---

## Task 23 — Forks: local transitions and the check after the commit

### Objective
Every fork path leaves a durable, well-defined local state: which snapshot the kept copy is, a closed journal, and the
base used after resolution. A fork seen right after the commit keeps the folder.

### Context
Astra's Important 3 and 8; `docs/DESIGN.md` "Offload process" step 7, "Journal steps"; D24, D51, D52, D59, D61; Q6,
Q16, Q18; Task 14.

### Scope
Owns the fork paths of `packages/core/src/saga/{offload.ts,release.ts}`, their rules in `recover/recover.ts`, the
offload command's exit-8 data (`detail`, Q6), and DESIGN's "Journal steps" and "Conflict at step 7".

**The fork state machine** (R2-3). One table in DESIGN, keyed by where the operation stands when the fork is seen.
This task owns F1 and F2 and the hand-off into F3; Task 24 owns everything after F3.

| Stage | When the fork is seen | Folder | Stub | Registry `base` | Journal |
| --- | --- | --- | --- | --- | --- |
| F1 | at the commit's head check (M1's `diverged`) | stays in place | none | the operation's own snapshot | closed as `forked` |
| F2 | after the commit, before the rename: release's re-read, or recover's re-read at `committed` or at `release.trash` when the world shows no rename yet | stays in place | none | the operation's own snapshot | closed as `forked` |
| F3 | after the rename (`release.moved` and later), or never seen before the rename | in the trash; the rename is never undone | written: this device did shelve the project (invariant 2, per device) | cleared as for any release | parked at `offload.release.held` with `{snapshot, reason: grace \| conflict}`; Task 24 settles it |

Rules around the table:
- In F1 and F2, `base` uses the existing registry field, so there is no format change. A closed journal means D59
  never blocks `resolve`.
- **Recover** from `committed` on re-reads the store first. An unreachable store leaves the operation pending, never
  released. Where the re-read finds no fork, the release goes on into F3, held for the grace period (on remote stores).
- **A snapshot another device's resolution rejected, seen in F2** (the remote-resolution-while-pending case), also
  settles there: the folder stays with `base` = its own snapshot. The view shows the open condition `rejected-line`,
  and its next offload is live work that conflicts again (Task 12, rule 5).
- **Exit 8** carries `kind: "fork"` with `detail: "after-commit"` for F2.
- This task turns on schedules S2, S3 and S5. In S3, A reaches F3 and B stays in F1 or F2.

### Tests first
- The full sequence on both devices: fork → recover → `compare` (stubbed until Task 26) → `resolve --keep` (stubbed
  until Task 25) → edit → offload → onload on the other.
- A remote resolution while a local journal is pending (store down at `committed`), then recover with the store back:
  F2, with `rejected-line`.
- Each stage's row of the table, asserted by device (folder, stub, `base`, journal) after the live run and after
  recover.
- Crash rows for the re-read: killed between the re-read and the rename, the store unreachable at the re-read, and a
  lost `release.moved` write (recover decides F2 or F3 from the world).
- S2, S3 and S5 green, with their outcomes per device.

### Verification
`bun test packages/core -t "offload|recover|fork" && bun test test/crash-matrix && bun run test:t1 -t "schedules|crash"`

### Report
`.orchestrate/reports/task-23.md`, with the new row count.

### Stop condition
Every fork path's local state is specified in DESIGN and tested, and invariants 1 to 6 hold after each schedule.

---

## Task 24 — Conflict retention: deleting the trash only after a checked read

### Objective
Q16's promise holds: a released folder is deleted only after a catalog read, taken at least the grace period after its
commit, showed no fork naming its snapshot. That holds through every delete entrance.

### Context
Q16; D59, D64, D67, D87; `packages/core/src/{trash-delete.ts,recover/trash.ts}`, `packages/cli/src/housekeeping.ts`,
`gc`; Task 23.

### Scope
Owns one checked-delete function that the detached delete, housekeeping, `gc` and `recover`'s delete-trash all call.
It also owns `offload.conflictGrace` (config, default `15m` for remote stores and `0` for local ones), the
`conflict-retained` trash state in views, and DESIGN's release and trash paragraphs.

**The held-trash state machine** (F3 onwards, R2-3). The journal step is `offload.release.held`, a step v0.1.1 does
not know, so a rollback never deletes held trash (Q2, Task 7's rows). It is durable, and it is the retention record
M1's reuse path reads. The stub is written, as F3 says.

| From | Event | To |
| --- | --- | --- |
| `held(grace)` | the checked read, at or after commit + grace, finds no fork naming the snapshot, and Q21's proof finds the event and the restic snapshot | `release.delete`: M1's detached delete, through D87 |
| `held(grace)` | the checked read finds a fork naming the snapshot | `held(conflict)`, shown as `conflict-retained` |
| `held(grace)` or `held(conflict)` | the store is unreachable, or the proof finds data missing (`store.lost-write`) | unchanged; retried later and reported |
| `held(conflict)` | an active resolution keeps the snapshot (or a line made from it) | `held(grace)` with a fresh deadline. While it waits, `onload` of that head reuses the trash (M1's rename-back) and closes the journal |
| `held(conflict)` | an active resolution rejects the snapshot | `held(grace)`, then deletable as above: the snapshot stays in the store and stays restorable |
| any `held` | `onload` of the same head with the folder's verified fingerprint | renamed back, journal closed (M1 reuse) |

Rules around the table:
- **One checked-delete function**, which the detached delete, housekeeping, `gc` (including `gc --now`, which
  shortens no grace) and `recover`'s delete-trash all call. None of them deletes a trash whose journal is not
  `release.delete`.
- **The journal gate.** D59's `journal.pending` does not count a `held` journal as unfinished. `resolve`, `compare`,
  `onload` (reuse or restore) and read commands run while it stands. Another offload of the project is impossible
  anyway, since the folder is shelved.
- `offload.conflictGrace` defaults to `15m` on remote stores and `0` on local ones. With `0`, the step goes straight to
  `release.delete` as in M1.
- The `conflict-retained` state appears in views.
- This task turns on schedule S8 (D87 with remote aliases). S3 is extended: B's append within the grace keeps A's
  trash.

### Tests first
- Every row of the table, asserted by device.
- Every entrance, including `gc --now`, refuses to delete a held trash.
- The deadline is honoured under a stepped clock.
- **Crash after the rename on the same device:** a competing append, then `recover` (`held(conflict)`), then
  `resolve --keep` of the retained snapshot (allowed with the held journal open), then `onload` reuses the trash.
- Deletion after a rejection, and the rejected snapshot restorable with `restore --snapshot`.
- Crash rows at `trash.delete.checked` and at each transition.
- S3 extended and S8, green.

### Verification
`bun test packages/core -t "trash|gc|recover" && bun test test/crash-matrix && bun run test:t1 -t schedules`

### Report
`.orchestrate/reports/task-24.md`

### Stop condition
No delete entrance bypasses the check, and DESIGN and HANDOFF state the promise and its residual.

---

## Task 25 — `plainport resolve --keep`

### Objective
`resolve` settles a conflict by appending a valid `resolved` event under Task 12's model.

### Context
`docs/DESIGN.md` "CLI design" (`resolve`); D44, D60; Q2, Q3, Q18; Tasks 12 and 23.

### Scope
Owns a new `packages/core/src/saga/resolve.ts` and the command in a new
`packages/cli/src/commands/resolve-conflict.ts`. The existing `commands/resolve.ts` is the project-argument resolver.
It also owns `status`'s per-head detail for a conflicted project, and the regenerated contract files.

- **`resolve <project> --keep <snapshot>`** (`confirm`):
  - it requires a format-2 store;
  - it reads fresh and takes the project lock;
  - it refuses while an unfinished journal is open (fix: `recover`), but runs beside a `held` journal (Task 24);
  - it builds its event with Task 12's `resolutionFor`: `keep` must be a live tip, `over` = the live tips read minus
    `keep`, and `supersedes` = every active resolution read. A test asserts that every event it writes passes Task
    12's validation (R2-2);
  - with a working copy here, `--keep` must be the registry's `base` for it (Task 23);
  - a re-run is a no-op;
  - it exits 0 with "nothing to resolve" when not conflicted.
- **Read-only inspection** is `status`.
- This task turns on schedule S7.

### Tests first
- The gate and schema.
- Across two homes: fork, then `resolve --keep` on A, then B's onload gets the kept snapshot.
- `restore --snapshot <rejected>` still works.
- Competing resolutions on A and B stay conflicted until a superseding one.
- `--keep` naming another device's snapshot while a copy is here refuses, and the fix is exact.
- S7 green.

### Verification
`bun test packages/core -t resolve && bun test packages/cli -t resolve && bun run contract && git diff --exit-code
plainport.json schemas/`

### Report
`.orchestrate/reports/task-25.md`

### Stop condition
The command and its rules are green, and `docs/machine-contract.md` agrees.

---

## Task 26 — `plainport compare`: the theirs refs through a temporary index

### Objective
While a conflict stands, each other head shows up in this repository as refs you can diff and cherry-pick from. They
are built without running repository filters, and without touching your index, branches, working tree or secrets.

### Context
Astra's Important 16; `docs/DESIGN.md` "Conflict at step 7", "Prior art → Teleport"; D33, D34, D58, D60, D87; Q18.

### Scope
Owns a new `packages/core/src/saga/compare.ts`, the `compare` command (`safe_write`), and the regenerated contract
files.

**The ref layout** (R2-4): sibling leaves only, so every ref can coexist:

```text
refs/plainport/theirs/<snapshot>/HEAD       their HEAD commit, detached or not
refs/plainport/theirs/<snapshot>/heads/*    their branches
refs/plainport/theirs/<snapshot>/index      a commit of their staged index (absent when the index is unmerged)
refs/plainport/theirs/<snapshot>/worktree   a commit of their working tree, parent = their HEAD
```

No ref is ever named `refs/plainport/theirs/<snapshot>` itself. `git diff HEAD
refs/plainport/theirs/<id>/worktree` is the documented comparison.

For each other head, objects are built first and refs published last:
1. Restore it into a staging folder beside the project. This is unjournaled, as D60 has it, and cleanup goes through
   the guarded deleter.
2. **Objects.** Copy into this repository every object the published refs will need:
   - the objects reachable from their `HEAD` and branches (`rev-list --objects`);
   - every blob their index references, including staged-only blobs no commit reaches (from `ls-files -s` over every
     stage);

   as one pack, `pack-objects` in staging into `unpack-objects` here. Nothing is fetched by ref, so no ref appears
   yet.
3. **Index.** Seed a temporary index from their `.git/index`, so staged state and tracked-but-now-ignored files stay
   tracked.
   - If it has no unmerged entries, write its tree and commit it for `…/index`.
   - If it has unmerged entries, `…/index` is omitted, the unmerged paths are listed, and each one collapses to
     stage 0 with the working-tree content for the next step.
4. **Working tree.** Update the temporary index from the staged working tree. Blobs are hashed with `git hash-object
   --no-filters -w` and entered with `update-index --index-info`, so no clean or smudge filter or attribute driver ever
   runs. Untracked files are added only when not ignored (`ls-files --others --exclude-standard` against the staging
   tree). Commit it for `…/worktree`, with their `HEAD` as the parent.
5. **Publish.** One `git update-ref --stdin` transaction (`start`, then each `create` or `update` with its expected
   old value, then `prepare` and `commit`) writes the whole set for that snapshot, and removes leaves of an earlier run
   that this run did not produce.
   - A crash before the commit leaves no new refs: only staging, which `gc` removes, and unreachable objects, which
     `git gc` prunes.
   - Git's files backend can still leave a set partly written if the process dies inside the commit. A set missing
     any leaf it should have is reported as incomplete by `compare` and `status`, and a rerun replaces the whole set.

Other rules:
- `compare --clean` removes only `refs/plainport/theirs/**`.
- Submodules stay as gitlinks and are listed.
- Ignored files that differ are listed, never committed.
- A non-git project refuses with a path list instead.
- Git runs with hooks off, signing off, `core.attributesFile=/dev/null` and D34's isolation.

### Tests first
- A canary in the other copy's `.env`, a repository-defined clean filter that would inject that `.env` into a tracked
  blob (its marker file is never created), and a tracked file now matched by `.gitignore`: none of them leaks, and the
  tracked file is not recorded as deleted.
- A detached unpushed `HEAD` is reachable. A staged-only blob that no commit reaches shows in `…/index`, and
  `git fsck --connectivity-only` on this repository passes.
- An unmerged index gives no `…/index`, lists its paths, and still produces `…/worktree`.
- All four leaves coexist with branches named `index` and `worktree`, and `git for-each-ref refs/plainport` lists them.
- The user's index bytes, `HEAD`, branches, stash, config and `git status --porcelain=v2` are identical before and
  after.
- A kill before the transaction leaves no new refs. A kill inside it is reported as incomplete. A rerun after either
  replaces the set, and a rerun with no change is a no-op.

### Verification
`bun test packages/core -t compare && bun run test:t1 -t compare && bun run contract`

### Report
`.orchestrate/reports/task-26.md`

### Stop condition
All tests are green, and `help compare` explains the refs.

---

## Task 27 — The crash matrix over remote stores, and network faults  `T2`

### Objective
Both sagas and bootstrap survive death at every journal step against remote stores, and with the store cut or the
acknowledgement lost at the worst moments.

### Context
ADR-0017; `CONTRIBUTING.md` "The crash matrix"; Task 4's fault profiles; Tasks 8, 23 and 24.

### Scope
Owns `test/crash-matrix/`: a store dimension (local, MinIO, SFTP), a fault dimension (`cut`, `lost-ack`), and the
bootstrap rows.

- Faults at:
  - `commit.start`;
  - during the event append (`lost-ack`: the event lands and the client sees failure);
  - at release's re-read;
  - at the checked delete;
  - during onload's restore;
  - at every bootstrap step.
- `recover` runs once with the store still down (pending, nothing deleted) and once with it back.
- `PLAINPORT_CRASH_MATRIX_DAMAGE=1` still fails every row on every store kind.

### Tests first
The matrix is the test; new rows come from the exports.

### Verification
`bun test test/crash-matrix && bun run test:t1 -t crash && scripts/testenv up && bun run test:t2 -t crash`

### Report
`.orchestrate/reports/task-27.md`, with row counts per variant, store kind and fault.

### Stop condition
Every row is green in every variant, and the damage mode bites on every store kind.

---

## Task 28 — T3: real buckets and the Mac mini  `T3`

### Objective
Prove M2 against real bucket semantics and the Intel hub, or record exactly why it could not run.

### Context
ADR-0018 (T3), ADR-0013; Q8, Q19; Tasks 17 and 14.

### Scope
Owns `scripts/testenv.ts t3`, `test/t3/` and the T3 rows of the gate report.

- **References.** `.testenv/t3.env` (gitignored) holds only `op://` references. Values are read with `op read` in
  sensitive mode into child environments.
- **Prefixes.** Every run works under `plainport-t3/<run ulid>/`. Cleanup deletes only that prefix, and the lifecycle
  rule is the backstop.
- **Buckets:**
  - measured profiles for R2 and B2 (S3 API), with documented sources cited;
  - the contract and semantic suites;
  - `If-None-Match` on R2 (expected proven) and B2 (expected rejected);
  - Task 6's election on B2's non-conditional path;
  - bootstrap with two initialisers;
  - round trips with times;
  - sealed events.
- **The mini.**
  - `ssh mini` (`BatchMode=yes`) and `orb version`.
  - The darwin-x64 build in `~/plainport-t3/<run>/` (not installed): `--version` and a fixture round trip.
  - Schedules S2 and S3 between laptop and mini on R2 and on B2 (Q19), or Q19's (c).
  - Cleanup removes only the run folder, after checking its marker.

### Tests first
The harness at T0 with fakes: it refuses without every reference, refuses a prefix outside `plainport-t3/`, and its
cleanup touches only the run's prefix.

### Verification
`scripts/testenv t3 check`, then `bun run test:t3`.

### Report
`.orchestrate/reports/task-28.md`, with each check passed, failed (filed and fixed before Task 29) or pending (the
missing input named).

### Stop condition
Every T3 check passes; or the inputs are missing and the task ends `pending` with the exact list. Then Task 29 runs as
a T2 result.

**What the owner provides for T3.**
- 1Password items for:
  - an R2 bucket (`weur`) with a scoped key pair and its S3 endpoint;
  - a B2 EU Central bucket with a scoped application key and its S3 endpoint;
  - a restic test password.
- A seven-day lifecycle rule on `plainport-t3/` in both buckets.
- `op` signed in on the laptop.
- The mini online in Tailscale, with `ssh mini` working non-interactively, and an answer to Q19.

---

## Task 29 — Gate: the two-Mac race, and release v0.2.0

### Objective
Prove the gate under Q16's promise and Q17's lease definition on every available store kind, then release v0.2.0.

### Context
`docs/ROADMAP.md` M2 gate; ADR-0017, ADR-0019, ADR-0020; `CONTRIBUTING.md` "Releases"; Task 14's schedules.

### Scope
Owns `scripts/gate-m2.ts` and its test, the gate report and the release commits.

- **Store kinds.** Local (T1), MinIO and SFTP (T2, including MinIO with its conditional write switched off, so the
  non-conditional path races too), and R2 and B2 (T3) when Task 28 passed.
- **Schedules S1 to S8**, each followed by Task 3's tree comparison and the per-device invariants 1 to 6.
- **Eligibility (R2-6).** Profiles that fail a predicate (forced `publication: in-place`, `durability: unknown`, or
  `elect` failing) refuse exactly the operations Task 6's table says, and their offloads keep their folders.
  Successful round trips are claimed only for admitted profiles, with SFTP admitted through Q21's proof.
- **End-to-end flow:** `compare`, `resolve --keep`, an offload, then onload on the other device, which ends `local`
  and byte-identical.
- **Times.** One M1 demo project's times on each kind.
- **The full suite** at T0, T1 and T2, plus contract freshness, gitleaks, and the guard showing no schedule or
  compatibility todo remains.

### Tests first
Not applicable: this task runs the gate. The script is tested on a fixture with fakes.

### Verification
`bun scripts/gate-m2.ts --tiers 1,2[,3]`, `bun test`, `bun run test:t1`, `scripts/testenv up && bun run test:t2`,
`bun run contract --check`, and `bun run test:t1 -t compat`.

### Report
`.orchestrate/reports/task-29.md`, plus an M2 summary for `docs/HANDOFF.md`:
- results per store kind and schedule;
- Q16's promise and residual, word for word;
- the advisory lease;
- the compatibility matrix's user-facing rows (`store upgrade`, rollback);
- T3 status, with every unverified backend claim listed when it is a T2 result;
- times.

### Stop condition
Every schedule passes on every available kind and the full suite is green. Then the orchestrator:
1. merges into `main` and confirms CI is green, including the T2 job and the restic matrix;
2. cuts `v0.2.0` (ADR-0020) and sets `0.3.0-dev`;
3. marks ADR-0023 accepted;
4. updates `docs/HANDOFF.md`, `docs/ROADMAP.md` and `CHANGELOG.md`.

---

## Where astra's findings are resolved

| Finding | Resolved in |
| --- | --- |
| 1 Critical · concurrent repository initialisation | Q9 (b); Tasks 6, 8, 18, 27 |
| 2 Critical · secret output on runner failure paths | Task 5 (before Tasks 15 and 20); Q14 |
| 3 · the release race | Q16 (owner signs the promise); Tasks 14, 23, 24 |
| 4 · the claim needs stated consistency | Q8; Tasks 6, 17, 28 |
| 5 · `rcat` publication on SFTP | Task 6 (rules), Task 16 (temp-then-rename), Task 17 (measured) |
| 6 · ULID-time doubt | Task 21 (doubt without the clock) |
| 7 · competing resolutions | Q18; Task 12 (model), Task 25 |
| 8 · local state after a fork | Task 23 (transitions, base, journal), Task 25 |
| 9 · store aliases | Q11; Task 9 |
| 10 · M1 adoption, mixed versions | Q1, Q2; Tasks 7, 8, 19 |
| 11 · sealed recovery paths | Task 11 (one codec), Task 20 |
| 12 · crypto unspecified | Q10; Task 10 |
| 13 · non-additive changes | Q5, Q6; Task 7 (matrix with the real v0.1.1) |
| 14 · fingerprint v3 incomplete | Q5 (iii) deferred to M5 |
| 15 · lease ownership | Q17; Tasks 14, 22 |
| 16 · temporary-index recipe | Q18 (`compare` is `safe_write`); Task 26 |
| 17 · offline views need credentials | Task 13 |
| 18 · gate does not prove its claims | Task 14 (schedules, per-device invariants), Task 4 (`lost-ack`, restart), Task 17 (pagination, durability), Tasks 27–29; Q20 (invariant 6 scope) |
| 19 · graph and ownership | Dependency graph, shared-file rules, Tasks 5, 15, 16 ordering; old Task 10 split into Tasks 10, 11, 20 |
| Missing tasks 1–11 | 1 → Task 8 · 2 → Task 6 · 3 → Task 9 · 4 → Task 7 · 5 → Task 5 · 6 → Task 10 · 7 → Task 11 · 8 → Tasks 12, 23 · 9 → Task 13 · 10 → Task 14 · 11 → this revision's graph |

## Where astra's round-2 findings are resolved

| Finding | Resolved in |
| --- | --- |
| R2-1 · upgrade does not exclude running old clients; rollback deleters | Q2 (constrained, quiescent upgrade with an intent marker and a quiet window; owner attests other devices; stated residual; held trash at a step v0.1.1 leaves alone); Task 7 (real v0.1.1 paused before append and release; rollback `recover`, `gc`, `gc --now`, housekeeping, detached delete); Task 19 (`store.not-quiescent`); Task 24 (`offload.release.held`) |
| R2-2 · resolution production contradicts validation; causality incomplete | Q18; Task 12 (validation of every reference including `supersedes`, cycles, active set, incompatibility, live tips, production rule `resolutionFor`, expected-outcome rows); Task 25 (writes only through `resolutionFor`, validity asserted) |
| R2-3 · retained trash: recovery after rename, resolution, journal gate | Q16; Task 23 (fork stages F1 to F3); Task 24 (held-trash state machine; `held` journals do not block `resolve`, `compare` or `onload`; same-device crash → append → recover → resolve → reuse test); Task 25 |
| R2-4 · comparison refs cannot coexist; index objects | Q18; Task 26 (sibling leaves `HEAD`, `heads/*`, `index`, `worktree`; staged-only blobs copied by pack; unmerged index; one ref transaction; incomplete sets reported; rerun tests) |
| R2-5 · ULID-shaped legacy aliases | Q11 (location by containment; keys never interpreted; multi-entry events unsupported until M3); Task 9 (ULID-shaped alias tests; writer assertion) |
| R2-6 · semantics admission does not decide backends; SFTP durability | Q8 (typed properties, per-operation eligibility); new Q21 (SFTP admitted through a post-grace proof, owner choice); Task 6 (eligibility table); Task 17 (measured `acked-unsynced`, predicate tests); Task 18 (asserted profile until Task 24); Task 24 (the proof); Task 29 (refusal asserted for profiles that fail) |
| R2-7 · bootstrap tests demand a winner | Q9 (no-winner outcome); Task 6 (`won`, `lost`, `contested`); Task 8 (at most one published; contested outcome, cleanup and retry; crash rows) |
| R2-8 · Task 6 depends on Task 11's codec | Task 6 (injected `SameEvent` with a byte-equality fake); Task 11 (codec implements it and owns the acceptance test) |
