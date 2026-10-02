# Architecture decision records

One file per decision, numbered in order, never renumbered. `docs/DESIGN.md` stays the source of truth for
behaviour; an ADR records **why** a load-bearing choice was made, what it costs, and where in the design it lands.

## Format

Each record uses plainkeep's shape so the two projects read alike:

- **Context**: the problem and the forces at play.
- **Decision**: what we do, stated so a reviewer can check code against it.
- **Why**: the reasons, including what we rejected.
- **Consequences**: what this costs or forces later.
- **Status**: `Accepted` (owner agreed), `Proposed` (waiting on the owner or on a milestone to confirm it), or
  `Superseded by ADR-NNNN`.
- **Design**: the `DESIGN.md` sections it governs.

## Rules

1. A decision that changes behaviour updates `DESIGN.md` in the same commit (AGENTS.md, "Read first").
2. Accepted records are not edited for substance. Change course with a new record that supersedes the old one,
   then mark the old one `Superseded`.
3. `Proposed` records become `Accepted` only with the owner's agreement, and the commit message says so.
4. Each milestone gate in `docs/ROADMAP.md` lists the records it depends on; a gate does not pass while
   one of them is still `Proposed`.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-record-decisions.md) | Record decisions as ADRs beside the design | Accepted |
| [0002](0002-standalone-sibling-of-plainkeep.md) | A standalone tool, a sibling of plainkeep | Accepted |
| [0003](0003-reuse-plainkeep-contract-by-copy.md) | Reuse plainkeep's contract by copying, never by depending | Accepted |
| [0004](0004-bun-single-binary.md) | TypeScript on Bun, one compiled binary per platform | Accepted |
| [0005](0005-stack-libraries.md) | Libraries: Zod, smol-toml, a typed command registry | Proposed (confirm in M1) |
| [0006](0006-restic-data-rclone-metadata.md) | restic for project data, rclone for catalog metadata, both pinned | Accepted |
| [0007](0007-machine-contract.md) | The machine contract: envelope, exit codes, risk classes | Accepted |
| [0008](0008-sagas-journal-recover.md) | Journaled sagas; the folder is touched only after verification | Accepted |
| [0009](0009-catalog-as-event-files.md) | The catalog is immutable event files folded into state | Accepted |
| [0010](0010-roots-one-repository-each.md) | Every project lives under a root; one restic repository per root | Accepted |
| [0011](0011-hub-ssh-no-daemon.md) | Mac mini hub, SSH over LAN or Tailscale, no resident daemon | Accepted |
| [0012](0012-append-only-deletion-needs-human.md) | Append-only keys; deletion needs a human | Accepted |
| [0013](0013-secrets-envelope-and-custody.md) | Secrets envelope, key custody and no lent tokens | Accepted |
| [0014](0014-agent-state-adapters.md) | Agent state moves to the same agent only, fail closed | Accepted |
| [0015](0015-agent-kit-ledger.md) | The agent kit lives in dotfiles and is ledger-owned | Accepted |
| [0016](0016-frontends-last.md) | Frontends last: TUI, then a SwiftUI app over `serve --stdio` | Accepted |
| [0017](0017-test-strategy-tdd-and-crash-matrix.md) | Test-first, invariants and the crash matrix | Accepted |
| [0018](0018-test-environment-ladder.md) | The test environment ladder: fakes, local Linux peers, the mini, a VPS | Proposed (research pending) |
| [0019](0019-delivery-milestones-orchestrate.md) | Delivery: milestone plans run with `/orchestrate`, a commit and tag per gate | Accepted |
