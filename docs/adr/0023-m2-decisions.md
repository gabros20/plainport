# ADR-0023 — M2 decisions (2026-10-10)

**Context.** The M2 plan (`docs/plans/M2-remote-stores.md`) put 21 questions to the owner: places where `DESIGN.md`
is silent, or where M2 changes a persisted format or the public contract. They were shaped by two architecture
reviews by gpt-6-astra. The owner approved Q1 to Q21 exactly as the plan recommended on 2026-10-10. The plan holds
the options and the reviewers' views; this record keeps the decisions and the reasons. ADR-0022's D74 is amended
by Q1.

**Decision.**

### A. Formats, compatibility and the contract

- **Q1. D74 is reworded.** On `v: 1`, an added field or event type is invisible to v0.1.x readers, not compatible
  with them: the schemas are strict, so such an event is skipped. Compatibility between versions comes from the
  store's format (Q2), never from additivity. *Reason:* the old wording overstated what strict parsers do.
- **Q2. Store format 2, a constrained upgrade and rollback-proof retention.** `meta/v1/store.json` at `v: 2` holds
  identity, repository location and seal policy, and stops every v0.1.x process that starts later. Stores v0.2
  creates are format 2; an M1 store stays format 1 until `plainport store upgrade <name>` (`confirm`). The upgrade
  runs only on a quiescent store (no open journal or lock here, no lease or unfinished operation by another device,
  no foreign event within 15 minutes, a marker written and re-checked) and refuses with `store.not-quiescent`; the
  owner attests the rest with `--others-stopped`. Trash held for Q16 is journaled at a step v0.1.1 does not know,
  so a rollback cannot delete it. *Reason:* HANDOFF prose is not a compatibility gate. **Accepted residual:** a
  v0.1.1 first offload on another device that holds no lease and outlasts the quiet window still releases as M1
  did, without Q16's grace; its event is M1-shaped and v0.2 reads it.
- **Q3. `resolved` is a new event type at `v: 1`,** written only to format-2 stores. *Reason:* Q2 keeps v0.1.x away;
  a new type does not need a version bump.
- **Q4. Per-store facts live in a sidecar,** `~/.local/state/plainport/stores/<store id>.json`, written atomically
  under a lock and invalidated when the endpoint, access kind, rclone or restic version changes. *Reason:* v0.1.1
  refuses a changed `registry.json`, which would break `scripts/install --rollback`.
- **Q5. Small formats.** (i) The trash claim's boot session goes into a sibling file, `<op>.claim.boot`, and the
  claim keeps M1's shape, since v0.1.1 treats an unreadable claim as gone. (ii) A restic tag `plainport:mode=<octal>`
  lets `onload --snapshot S` under an uncertain head set the folder's mode. (iii) Fingerprint v3 for git
  maintenance locks is deferred to M5: `fp` is a published closed value, and the offload that retries once and then
  refuses loses nothing.
- **Q6. Offload's exit-8 data keeps `kind: "fork"`** and gains an optional `detail: "after-commit"`. *Reason:* the
  closed enum is public; D16 allows added optional properties.

### B. Stores, secrets and the catalog

- **Q7. S3 credentials are separate references:** `secret` (the restic password), `accessKeyId` and `secretAccessKey`,
  all required, plus optional `region` and `path`. Temporary session credentials are not supported in M2. A config
  using these keys is refused by v0.1.x, so a rollback means removing the store's lines.
- **Q8. Every backend has a semantics profile** of typed properties (read-after-write and list-after-write
  visibility, listing completeness, publication, conditional create, durability on acknowledgement, cancellation),
  each marked `measured`, `documented` or `asserted`. Each operation has its own eligibility predicate. A store that
  fails one refuses that operation with `store.semantics-unknown` and stays usable for the others. *Reason:*
  "S3-compatible" and "eventually consistent" are different properties.
- **Q9. Bootstrap uses per-attempt repositories and an elected publication.** Each attempt initialises restic at
  `repos/<attempt ulid>/`; the winner publishes `store.json` v2 naming its repository. A loser stops and never
  writes. Elections use a conditional create where proven, else the sole-candidate rule on a strong profile; with
  no winner both refuse until a quiesced manual cleanup. Bootstrap is journaled and recoverable, and the root claim
  uses the same election. *Reason:* two devices running `restic init` at one location can leave two master keys in
  one repository.
- **Q10. Sealed catalog events.** The key is HKDF-SHA256 from the repository's master key under a versioned spec
  (Task 10). The policy is fixed at bootstrap in `store.json` v2 and pinned by each device at first contact. An
  existing plaintext store is never sealed in place; new `s3` and `sftp` stores are sealed by default. If the spec
  finds the derivation unworkable the task stops for the owner; there is no silent fallback. *Reason:* a password-
  derived key would break with M3's per-device keys.
- **Q11. Snapshot locations by containment.** Until M3's replication each snapshot event has exactly one `stored`
  entry, and a reader takes the location from the store it read the event from, never interpreting the key. Writers
  use the store's id on format 2 and M1's alias on format 1. An event with zero or several entries is skipped and
  makes the fold uncertain. *Reason:* two devices may name one store differently, and a ULID-shaped alias must not
  be misread.
- **Q12. A project's home store.** An offload refuses unless the store's catalog holds this copy's base or it is a
  first offload (`store.history-elsewhere`). Stores are compared by id, and an offline home store still refuses by
  its mirror.
- **Q13. Store commands.** `store list` is `read`; `store test` and `store add` are `safe_write`; `store upgrade` and
  `store remove` are `confirm`, and `remove` is local only and refuses `store.in-use`. `store test` writes, reads and
  deletes one probe key and reports `delete: denied | allowed | unreachable`; a denied delete is never called
  "append-only", which needs repository-wide proof (M3).
- **Q14. Secret providers.** `keychain:<service>/<account>` (read through `security`, written only by `store add
  --secret-stdin`) and `op:` (`op read`), after the runner's sensitive mode, with a 30-second deadline on any
  provider call. An unanswered Keychain prompt is `store.secret-missing`. `se:` and `bw:` stay refused.
- **Q15. `init --store-path` refuses to re-point an unreachable pinned name.** Re-pointing an unplugged disk stays
  possible through `config.toml`, checked at use (D68). *Reason:* it closes F5 from the M1 review.
- **Q21. Durability.** Stores whose writes are acknowledged before they are synced (SFTP) are admitted for release
  with proof: before Q16's checked delete, and no earlier than the grace period after the commit, re-read the event
  and check that restic still lists the snapshot. Missing data keeps the trash and reports `store.lost-write`. The
  same proof runs on every remote store. A server that loses acknowledged data later than the grace period is out
  of scope, as for any single store, and the gate checks that a store failing the predicate refuses release.

### C. Races, leases and conflicts

- **Q16. What M2 promises in a race.** On a remote store, release still renames into the trash and writes the stub,
  but holds the trash for a conflict grace (default 15 minutes, `offload.conflictGrace`). Every delete entrance reads
  the catalog fresh before deleting; a fork naming the snapshot keeps the trash as `conflict-retained`, and an
  unreachable store keeps it too. The promise: **a released folder is deleted only after a catalog read, taken at
  least the grace period after its commit, showed no fork naming its snapshot.** Every verified snapshot stays in
  the store and the catalog. *Reason:* no finite run of reads closes the gap between a device's last read and its
  rename, so "both folders kept" cannot be guaranteed. **Accepted residual:** a fork appended after that final
  read can lose a folder's local copy, never its snapshot. Exclusive coordination with fencing needs a conditional
  write on every store, so it is not in M2.
- **Q17. Leases are advisory.** A lease is the fold's single selected holder. `warn` allows a second working copy;
  `strict` refuses an onload when a holder is observed at its fresh read but cannot exclude a simultaneous one.
  Invariant 5 becomes "the fold names at most one holder, and a device that observed a holder under `strict` never
  onloads". A race that slips through ends, at offload, in a fork, never in a lost update.
- **Q18. `resolve <project> --keep <snapshot>` (`confirm`)** appends `resolved {keep, over, supersedes}` under a
  causal model: `over` is the tips the fresh read observed minus `keep`; `supersedes` is every active resolution it
  observed; invalid references, self-reference and cycles are invalid; concurrent incompatible resolutions stay
  conflicted until one supersedes both; a kept snapshot descending from a rejected tip is a live tip again. While
  this device holds a working copy, `--keep` must name that copy's snapshot. `plainport compare <project>`
  (`safe_write`) writes the `refs/plainport/theirs/<snapshot>/…` refs in one atomic transaction as sibling leaves.
  `resolve --both` waits for M3.
- **Q19. The T3 race across two Macs** passes test-scoped values from the laptop over SSH on stdin into the child's
  environment, under a fixed protocol, a restricted child environment and a documented rotation step; otherwise the
  race runs on the laptop alone. The owner supplies the T3 inputs later in M2.
- **Q20. M2 leaves out:** breaking a stale lease, device names in the lease view (ids until M3), `resolve --both`,
  B2's native `b2:` backend (B2 is reached through its S3 API), the REST server as a store kind, fingerprint v3 (Q5)
  and key-level proof that a device cannot delete snapshots. Invariant 6 in M2 means plainport issues no delete or
  overwrite of snapshots or events; key-level proof arrives with M3's append-only keys.

**Why.** M2 puts the first remote bytes behind plainport's deletes. Each answer either keeps v0.1.x away from
content it would misread (Q1 to Q5, Q11) or says plainly what a race can and cannot cost (Q16, Q17, Q21), so the
gate can test a promise that is true.

**Consequences.** `DESIGN.md` states the Q16 promise and its residual, and HANDOFF carries both accepted
residuals (Q2 and Q16) at release. A task that adds or changes a persisted format adds a row to Task 7's
compatibility matrix. A changed decision gets a new ADR. Q1 amends ADR-0022's D74.

**Status.** Accepted (owner, 2026-10-10: "Q1–Q21 as recommended").

**Design.** Storage: engine and metadata; Machines; Catalog and data model; Edge cases (races and leases);
Configuration; CLI design; Security and encryption.
