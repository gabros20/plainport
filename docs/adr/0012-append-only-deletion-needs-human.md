# ADR-0012 — Append-only keys; deletion needs a human (2026-10-01)

**Context.** A compromised laptop, ransomware or a rogue agent with plainport's credentials could otherwise
erase every snapshot, including the offsite copy.

**Decision.** Every device writes to the hub through a forced-command SSH key limited to `--append-only`. The
hub writes offsite with an append-only bucket key. `plainport forget` only files a `forget-requested` event; after
the delay (default seven days) `plainport prune --yes` applies it, fetching the delete-capable key from the
password manager for that one run. Nothing deletes on a timer.

**Why.** Separating the ability to add from the ability to delete is the only defence that survives a fully
compromised client. The delay gives time to notice and `forget --cancel`.

**Consequences.** Invariant 6: nothing but `prune --yes` deletes or rewrites a snapshot, and no key on a laptop
or worker can. The append-only suite runs `forget` and `prune` through the forced command and expects refusal.

**Status.** Accepted (owner, 2026-10-01).

**Design.** Security and encryption (append-only access, deletion); Machines (data plane).
