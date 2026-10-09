# Changelog

Notable changes to plainport, newest first. The format follows [Keep a Changelog](https://keepachangelog.com).
The *why* behind decisions lives in the ADRs (`docs/adr/`); this file records *what changed*.

## [0.1.0] — 2026-10-09

First milestone (M1, local core): plainport offloads and onloads projects on one Mac, against a store on a local
folder or an external disk. Run decisions behind the details are in ADR-0022.

### Added

Commands (all 16 live in one registry; each declares a risk class and `read`/`safe_write` commands run freely
while `confirm` ones need `--yes`, or exit 3 with the command to re-run):

- `plainport init`: names the device, records its roots and the store (`--root`, `--store-path`,
  `--store-secret`, `--device`). It refuses a store whose identity differs from the one recorded under that name,
  and a store that overlaps a project.
- `plainport root add | bind | list | scan`: roots, this device's folder for each, and project discovery.
- `plainport offload <project>`: scans the project, builds a plan (`--dry-run`, then `--plan <id>`), checks it
  (uncommitted, unpushed and stashed work, open files, running processes, Docker mounts, unreadable files, links
  leaving the folder), snapshots it with restic, verifies the snapshot against the folder, then releases the
  folder to a trash that a detached delete clears. A `.plainport` stub stays behind. Only regenerable,
  untracked dependency and build folders are left out of the snapshot (`--keep-deps` keeps them); `.env` files,
  local databases and `.git` travel. `--allow <code>` overrides an allowable blocker.
- `plainport onload <project>`: restores into a staging folder, verifies, swaps it into place, then reinstalls
  dependencies from the lockfile through the Node plugin (npm, pnpm, Yarn Classic and Berry, Bun). `--to` lands it
  elsewhere, `--snapshot` restores an older snapshot, `--no-hydrate` restores the files only. A failed install
  never undoes a good restore (exit 10).
- `plainport restore <project> --snapshot <id> --to <path>`: a side-by-side copy with no lease and no install.
- `plainport hydrate` and `plainport dehydrate`: install a project's dependencies again, or remove only what a
  plugin claims and git does not track.
- `plainport status` and `plainport ls`: one project in detail, with what to do next, or every project (`--root`,
  `--local`, `--shelved`, `--sort`). They never write to a store.
- `plainport recover`: settles every interrupted operation from its journal, rolling back what had not committed
  and finishing what had. After a commit it releases the folder only if the folder still matches the verified
  snapshot; otherwise it keeps it (`offload.diverged-after-commit`).
- `plainport gc`: deletes released trash past its `keepLocalFor` deadline and abandoned staging folders;
  `--now` (confirm) deletes kept trash early. It never deletes a path inside a registered project.
- `plainport help [<command>]` and `plainport version`.

Contract and safety:

- The `--json` envelope, exit codes 0 to 11 and the finding catalogue are the public contract (`plainport_json: 1`).
  `plainport.json`, the JSON Schemas in `schemas/` and the bash and zsh completions are generated from the registry
  by `bun run contract`; `docs/machine-contract.md` documents them. NDJSON event lines come before the one final
  envelope.
- Every destructive step is journaled. The local folder is touched only after the snapshot is verified and the
  catalog event is durable. The crash matrix (`test/crash-matrix/`) kills both sagas at every journal step and after
  every side effect and checks six invariants; the in-process variant runs in `bun test`, the SIGKILL variant in
  `bun run test:t1`.
- The catalog is immutable event files folded into state, with deterministic head, lease and conflict rules.
  A skipped or unreadable event makes onload refuse (`catalog.head-uncertain`) rather than restore an older
  snapshot.
- The install environment drops `RESTIC_*`, `RCLONE_*`, `PLAINPORT_*` secrets and any variable named by a
  configured `env:` secret reference. Package scripts run during hydration in M1.
- Config: `config.toml` (yours) and `managed.toml` (plainport's) with merge rules and a write lock; a device file
  and a project registry in plainport's own state folder.

Deletion safety (D83 to D88, ADR-0022):

- One guarded deleter. Every recursive delete (the detached trash delete, `gc`, housekeeping, `recover`, staging
  cleanup) first inspects the actual tree and refuses to delete a mount point, a plainport store, a restic
  repository, or anything that is or lies inside a registered project's folder. A refusal keeps the folder, leaves
  the journal pending and reports `delete.guard-refused` with the reason and the way out, then `plainport gc`.
- A detached delete that refuses leaves a note beside the trash. `status`, `ls` and `gc` show it, and housekeeping
  prints it without trying again. Offload's result says `deleteStarted: true` when the copy's delete has started,
  because the folder is only freed once the delete's own check passes.
- New findings: `store.inside-project` (a local store and a project overlap; setup, `root add`, `root bind`,
  offload and its release refuse), `path.reserved` (a destination or root inside a `.plainport-*` holder, in any
  letter case), `delete.guard-refused`, `catalog.head-uncertain` (an event the catalog could not read may hide a
  newer snapshot), `store.identity-changed` (now also from `init`, which enforces the store's recorded identity)
  and `project.unregistered` (a folder under a root that is not registered yet).
- When the head is uncertain, `onload --snapshot S` and `restore --snapshot S` restore the newest snapshot this
  device knows from the repository by its tag, and the next offload builds on it.
- `recover` rolls back an onload interrupted at its start unless it was reusing the kept copy.

Tooling, install and checks:

- `scripts/install` installs plainport from a checkout as ADR-0020 lays it out: a read-only
  `~/.local/share/plainport/versions/<version>/` with restic and rclone beside the binary, a `current` link,
  `~/.local/bin/plainport` through it, and `--rollback` to the previous version (`--prefix` overrides `~/.local`).
  It keeps only the current and previous versions, refuses a release from a dirty tree, takes an install lock,
  sweeps what an interrupted install left, and checks restic and rclone against `tools.lock.json`. An installed
  build looks for its tools only beside itself, even a `-dev` one, and its fix says to reinstall.
- `bun scripts/gate-m1.ts`: the M1 gate. It round-trips five pinned public demo projects through offload and onload
  (`--no-hydrate`) in a temp root and reports byte identity, the git checks (unpushed commit, stash, index, edits,
  untracked files, `fsck`) and a performance baseline.
- Opt-in headless agent smoke eval (`bun run eval:agent`) with isolated plainport state, call transcripts and
  contract issue scoring.
- Bun workspace scaffold: `packages/{core,contract,cli,engine-restic,blob-fs,eco-node,host-macos}`.
- `plainport --version` prints the version baked into the binary from `VERSION`. Release builds compile the
  crash-matrix test hooks out.
- Development guardrails: Biome (`bun run lint`), gitleaks (`bun run secrets`, through Docker), a pre-commit
  hook (`bun run hooks`), the home tripwire test preload, test tiers (`bun run test`, `bun run test:t1`) and CI
  on macOS and Ubuntu.
- Pinned restic 0.19.1 and rclone 1.75.1 in `tools.lock.json` for darwin-arm64, darwin-x64, linux-x64 and
  linux-arm64. `bun scripts/fetch-tools.ts` downloads them into `.tools/<os>-<arch>/` and refuses a checksum
  mismatch; `toolPath()` in `@plainport/core` finds them via `$PLAINPORT_TOOLS_DIR`, the binary's own folder,
  then `.tools/`.

### Known limits

See "Known limits" in `docs/HANDOFF.md`: macOS and local stores only, one device, metadata fingerprints, and the
gate ran without installs.
