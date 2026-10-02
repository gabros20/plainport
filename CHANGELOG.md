# Changelog

Notable changes to plainport, newest first. The format follows [Keep a Changelog](https://keepachangelog.com).
The *why* behind decisions lives in the ADRs (`docs/adr/`); this file records *what changed*.

## [Unreleased]

### Added
- Bun workspace scaffold: `packages/{core,contract,cli,engine-restic,blob-fs,eco-node,host-macos}`.
- `plainport --version` prints the version baked into the binary from `VERSION`.
- Development guardrails: Biome (`bun run lint`), gitleaks (`bun run secrets`, through Docker), a pre-commit
  hook (`bun run hooks`), the home tripwire test preload, test tiers (`bun run test`, `bun run test:t1`) and CI
  on macOS and Ubuntu.
