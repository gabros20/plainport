# ADR-0020 — Versioning, release and install, the plainkeep way (2026-10-02)

**Context.** plainport needs a version anyone can name, pin and roll back to, a way onto three kinds of device
(the MacBook, the Intel mini, Linux workers), and a release routine that one person runs. plainkeep already
settled this and has run it since 4.0.8: a `VERSION` file, Keep a Changelog, release commits and `v*` tags,
and an engine installed as a versioned tree behind a `current` pointer with a rollback pair (plainkeep
ADR-017 and ADR-021).

**Decision.** Copy plainkeep's routine (ADR-0003); add nothing it doesn't have.

- **One version source.** `VERSION` at the repository root holds semver. Between releases it carries a `-dev`
  suffix (`0.1.0-dev`). The build bakes it into the binary; `plainport --version` prints it.
- **Changelog.** `CHANGELOG.md` in Keep a Changelog format with an `[Unreleased]` section. It records *what*
  changed; ADRs record *why*.
- **Release.** A release commit, `release: X.Y.Z`, drops the `-dev` suffix and dates the changelog section. It
  is tagged `vX.Y.Z`, and the next commit sets the next `-dev` version. Each milestone gate is a release: M1
  ships `v0.1.0`, M2 `v0.2.0`, and so on to `v1.0.0` at M6. A fix between milestones takes the patch number.
- **The contract has its own version.** `plainport_json: 1` and `plainport.json`'s schema version change only
  on a breaking contract change (ADR-0007), never with the app version.
- **CI** runs on push and pull request to `main`: typecheck, tests, compile smoke for every target, and a
  version consistency check (`VERSION` matches the tag on a release commit). This follows plainkeep's
  `.github/workflows/ci.yml`.
- **Toolchain pin.** `.bun-version` pins Bun, as plainkeep does (1.3.14 at the time of writing).
- **Install.** Each version installs into its own read-only directory,
  `~/.local/share/plainport/versions/<version>/`, with its bundled restic and rclone beside the binary.
  `~/.local/share/plainport/current` points at the active version, and `~/.local/bin/plainport` points through
  `current`. Activation is one atomic symlink replace. The previous version is recorded as the rollback target
  before every activation, and at least two versions are always kept.
- **Getting it onto other devices.** No package manager. From M3, `plainport device add` copies the matching
  platform build over SSH into the same layout and checks versions at pairing. Until then, `scripts/install`
  installs from a checkout.

**Not doing (owner, 2026-10-02).**

- No Developer ID signing and no notarization. Keychain access goes through Apple's `security` CLI
  (`DESIGN.md`, Security → Keychain prompts), and binaries installed by plainport carry no quarantine flag.
- No published checksum files and no Homebrew tap. Downloads of third-party tools are still verified against
  `tools.lock.json`, because that is an input check, not a release artifact.
- No Renovate or Dependabot. Dependencies and pinned tools are updated by hand in a reviewed commit, the way
  plainkeep does it.

**Why.** It's a routine the owner already runs and trusts. The versioned tree makes a bad release a one-command
rollback, and the gate-is-a-release rule gives every milestone a version to bisect against.

**Consequences.** `scripts/install` and `--rollback` are needed before the first release (M1 task 1 creates
`VERSION`, `CHANGELOG.md` and `.bun-version`; the M1 gate task writes `scripts/install`). ADR-0004 and ADR-0019
are amended to match.

**Status.** Accepted (owner, 2026-10-02: "check what we did in plainkeep").

**Design.** Security and encryption → Keychain prompts; Build plan.
