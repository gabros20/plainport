# ADR-0021 — The factory floor: guardrails that make agent-built code trustworthy (2026-10-02)

**Context.** Most of plainport will be written by coding agents dispatched through `/orchestrate`. Rules in
`AGENTS.md` only hold if something checks them. plainkeep's ADR-019 names the failure mode: a guardrail that
nothing consults does nothing.

**Decision.** Each rule gets a check, introduced when the milestone that needs it starts.

| Guardrail | What it enforces | When |
| --- | --- | --- |
| **Pull requests per milestone** | Work lands on `m<n>-…` branches. A pull request into `main` carries CI and the review trail, and merges only with CI green. GitHub can't enforce branch protection on a private repository on the Free plan, so the orchestrate gate checks `gh pr checks` before merging | M1 |
| **Biome** | Formatting and lint in one fast tool, in CI and before each commit | M1 task 1 |
| **gitleaks** | No secret reaches git. Fixture `.env` files are generated at test time and never committed, which also keeps them clear of the agents' `.env` read ban | M1 task 1 |
| **Home tripwire** | A `bun test` preload points `HOME`, `XDG_*`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `GROK_HOME` at a temp directory, and the host port refuses any path under the real home during tests. "Tests never touch the real home" becomes a failing test | M1 task 1 |
| **Test tiers as commands** | `bun run test` runs T0; `test:t1` adds real binaries. Later tiers get their own scripts plus `scripts/testenv up|down` and a `compose.yaml` (ADR-0018). Agents never build an environment by hand | M1, M2, M3 |
| **Linux CI job** | `ubuntu-24.04` builds the Linux binaries from day one, and from M2 runs the store containers | M1 task 1 |
| **Agent permissions** | `.claude/settings.json` in plainkeep's shape: allow the dev surface (bun, git, orb, docker, restic, rclone, gh), deny reading `.env` files, force-pushing and `rm -rf` | M0 |
| **Definition of Done** | `CONTRIBUTING.md` lists what every task's review checks: tests went red then green, contract regenerated, `DESIGN.md` and ADRs updated with any behaviour change, provenance comments on copied plainkeep code | M0 |
| **Agent eval smoke** | A headless agent completes `offload` and `onload` on a fixture using only `plainport help` and `--json`. It runs outside `bun test`, against a sandboxed plainport config and store. This is the M4 gate, started early so the contract gets agent feedback from M1 | M1 task 16 |
| **Threat model** | `docs/THREAT-MODEL.md`: stolen laptop, compromised worker, malicious project hooks, rogue agent, curious store provider, each mapped to an invariant and the test that proves it | Before M3 |
| **Performance budgets** | Benchmarks for a 200,000-file offload and onload, with memory bounds, tracked per release | M5 (baseline at M1's gate) |
| **Version matrix** | CI across supported restic versions, agent CLI versions (M4) and macOS versions | M2 onward |
| **Diagnostics bundle** | `plainport doctor --bundle`: journal, redacted config and versions, for bug reports | M5 |

**Why.** Each row turns a sentence in `AGENTS.md` or `DESIGN.md` into something that fails loudly. They are cheap
if added when the code they guard is first written, and expensive to retrofit.

**Consequences.** M1 task 1 grows (Biome, gitleaks, tripwire, Linux CI, `VERSION`, `CHANGELOG.md`,
`.bun-version`). M1 gains task 16 (agent eval smoke); the gate becomes task 17.

**Status.** Accepted (owner, 2026-10-02, with Renovate, signing and the Homebrew tap removed; see ADR-0020).

**Design.** Testing and fault injection; AGENTS.md "Rules that are not negotiable" and "Testing".
