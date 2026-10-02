# ADR-0019 — Delivery: milestone plans run with `/orchestrate`, a release per gate (2026-10-02)

**Context.** Coding agents will build plainport over many sessions. The owner coordinates them with the
`/orchestrate` skill, which reads a plan file's `## Task N` sections into briefs, dispatches workers and gates them
with spec and quality reviews.

**Decision.**
- `docs/ROADMAP.md` holds the phased roadmap: milestones M0–M6, each split into phases and tasks with
  acceptance tests, dependencies and the ADRs its gate needs.
- Each milestone gets one plan file, `docs/plans/M<n>-<name>.md`, written when the previous milestone's gate
  passes (rolling wave). Tasks are `## Task N` sections that `orchestrate`'s `task-brief` can extract
  unchanged: objective, scope (packages owned), tests to write first, verification commands, report path,
  stop condition.
- Default run: `/orchestrate docs/plans/M<n>-….md strategy=staged review=dual`; tasks marked parallel-safe
  may run `strategy=parallel` in worktrees.
- Git: all development happens locally on a branch per milestone (`m1-local-core`), managed by the
  orchestrator, with small commits per task. No pull requests: the orchestrator merges into `main` at each phase
  boundary and pushes, CI runs on `main`, and the gate cuts the milestone's release (`v0.1.0` for M1, ADR-0020).
  `main` is pushed to the public GitHub repository `gabros20/plainport` (MIT, like plainkeep).
- `.orchestrate/` run state is local and gitignored; durable outcomes go into `docs/HANDOFF.md` and the
  roadmap's status column.

**Why.** Plans as files survive context resets and let any agent pick up the next task. Milestone tags make each
gate a fixed point to bisect against.

**Consequences.** `docs/HANDOFF.md` stays the "where things stand" note and is updated at every gate.

**Status.** Accepted (owner, 2026-10-02).

**Design.** Build plan; AGENTS.md "Working style".
