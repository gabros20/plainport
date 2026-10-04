# Changelog

Notable changes to plainport, newest first. The format follows [Keep a Changelog](https://keepachangelog.com).
The *why* behind decisions lives in the ADRs (`docs/adr/`); this file records *what changed*.

## [Unreleased]

### Added
- Opt-in headless agent smoke eval (`bun run eval:agent`) with isolated plainport state, call transcripts and contract issue scoring.
- Bun workspace scaffold: `packages/{core,contract,cli,engine-restic,blob-fs,eco-node,host-macos}`.
- `plainport --version` prints the version baked into the binary from `VERSION`.
- `scripts/install` installs plainport from a checkout as ADR-0020 lays it out: a read-only
  `~/.local/share/plainport/versions/<version>/` with restic and rclone beside the binary, a `current` link,
  `~/.local/bin/plainport` through it, and `--rollback` to the previous version (`--prefix` overrides `~/.local`).
  An installed build looks for its tools only beside itself, even a `-dev` one, and its fix says to reinstall.
- `bun scripts/gate-m1.ts`: the M1 gate. It round-trips pinned public demo projects through offload and onload
  (`--no-hydrate`) in a temp root and reports byte identity, the git checks and a performance baseline.
- Development guardrails: Biome (`bun run lint`), gitleaks (`bun run secrets`, through Docker), a pre-commit
  hook (`bun run hooks`), the home tripwire test preload, test tiers (`bun run test`, `bun run test:t1`) and CI
  on macOS and Ubuntu.
- Pinned restic 0.19.1 and rclone 1.75.1 in `tools.lock.json` for darwin-arm64, darwin-x64, linux-x64 and
  linux-arm64. `bun scripts/fetch-tools.ts` downloads them into `.tools/<os>-<arch>/` and refuses a checksum
  mismatch; `toolPath()` in `@plainport/core` finds them via `$PLAINPORT_TOOLS_DIR`, the binary's own folder,
  then `.tools/`.
