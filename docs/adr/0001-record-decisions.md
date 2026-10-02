# ADR-0001 — Record decisions as ADRs beside the design (2026-10-02)

**Context.** The design was written in a claude.ai conversation and exported to `docs/DESIGN.md` with a flat
**Decisions** list of 26 one-liners. Coding agents will work on this repository across many sessions and need
the reasons behind each choice, not only the choice, so that they don't reopen settled questions or quietly
drift from them.

**Decision.** Keep `DESIGN.md` as the source of truth for behaviour. Record each load-bearing decision as a
numbered file in `docs/adr/`, in plainkeep's Context / Decision / Why / Status shape, and link it to the design
sections it governs. The Decisions list in `DESIGN.md` stays as the short index; ADRs carry the reasoning.

**Why.** One file per record makes diffs, links and supersession clean. Reusing plainkeep's shape means the
owner reads both projects the same way. Alternatives rejected: a single append-only log like plainkeep's
`docs/DECISIONS.md`, which reached 2,000 lines and is hard to link into; folding reasons into `DESIGN.md`,
which would bloat the behaviour spec.

**Consequences.** Every behaviour change touches `DESIGN.md` and, when it alters a recorded decision, a new ADR.
The roadmap's gates name the ADRs they depend on.

**Status.** Accepted (owner, 2026-10-02).

**Design.** Decisions; AGENTS.md "Read first".
