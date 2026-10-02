# ADR-0018 — The test environment ladder: fakes, local Linux peers, the mini, a VPS (2026-10-02)

**Context.** plainport's riskiest behaviour crosses machines: SSH and Tailscale transport, append-only forced
commands, detached jobs that must survive logout under systemd and logind, macOS ↔ Linux round trips, and real
bucket semantics. The test suite (ADR-0017) needs environments for each, scriptable from a test run, free or
nearly free. Hardware on hand: an Apple M3 Pro laptop with OrbStack and Docker installed, and an Intel
(x86_64) Mac mini on Tailscale. Cloud accounts on hand: Backblaze B2 and Cloudflare.

**Decision (draft).** Five tiers, defined in `docs/ROADMAP.md`:

| Tier | Purpose | Tool (to be confirmed by the research) |
| --- | --- | --- |
| T0 | Unit, fakes, in-process crash matrix | `bun test` |
| T1 | Real restic and rclone, sandboxed homes, `ssh` shim, APFS images | macOS host, `hdiutil` |
| T2 | Local Linux sshd peers with systemd and logind; store servers; network faults | _pending research_: OrbStack machines, Lima or containers with systemd; MinIO, SFTP and rest-server containers; Toxiproxy |
| T3 | Real hardware and buckets | The Mac mini over Tailscale; B2 and R2 with per-run prefixes and scoped keys |
| T4 | A remote Linux VPS over Tailscale | _pending research_: free-tier or cheap EU VM |

**Why.** Each tier proves something the one below can't, and the cheap tiers run on every change while the
expensive ones run at gates.

**Consequences.** To be completed when the research note
`~/plainkeep/wiki/research/linux-test-hosts-sandboxes-and-stores-2026.md` lands.

**Status.** Proposed. Research running (M0 task 0.4).

**Design.** Testing and fault injection; Machines.
