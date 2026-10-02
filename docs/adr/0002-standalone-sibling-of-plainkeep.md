# ADR-0002 — A standalone tool, a sibling of plainkeep (2026-09-30)

**Context.** plainkeep is the owner's mature personal-OS CLI. plainport could have been a plainkeep verb set.
plainkeep's ADR-006 keeps it single-machine with no server; its fifth principle forbids transmitting without a
human; it promises a stdlib-only Python floor; and its safety model is a path-wall around four roots.

**Decision.** Ship plainport as its own tool and repository, named as plainkeep's sibling. A thin plainkeep pack
(`plainkeep shelve | unshelve | send`) may follow once plainport has proven itself; it would call
`plainport … --json` and pass the envelope through.

**Why.** Moving work between machines is plainport's whole point, and every offload transmits. It needs
restic, rclone, age and a compiled TypeScript runtime. Its safety model is journaled sagas across machines,
not a path-wall. Forcing that into plainkeep would break four of plainkeep's principles. As a separate tool it is
also useful to developers who don't run plainkeep.

**Consequences.** plainport owns its own contract, release and docs. Shared ideas move by copying (ADR-0003),
not by a shared package. plainkeep's `archive` gap (it deletes a working tree without checking for
uncommitted, untracked or ignored files) is fixed in the plainkeep repository, not here.

**Status.** Accepted (owner, 2026-09-30).

**Design.** Summary; Prior art → plainkeep.
