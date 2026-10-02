# ADR-0010 — Every project lives under a root; one restic repository per root (2026-10-01)

**Context.** The same project lives at different paths on each machine (`~/work` on the MacBook,
`~/Developer/Work` on the mini, `/srv/work` on a VPS), and a worker should be able to see work projects without
seeing personal ones.

**Decision.** A project is addressed as root plus relative path (`work:clients/acme/web`) and identified by a
ULID. Each device binds each root to its own path; a move changes only the root prefix. A folder outside every
root must be filed with `--root` and `--as` before offload. Each root gets its own restic repository and key.

**Why.** Root-relative addresses make moves land in the right place on every machine. A restic key opens a whole
repository, so separate repositories are the only way to give a device one root and not another.

**Consequences.** Overlapping roots are rejected (`root.overlap`). An unbound root on the target blocks a move
(`root.unbound`), fixable from any device. Roots on unmounted volumes show as `unavailable`.

**Status.** Accepted (owner, 2026-10-01).

**Design.** Roots: where projects live on each device; Configuration.
