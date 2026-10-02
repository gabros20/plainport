# ADR-0017 — Test-first, invariants and the crash matrix (2026-10-02)

**Context.** plainport is judged by one property: never losing a project. plainkeep was built test-first, with
contract round-trip tests, a differential parity oracle and fixture corpora, and the owner wants the same
discipline here.

**Decision.**
- **Test-first.** Every task in a milestone plan starts by writing the failing test that states its
  acceptance; implementation follows. Every bug fix comes with a test that fails without it.
- **Invariants over coverage.** The six invariants in `DESIGN.md` are asserted after every integration and
  crash test by one shared helper.
- **Crash matrix.** For both sagas, kill the process at every journal step (an injected fault through the host
  port, plus a real `SIGKILL` subprocess variant), run `recover`, assert the invariants.
- **Real binaries where they matter.** Engine and store contract suites run against real restic, rclone and
  store servers, plus recorded JSON-lines fixtures per supported restic version.
- **Sandboxes only.** Tests never touch the real home, real stores or real agent folders.
- **Contract pinned.** `--json` envelopes, exit codes and `plainport.json` are validated against their schemas
  and snapshot-tested.
- **Byte-identical round trips** (minus stripped paths) by tree hash.

**Why.** Line coverage says nothing about a half-finished delete. Invariants plus the crash matrix test the one
property that matters at every point where it could break.

**Consequences.** The fault-injection seam is part of the host port from M1, not bolted on later. Slow suites
(real restic, containers, VMs) are tagged so `bun test` stays fast locally; CI and milestone gates run all
tiers (ADR-0018).

**Status.** Accepted (owner, 2026-10-02: "TDD base like plainkeep").

**Design.** Testing and fault injection; AGENTS.md "Testing".
