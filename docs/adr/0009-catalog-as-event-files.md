# ADR-0009 — The catalog is immutable event files folded into state (2026-09-30)

**Context.** Several machines record what happened to a project, sometimes at the same moment, through stores
that may lack compare-and-swap, with clocks that disagree.

**Decision.** The catalog is append-only JSON events with ULID names under `meta/v1/events/` on each store,
written create-only where the store allows. State is a pure fold: status follows the chain of `base`
references, not timestamps; two `offloaded` events with the same `base` make the project `conflicted`; a lease
is an `onloaded` event with no later `offloaded` or `lease-broken`. Snapshot IDs are plainport ULIDs, mapped to
each store's restic ID. Replication is a set union. `state.json` is a rebuildable cache, and
`doctor --rebuild-catalog` rebuilds `meta/` from restic tags alone.

**Why.** Immutable, uniquely named files can't be corrupted by concurrent writers, and folding in any order
gives the same result (invariant 4). No database, nothing to operate.

**Consequences.** Fold rules get property tests (fast-check). Conflicts surface at fold time and resolve through
`plainport resolve`. Bucket and VPS stores seal events (ADR-0013).

**Status.** Accepted (owner, 2026-10-01).

**Design.** Catalog and data model; Testing → invariants 4 and 5.
