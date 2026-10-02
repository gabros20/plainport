# ADR-0011 — Mac mini hub, SSH over LAN or Tailscale, no resident daemon (2026-10-01)

**Context.** The owner has a MacBook (Apple M3 Pro), an always-on Mac mini at home (Intel i3-8100B, reached as
`macminis-mac-mini.tail06e59f.ts.net` on Tailscale, SSH alias `mini`), and may add a VPS worker. The mini must
never open a port to the internet.

**Decision.**
- The Mac mini is the hub: it holds the main restic repository on its own disk and runs checks, offsite
  `restic copy` and (on request) pruning.
- Transport is the system's OpenSSH, on the LAN or over hosted Tailscale. `BatchMode=yes`, strict host keys,
  the user's `~/.ssh/config` applies; plainport never creates a ControlMaster. iroh is built only if Tailscale
  becomes a problem.
- Data plane: `rclone serve restic --stdio --append-only` behind a forced-command key. Control plane:
  `ssh <peer> plainport serve --stdio` (JSON-RPC).
- No daemon anywhere. The remote half of a move is a detached, journaled job (`systemd-run --user` with
  lingering on Linux, a detached process on macOS, `setsid` as fallback); `plainport attach` reconnects.
  Scheduled work is timers that each run one command and exit.
- The source device drives a move, so the laptop that typed the command can sleep.

**Why.** SSH and Tailscale are already installed and understood; nothing new to operate or secure. Detached
journaled jobs give OpenHarness-style durability (work survives a dropped link) without its resident daemon and
relay. Herdr's Teleport showed the value of destination-first planning and reusing the checkout left behind.

**Consequences.** Tests need real sshd peers on Linux and macOS, including one with logind
`KillUserProcesses=yes` (ADR-0018). The mini needs a `darwin-x64` build (ADR-0004).

**Status.** Accepted (owner, 2026-10-01).

**Design.** Machines; Decisions (hub, Tailscale, iroh, no daemon, source drives a move); Prior art → herdr
Teleport, OpenHarness.
