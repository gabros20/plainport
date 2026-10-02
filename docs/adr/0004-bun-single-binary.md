# ADR-0004 — TypeScript on Bun, one compiled binary per platform (2026-09-30)

**Context.** plainport must install as one file on a MacBook (arm64), the Mac mini hub (Intel, x86_64) and
Linux VPS workers (x64 and arm64), run without a language runtime on the target, and share one core with a
later TUI and desktop app.

**Decision.** Write plainport in TypeScript and compile it with `bun build --compile` for `darwin-arm64`,
`darwin-x64`, `linux-x64` and `linux-arm64`. No native modules. Workspaces use Bun's own workspace support;
`DESIGN.md`'s "pnpm workspace" note under Package layout is corrected to Bun workspaces when M1's scaffold
lands. Require Bun 1.2.21 or later (see ADR-0003).

**Why.** Bun gives a single static binary per target, a fast test runner and TypeScript without a build
step, and the owner's plainkeep core already ships this way. A native module would force per-platform build
machinery and break cross-compiling. Rejected: Go or Rust, which would lose the shared TypeScript core with
the TUI and the Zod-to-JSON-Schema path to the SwiftUI app; Node with a bundler and `pkg`/SEA, which is heavier
to cross-build.

**Consequences.** Everything that would need a native binding goes through a pinned external binary run by the
one process runner (restic, rclone, age, OpenSSH, git). The Intel mini needs the `darwin-x64` target in CI from
M3 on. Release builds need a stable Developer ID signature so Keychain doesn't prompt after every update.

**Status.** Accepted (owner, 2026-09-30).

**Design.** Decisions (Runtime: Bun); Core API → Package layout; Security → Keychain prompts.
