# plainport

plainport keeps coding projects portable across machines and storage. `offload` snapshots a project, verifies
the snapshot and deletes the local copy; `onload` restores it and reinstalls dependencies; `move` hands a project,
and what coding agents remember about it, to another device; `kit` keeps agents' skills and MCP servers the same
on every device.

**Status:** early development (milestone M1). Nothing here is ready to use yet; see `docs/ROADMAP.md`.

## Develop

Needs Bun 1.2.21 or later (`.bun-version` pins the one CI uses) and, for the secret scan, Docker.

```sh
bun install
bun run typecheck && bun run lint
bun test                     # T0
bun run test:t1              # T0 plus the suites that run real binaries
bun run build && ./dist/plainport --version
bun run secrets              # gitleaks over the git history
bun run hooks                # install the pre-commit hook
```

`docs/DESIGN.md` is the design, `AGENTS.md` holds the rules for coding agents and `CONTRIBUTING.md` says when a
change is done.

## License

MIT
