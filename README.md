# plainport

plainport keeps coding projects portable across machines and storage. `offload` snapshots a project, verifies
the snapshot and deletes the local copy; `onload` restores it and reinstalls dependencies; `move` hands a project,
and what coding agents remember about it, to another device; `kit` keeps agents' skills and MCP servers the same
on every device.

**Status:** v0.1.0, milestone M1 (local core). It works on one Mac, against a store in a local folder or on an
external disk. Remote stores, other devices, `move` and `kit` are not built yet; see `docs/ROADMAP.md`.

## What v0.1.0 does

- `plainport offload <project>` snapshots a project with restic, verifies the snapshot against the folder, and
  only then frees the folder. A `.plainport` stub stays behind. `--dry-run` shows the plan first.
- `plainport onload <project>` restores it, checks it, swaps it into place and reinstalls dependencies from the
  lockfile (npm, pnpm, Yarn or Bun).
- `plainport recover` finishes or rolls back an operation that was interrupted, from its journal.
- `plainport gc` deletes released trash once its `keepLocalFor` deadline has passed.
- `init`, `root add | bind | list | scan`, `status`, `ls`, `restore --to`, `hydrate` and `dehydrate` round it out.
  `plainport help` lists every command with its risk class.

Only regenerable dependency and build folders that git does not track are left out of a snapshot. `.env` files,
local databases and uncommitted work travel with the project. Every command takes `--json` and has a documented
exit code, so coding agents can drive it (`docs/machine-contract.md`).

## What v0.1.0 does not do

One device, local stores, macOS only, and dependencies are reinstalled for Node projects only. No SFTP or S3 store, no pairing or `move`, no agent
state or kit, no `prune`, no TUI. The known limits are in `docs/HANDOFF.md`.

## Install from a checkout

Needs Bun (see `.bun-version`) and, for the secret scan, Docker.

```sh
bun install
bun scripts/fetch-tools.ts     # the pinned restic and rclone
scripts/install                # builds, then installs under ~/.local
plainport --version
plainport help
```

`scripts/install` puts a read-only copy in `~/.local/share/plainport/versions/<version>/` and points
`~/.local/bin/plainport` at it through `current`. `scripts/install --rollback` returns to the previous version;
`--prefix <dir>` replaces `~/.local`. Make sure `~/.local/bin` is on your `PATH`. A first run:

```sh
export PLAINPORT_STORE_PASSWORD=...   # the store's repository password; `init --store-secret` names another source
plainport init --root 'work=~/work' --store-path /Volumes/Archive/plainport --yes
plainport offload work:my-app --dry-run
plainport offload work:my-app --yes
plainport onload work:my-app
```

## Develop

Needs Bun 1.2.21 or later (`.bun-version` pins the one CI uses) and, for the secret scan, Docker.

```sh
bun install
bun run typecheck && bun run lint
bun test                     # T0
bun run test:t1              # T0 plus the suites that run real binaries
bun run build && ./dist/plainport --version
bun run secrets              # gitleaks over the git history
bun run hooks                # install the pre-commit hook
```

`docs/DESIGN.md` is the design, `AGENTS.md` holds the rules for coding agents and `CONTRIBUTING.md` says when a
change is done.

## License

MIT
