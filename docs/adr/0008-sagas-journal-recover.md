# ADR-0008 — Journaled sagas; the folder is touched only after verification (2026-09-30)

**Context.** plainport deletes local project folders, the one thing that can lose work. Laptops sleep,
networks drop and processes get killed mid-operation.

**Decision.** Offload is an eight-phase saga and onload a nine-phase one. Every phase boundary is written to a
journal on disk (`~/.local/state/plainport/journal/<op>.json`). The local folder is touched only in offload's
release phase, after the snapshot is verified against the scan manifest and the `offloaded` event is committed.
Release renames the folder into `<root>/.plainport-trash/` and deletes it from a detached process.
`plainport recover` and the start of any command replay the journal: before the commit it rolls back, after it
finishes. Defaults: verification `manifest` (`--verify full` on request); `keepLocalFor = 0`.

**Why.** A rename-then-delete with a journal makes every interruption resolve to a stable state without a
distributed transaction. Restic exit code 3 (unreadable files) is a hard failure, never a partial success.

**Consequences.** The crash matrix (ADR-0017) kills the process at every journal step and checks the six
invariants. Onload never merges into an existing folder; a failed install never undoes a good restore.

**Status.** Accepted (owner, 2026-10-01).

**Design.** Project lifecycle; Offload process; Onload process; Testing → invariants.
