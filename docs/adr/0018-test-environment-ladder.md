# ADR-0018 — The test environment ladder: fakes, local Linux peers, the mini, a VPS (2026-10-02)

**Context.** plainport's riskiest behaviour crosses machines: SSH and Tailscale transport, append-only forced
commands, detached jobs that must survive logout under systemd and logind, macOS ↔ Linux round trips, and real
bucket semantics. The suite (ADR-0017) needs an environment for each, scriptable from a test run, free or nearly
free. On hand: an Apple M3 Pro laptop with OrbStack 2.2.3 and Docker; an Intel i3-8100B Mac mini on Tailscale;
Backblaze B2 and Cloudflare accounts.

Research: vault note `~/plainkeep/wiki/research/linux-test-hosts-sandboxes-and-stores-2026.md` (Grok lane,
2026-10-02: 29 of the owner's X bookmarks, 4 live posts, vendor pages checked that day).

**Verified on the laptop, 2026-10-02.** These were verified by running them; everything else rests on the note.

- `orb create ubuntu <name>` took **11 s** and gave Ubuntu 26.04.1 LTS, aarch64, with systemd 259 as PID 1 in
  state `running`.
- A logind drop-in with `KillUserProcesses=yes` takes effect after restarting `systemd-logind`.
  `systemd-run --user --unit …` starts a transient user service. Guests have **lingering on by default**, so a
  test that needs kill-at-logout must run `loginctl disable-linger` first.
- `/dev/net/tun` exists, so Tailscale can run in a guest.
- The root filesystem is **btrfs**: case-sensitive, with reflinks for the Linux warm-return path.
- No sshd by default. After `apt install openssh-server`, a key restricted with `command="…",restrict` in the
  guest's `authorized_keys`, reached from macOS as `<name>.orb.local`, ran only the forced command. The client's
  `rm -rf /` came back as `forced:rm -rf /`.
- Correction to the note: OrbStack 2.2.3 runs guest commands as `orb run -m <name> <cmd>` (or `orb -m <name> <cmd>`).
  The note's `orb -m <name> -- <cmd>` fails with "unknown flag --".

**Decision.**

| Tier | Tooling | Proves | Cannot prove |
| --- | --- | --- | --- |
| **T0** | `bun test`, port fakes, fast-check, in-process fault injection | Planner, fold, findings, saga logic, crash matrix (in-process) | Real binaries, real processes |
| **T1** | macOS host with pinned restic and rclone, sandboxed `HOME`s, an `ssh` shim, `hdiutil` APFS images (case-sensitive and not) | Engine contract, round trips, crash matrix with real `SIGKILL`, two sandboxed instances | Linux, real sshd |
| **T2** | **OrbStack Ubuntu machines** (`hub`, `vps`) on the laptop, built by cloud-init with sshd, forced-command keys and the logind drop-in, reset by delete-and-create (about 11 s). **Containers:** MinIO pinned by digest (SeaweedFS if the image is unavailable), `atmoz/sftp`, `restic/rest-server --append-only`, Toxiproxy | Move, leases and bindings across three SSH peers; append-only refusal; detached jobs under `KillUserProcesses=yes`; store contract including create-if-absent; network faults | Native x86_64 (OrbStack's x86 runs under Rosetta), the real macOS hub, WAN Tailscale |
| **T3** | **The Intel Mac mini** over Tailscale (`ssh mini`); **Cloudflare R2** (location hint `weur`, free tier), the real conditional-write bucket; **Backblaze B2 EU Central**, the offsite restic replica through native `b2:`. Bucket or prefix per run, keys scoped to one bucket and referenced as `op://` | darwin-x64 build, real APFS and launchd on the hub, WAN latency, real bucket semantics | A Linux VPS |
| **T4** | **One Hetzner Cloud CX23** (x86_64, Falkenstein or Nuremberg, Ubuntu 24.04 LTS) with SSH only over Tailscale; CAX11 if an arm64 VPS is needed | The M3 gate: MacBook → mini → VPS → MacBook; Linux without reflinks (ext4 copy fallback) | — |

Supporting rules:

- **CI** runs T0 and T1 on GitHub's macOS runners. A Linux job on `ubuntu-24.04` (which has Docker) builds the
  Linux binaries and runs the store contract against the T2 containers. OrbStack machines need the laptop, or a
  self-hosted runner later, so T2 machine suites run locally and at milestone gates.
- **Environments as code.** `scripts/testenv` brings each tier up and down, and a `compose.yaml` holds the store
  containers. Agents never hand-build an environment.
- **Store capabilities are measured, never assumed.** MinIO and R2 implement `If-None-Match: *`. B2 rejects the
  header. rclone's S3 backend may not forward it on the pinned version. So `BlobStore.capabilities()` reports
  `createIfAbsent` per backend, and the conditional-write test uses a direct HTTP client. This is consistent
  with `DESIGN.md`, where conditional writes are a bonus, not a requirement.

**Why.** Each tier proves something the one below can't. The cheap tiers run on every change and the expensive
ones at gates. OrbStack is already installed and free for personal use, gives a full systemd distro in seconds,
and passed every T2 check above.

**Rejected.**

- Hosted agent sandboxes (E2B, Daytona, Modal, Vercel Sandbox, Deno Sandbox, Cloudflare Containers) are
  short-lived code sandboxes. They offer no logind policy you control, no sshd forced command and no persistent
  tailnet node.
- Tart and Apple `container` are arm64-only and can't run on the Intel mini.
- Firecracker and Cloud Hypervisor need Linux KVM, which isn't available on the Mac.
- Oracle Always Free: Ampere capacity is often unavailable, and owners in its forums reported allowances being
  cut in August 2026.
- GCP e2-micro: free only in US regions.
- AWS's 2025 free plan: credits that run out, not an always-free VM.
- GitHub-hosted runners stay a smoke peer, not a tier.

**Consequences.**

- M2 adds `compose.yaml` and the R2 and B2 test buckets.
- M3 adds the cloud-init for `hub` and `vps`, and needs the CX23. The CX23 costs about €5.49 a month excluding
  VAT and IPv4 after Hetzner's June 2026 prices. An IPv6-only server reached over Tailscale may avoid the IPv4
  charge; that is unverified.
- **To check when the mini is online:** `orb version` on the i3-8100B. Coffee Lake should be supported, since
  OrbStack's cutoff is Broadwell. Fall back to Lima if it isn't.
- Retest rclone's `If-None-Match` on the pinned rclone in M2.

**Status.** Accepted (owner, 2026-10-02). The Hetzner spend starts at M3.

**Design.** Testing and fault injection; Machines; Storage (store kinds).
