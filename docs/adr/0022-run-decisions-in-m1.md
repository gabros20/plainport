# ADR-0022 — Run decisions carried into M1 (2026-10-04)

**Context.** The M1 run (`/orchestrate`, branch `m1-local-core`) settled many questions the design left open or got
wrong. Each was logged as a numbered run decision (D1 to D88) in `.orchestrate/decisions.md`, which is gitignored
as run state (ADR-0019). More than a hundred tracked files cite those numbers, in `docs/DESIGN.md`,
`docs/machine-contract.md`, the finding catalogue and code comments, so a future reader finds a D-number with no
definition behind it. The final review (I7) asked for the ones that changed behaviour, persisted formats or the
public contract to be written down somewhere tracked.

**Decision.** This record defines them. Where a decision was revised during the run, only its latest wording is
given. Process-only decisions (model routing, review lanes, CI waits, toolchain pins, who merges when) are left
out; they stay in the run log. A decision marked **flagged** was made by the controller under the owner's
delegation of format and API calls (2026-10-04) or was named for owner review in the final reviews. The owner
reads those before M2 builds on them. After v0.1.0, changing a persisted format or the public contract needs the
owner (D73).

### Contract and output

- **D12 (flagged).** NDJSON finding lines use the nested Core API shape `{type:"finding", op, finding:Finding}`,
  and DESIGN's flat CLI example is corrected. One typed schema serves every frontend.
- **D14.** An error envelope may carry `data` when the operation produced a useful partial result: exit 10
  (restored, not hydrated) carries the snapshot and project; exit 8 the kept snapshot; exit 6 from a `--dry-run`
  the plan whose blockers caused it. Otherwise `data` is absent.
- **D16.** Published output schemas allow additional properties, so additive changes do not break consumers.
  Inputs plainport parses (arguments, config, files it owns) stay strict.
- **D17.** Event line types are open: a reader passes through or skips an unknown type. Phase and `ProjectState`
  values are closed; adding one is a contract change and bumps `plainport_json`.
- **D18.** `--dry-run` is always risk class `read`. A command that cannot dry-run refuses `--dry-run` as
  `usage.invalid` (exit 2) before running.
- **D19.** `plainport.json` has the shape `{schema, plainport_json, globalOptions, commands, exitCodes,
  findings}` and carries no app version. Commands list their risk, dry-run and plan support, positionals,
  options, output schema and examples. New findings: `command.unknown` (4), `usage.invalid` (2),
  `internal.unexpected` (1). The hint is `re-run: <cmd>` for `risk.needs-yes`, else the finding's fix.
- **D76 (flagged).** New finding `project.unregistered` (exit 4) for an existing folder under a root that is not
  registered yet; its fix names `offload <root>:<folder> --dry-run` and `root scan`. `project.not-found` stays for
  a folder that does not exist or a name nothing knows.
- **D77 (flagged).** Offload's output omits `trash` when `localCopy` is `deleted`, and the dry run omits the
  arrival step when the strip set is empty (onload then installs nothing back).
- **D81 (flagged).** Ctrl-C under `--json` with no saga running prints an `operation.cancelled` failure envelope
  and exits 130.
- **D9.** `PLAINPORT_TOOLS_DIR` is a developer and test override for locating restic and rclone. It is documented
  in `CONTRIBUTING.md`, not as configuration.

### Plans, commands and lifecycle

- **D36.** `--dry-run` stays `read`: it changes nothing in the project, its roots or any store, but saves its plan
  under plainport's own state (`plans/<id>.json`, one hour). `offload <project> --plan <id>` runs it; a fresh plan
  whose fingerprint still matches is the approval, with no `--yes`.
- **D38.** A dry run whose plan holds a `block` finding exits 6 with the plan as error data, and that plan is never
  approvable. `offload` takes `<project…>` in the schema, but M1 accepts exactly one and refuses more with
  `usage.invalid`. Offload re-runs preflight and checks the fingerprint before running an approved plan.
- **D50.** `--dry-run` applies `--allow`, the plan records the allow list, and approval compares it. `--verify
  full` is refused with `usage.invalid` until M5 implements it, never silently downgraded.
- **D58.** `restore <project> --snapshot <id> --to <path>` (`safe_write`, no lease, no hydration, never into an
  occupied path) is built in M1, because onload's refusals point users at it.
- **D59.** Only `plainport recover` replays a journal. The start of any write command deletes trash past its
  `keepLocalFor` deadline (under the project lock, detached) and names every interrupted journal on stderr. A
  write command on a project with an open journal refuses with `journal.pending`. Amends ADR-0008.
- **D61.** `--dry-run` and every read-class command skip that deletion and only print notices.
- **D44.** Onload refuses while the head is incomplete (`catalog.incomplete`) or conflicted. `restore --snapshot
  --to` stays allowed in both states.
- **D60.** `restore --snapshot` defaults to the head when it is known; when the head is incomplete or conflicted,
  `--snapshot` is required. Restore is not journaled: a crash leaves only `<parent>/.plainport-staging/<op>`,
  which `gc` removes once no live operation owns it.
- **D56.** Ctrl-C during hydration after a good restore exits 130; the project stays `restored-unhydrated` and
  `hydrate` retries. `onload --to` into a free path is allowed unless this project's own copy stands at its place
  (`project.already-local`, fix: `restore --to` for a side-by-side copy), so a device never holds two working
  copies.
- **D57.** `onload --adopt` waits for M3's warm return. `dehydrate` stays unjournaled: it removes only
  dependency folders a plugin claims and git does not track, and `hydrate` repairs a crash mid-way.
- **D71.** `onload --dry-run` is a real agent need, found by the live eval. It is scheduled for M2, not built in
  M1. Offload's dry run says that hydrate is skipped when onload reuses the kept copy.
- **D72 (flagged).** An empty `.plainport-staging` or `.plainport-trash` is removed by `rmdir` when the operation
  that emptied it ends. An onload whose offload stripped nothing ends `local` even with `--no-hydrate`. Offload's
  result names the local copy as `deleted`, `kept` or `waiting` (`localCopy`).
- **D75 (flagged).** D72 confirmed as is, after the final review.

### Config, roots and setup

- **D20.** `managed.toml` always lives beside the `config.toml` in use. A fresh CLI run with a broken
  `config.toml` fails with `config.invalid` (exit 6); the last good config applies only to long-lived processes.
- **D22.** `device.json` gains a required `name` (`init --device`). Root commands before `init` return
  `device.none` (6). `init --store-path` sets up a local store, named by the global `--store` (default `local`).
  `registry.json` is `{v:1, projects:{<ulid>:{root, path, override?, base?, onloadedAt?, registeredAt}}}`.
  `root bind --device` accepts only this device until pairing (M3).
- **D23.** `root scan` registers projects in `registry.json`, so it is `safe_write`; `root list` stays `read`.
- **D46.** Device names start with a letter: a digit-led hostname becomes `host-<slug>`, one that slugifies to
  nothing becomes `this-device`. An invalid `--device` exits 2. (Bun's TOML parser reads a digit-led bare key as a
  number.)
- **D68 (flagged).** `config.toml` may override any field of a managed store, including `kind`, but the result must
  still reach the same store identity, or every command refuses with `store.identity-changed`. A kind change is
  accepted only when it points at the same physical store; a different store needs a new name.
- **D70 (flagged).** `init`'s folder scan shows each candidate's size, from a walk that skips dependency folders
  and stops after two seconds per candidate (shown as `≥ size`). Sizes never block `init`. Built with the M2 setup
  work.
- **D85 (flagged).** `init` enforces the store identity pin: when `registry.stores[name]` has an id, a store
  answering with another id, or none, is refused with `store.identity-changed` before anything is written. The id
  is recorded only on first setup.
- **D83 (flagged).** No overlap between a project and a local store. Setup, the offload plan, the step before
  release and `recover` refuse (`store.inside-project`, not overridable) when a project's folder contains a local
  store's path or the reverse, by real path, case-folded, symlinks resolved, against every registered store. Overlap
  is also found by file identity (device and inode), the live release reads the configured stores again right
  before the rename, and `root add` and `root bind` refuse a root that is or lies inside a local store. Found
  by the final second opinion: a store under a stripped folder would be deleted with the release.
- **D84 (flagged).** Reserved holders (`.plainport-staging`, `.plainport-trash`, anything named `.plainport-*`) are
  never a project destination for `onload --to`, `restore --to` or root registration. `gc` and housekeeping fail
  closed: a holder child that is, contains or lies inside a registered project's effective path is never deleted,
  and deletion takes the project lock when one applies. A reserved segment is matched in any case, so
  `.PLAINPORT-staging` on a case-insensitive volume is `path.reserved` too. Found by the same second opinion: `gc` could delete an
  onloaded working copy.

### Scan, preflight and strip set

- **D29.** New findings `proc.cwd-shell` (warn, allowable, exit 6) for plainport's own ancestor shell or agent
  harness with its working directory inside the folder, and `git.failed` (block, exit 1) for an unexpected git exit.
- **D30.** With `requirePushed`, unpushed work becomes the blocker `git.unpushed-required` (exit 6) instead of
  `git.unpushed`. Severity is fixed per code.
- **D32.** A `.git` that is a FIFO, socket or device blocks as `fs.unreadable` (fail closed). Host file-system
  calls have no per-call deadline in M1; revisit for network mounts in M2.
- **D33.** Every git call sets `GIT_CEILING_DIRECTORIES` to the project's parent (a parent path containing `:`
  blocks with `git.failed`). `fs.link-outside` warns for absolute and relative links that leave the project.
  Limits: `lsof` sees only the current user, docker only the current context and only `Type=bind` mounts,
  unpushed counts `HEAD` and branches but not tags, and nested repositories are not listed.
- **D34.** Preflight git calls disable system config, system attributes and git-lfs filters. A repository's own
  clean filters can still run during `git status`; git has no switch for all drivers.
- **D37.** Strip and deps settings precedence: CLI flags, then the project's `.plainport.toml`, the root's
  tables, the global tables, and defaults. Tables merge by key; arrays replace. The plan's `largest` list excludes
  paths inside `.git`.
- **D39.** `strip.keep` and `strip.never` (gitignore syntax, project-relative) match strip candidates only. A
  candidate holding a kept candidate is kept too (`strip.kept`). `strip.extra` supports negation. Tracked status
  folds names by NFC and full case folding, which only ever keeps more.
- **D53.** Nested registered projects are decided by each project's effective folder. An operation takes the lock
  of every registered project inside it and of the one containing it (`lock.held`, exit 11). Offloading a folder
  that contains another registered project is blocked (`project.nested`). Fingerprint re-checks exclude stripped
  paths, so a watcher writing to a stripped cache does not fail an offload.
- **D69 (flagged).** The D33 limits are accepted for M1 and scheduled: tags not on any remote (M2), every docker
  context and named volumes with bind options (M5), `lsof` for all users when privileged (M5), nested repositories
  in the plan (M2).

### Engine, store and catalog

- **D26 (flagged).** restic tag values are percent-encoded (`,` as `%2C`, `%` as `%25`, plus edge whitespace and
  control characters) and decoded on read. Every project path stays representable and stock restic reads the tags.
  This is a persisted format.
- **D27.** The Engine port returns Results, is bound to one repository, and ships `init`, `snapshot`, `list`,
  `entries`, `restore` and `check` in M1. `stream` and `forget`/`prune` arrive in M5.
- **D28.** restic exit 3 leaves an incomplete snapshot in the repository. Offload journals its id and writes a
  `snapshot-discarded` event; the fold never treats a discarded snapshot as a head; `doctor --rebuild-catalog` and
  `prune --yes` (M5) handle the rest.
- **D40.** The BlobStore port returns Results and `list()` returns an array. New findings `store.unreachable` (9),
  `store.failed` (1), `store.key-exists` (1), `catalog.event-skipped` (warn). Fold ties: an onload sits between
  the snapshot it restored and that snapshot's children; among open onloads the one furthest along the chain holds
  the lease, then the smallest event id; equally deep heads give `head = null` (conflicted).
- **D41.** A project is conflicted when any kept snapshot has two or more kept children. An unknown base marks the
  head incomplete and onload refuses until the events are synced. Offloaded and checkpointed events need a
  non-empty stored map. `blob-fs` create-only uses `link()`, falling back to `O_CREAT|O_EXCL` where hard links
  do not exist.
- **D42.** Without hard links, `appendEvent` completes its own torn write when the existing file is a strict byte
  prefix of the same event; anything else refuses with `store.key-exists`. `blob-fs` skips `._*` sidecars and
  `.DS_Store`.
- **D43.** An `onloaded` event records the catalog head when written (`over`), so onloading an older snapshot is
  a forward step, never a fork. `state.json` carries a fold version and a digest, and rebuilds on any mismatch.
- **D45.** Read commands never write to a store: the mirror only downloads. Each store has
  `meta/v1/store.json {v, id}`, and the mirror is keyed by that id. A mismatch refuses with
  `store.identity-changed`. The mirror records `lastSyncedAt`, so "never synced" differs from "stale".
- **D48.** One restic repository per root is enforced: a store serves one root, recorded at first use, and a
  second root naming it is refused (`store.root-mismatch`). Plan approval binds the store's identity.
- **D50 (root claim).** Before any root-created event, a store is claimed by an exclusive create of
  `meta/v1/root.json`. It is never overwritten (D51). Stores without create-if-absent (rclone and S3, M2 on) need a
  conditional write for the claim.
- **D55.** New finding `snapshot.not-found` (4). The `offloaded` event gains optional `rootMode` (the folder's mode
  bits), applied on onload.
- **D73 (flagged).** The catalog event schema gains optional `stats.stripped` (how many strip-set entries the
  offload left out) on `offloaded` and `checkpointed`. `onload --no-hydrate` ends `local` only when it is 0; absent
  means unknown and stays `restored-unhydrated`. An onload that runs a successful install ends `local`.
- **D74 (flagged).** Event schema `v: 1` is frozen at the v0.1.0 tag, including `stats.stripped` and `rootMode`.
  Dev builds from before d131f2a do not read stores written by newer builds. After the tag, a change is
  additive-optional or bumps `v`.
  **Amended 2026-10-10 (ADR-0023, Q1):** the catalog event schemas are strict objects, so an added field or
  event type makes a v0.1.x reader skip the event (`catalog.event-skipped`); it is invisible to v0.1.x, not
  compatible with it. Changes go through new types on format-2 stores or a version bump, and compatibility
  between versions is enforced by the store's format, never by additivity.
- **D86 (flagged).** A skipped (unreadable or unsupported) state-changing event makes the fold uncertain.
  Head-dependent defaults (onload, offload's fork rule, `gc`'s keep decisions) refuse with
  `catalog.head-uncertain` when the stub's or registry's known snapshot is not named by any readable event. Only
  an explicit `--snapshot` proceeds. Found by the final second opinion: an unreadable newest event let onload
  restore an older snapshot silently. The way on is the newest snapshot this device knows (the stub's or the
  registry's): `onload --snapshot S` and `restore --snapshot S` find S in restic by its operation tag, and `onload`
  writes S, not the older fold head, as its `over` and as the registry's base.

### Sagas, release and recover

- **D24.** Host file systems use plain `fsync`, not `F_FULLFSYNC` (Bun has no `fcntl`). Sagas stay correct if a
  power loss drops the last journal or catalog write, and recovery never deletes a folder on a write that might
  not have reached the disk.
- **D47.** `HostPorts.detach` is the one exception to AGENTS rule 6: it starts only plainport's own detached
  trash delete, a fixed command on a journaled path. A stub is written only where nothing exists or this
  project's own stub stands; anything else is the blocker `path.stub-occupied`.
- **D51.** From `commit.start` on, recovery finishes release only while the folder's fingerprint equals the
  verified one. Otherwise it keeps the folder, leaves no stub and reports `offload.diverged-after-commit` with the
  snapshot id; the next offload's base is that snapshot.
- **D52.** The live offload runs the same fingerprint guard right before the rename to trash (exit 8 on a
  change). The git fsmonitor daemon is stopped during preflight. Every side effect has a fault point after it as
  well as before, so the crash matrix reaches "effect done, journal not advanced".
- **D54.** M1 hydration runs the plugin's frozen install with package scripts on (confirmed by the owner,
  2026-10-03). A project's `hydrate.command` and hooks never run in M1 and are reported as skipped; `--ignore-scripts`
  arrives with `plainport trust`. New findings: `path.occupied`, `fs.case-collision`, `fs.no-space`,
  `project.nested` (all 6), `lease.held` (warn; 8 when leases are strict), `hydrate.failed` (10),
  `toolchain.mismatch` (warn).
- **D79 (flagged).** The install environment drops `RESTIC_*`, `RCLONE_*`, `PLAINPORT_*` secrets and any variable
  named by a configured `env:` secret reference, and `help onload` says so.
- **D62.** A fork event that `recover` rebuilds at `offload.diverged` records files and bytes from the snapshot's
  listing, `strippedBytes` 0, no ecosystems and the folder's `rootMode`.
- **D63.** An operation counts as running only while its process holds the project's lock, taken since this host
  booted. An unreadable journal whose project id parses holds back only that project and those nested with it;
  one naming no project holds back every project.
- **D64.** Trash has one deleter at a time: the detached delete writes a claim (device id, pid, boot time) first,
  and housekeeping, `gc` and `recover` skip a trash whose claim is from this device, this boot and a live pid.
  `recover`'s exit code is the most severe outcome across projects: 8, 7, 6, 11, 9, 5, 10, 4, 3, 2, 1, 0. Recover
  routes by one exhaustive step-to-rule table per saga; an unknown step stays pending.
- **D65.** A cancelled `recover` exits 130 whatever D64's order says.
- **D66.** Project views are built lazily and only for the projects a command needs. Folder sizing never walks
  dependency folders. The view model lives in core; the CLI only renders.
- **D67.** The detached delete removes the trash, then its claim, then the journal. The crash-matrix test hook is
  compiled out of release builds and a test checks the release binary holds none of its names.

### Deletion guard and late recover fixes

- **D87 (flagged).** One guarded deleter. Every recursive delete plainport makes (the detached trash delete, `gc`,
  housekeeping, `recover`'s trash deletes and roll-backs, staging cleanup, a renamed-back trash's leftovers) runs a
  guard immediately before deleting, over the actual tree and independent of config and path spelling. It walks
  with `lstat` and never follows links, and it refuses when: a directory is a mount point (a different device from
  the tree root); the tree holds a plainport store marker (`meta/v1/store.json`) or a restic repository (a restic
  key in `keys/` beside `config` and `data/`), anywhere, stripped folders included; the tree is, holds or lies
  inside a registered project's folder (a path that cannot be resolved refuses); or the config does not read
  cleanly. A refusal leaves the journal pending with `delete.guard-refused`, naming the reason and the way out,
  then `plainport gc`. The detached delete runs the guard in its own process right before it deletes. This replaces
  patching overlap cases one by one; the D83 and D84 path checks stay as early, friendly refusals.
- **D87 follow-ups (flagged).** A refusing detached delete leaves `<op>.refused` with its finding. Housekeeping
  prints a notice and does not relaunch; `status`, `ls` and `gc` report it. Offload says `deleteStarted` (the delete
  has started and checks the folder first) instead of claiming the copy is freed. A refused or failed launch puts
  back the `keepUntil` that housekeeping took off, so the kept trash can still be renamed back. A folder this
  user cannot read is opened up before the guard refuses.
- **D88 (flagged).** `recover` routes `onload.begin` through the swap check only when the journal records reuse
  mode; an ordinary restore-mode onload interrupted there rolls back, so a folder made at the destination
  afterwards is never taken for the onload's own. `onload` and `restore --snapshot S` under an uncertain head reach
  the tag lookup even when no readable event names the project, taking its project and root identity from the
  validated stub and registry.

### The M1 gate

- **D11.** The gate round-trips five public demo projects at pinned commits instead of the owner's real projects:
  nextjs/saas-starter, t3-oss/create-t3-turbo, Skolaczk/next-starter, planetscale/nextjs-planetscale-starter and
  rajput-hemant/nextjs-template. It adds a `.env`, an uncommitted edit, an untracked file, a staged file, a stash
  and an unpushed commit to each before the offload.
- **D13.** No `node_modules` is installed for the demo projects (limited disk). The gate onloads with `--no-hydrate`
  and compares trees minus stripped paths; hydration is proven on tiny fixtures only.
- **D78 (flagged).** D11 and D13 are accepted for the M1 gate. ROADMAP, DESIGN and HANDOFF say so. One
  owner-run gate on a real project with hydration on is suggested before M2, not required.
- **D80 (flagged).** This record. `.orchestrate` stays gitignored.
- **D82 (flagged).** M1's known limits are stated in `docs/HANDOFF.md`.

**Why.** A number that cites a decision nobody can read is not a citation. Copying the decisions here keeps them
reviewable beside the code. The run log stays out of git because it holds run state and process noise.

**Consequences.** `docs/DESIGN.md` and `docs/machine-contract.md` keep citing D-numbers; this record is where
they are defined. The flagged decisions are persisted formats or public API. Changing one after v0.1.0 breaks a
store or a consumer, so the owner reviews them first. Process decisions from the run are not carried.

**Status.** Proposed. The decisions stand as built in v0.1.0. The flagged ones become Accepted when the owner
agrees (ADR rule 3).

**Design.** Offload process; Onload process; Storage: engine and metadata; Catalog and data model; CLI design;
Testing and fault injection; Build plan.
