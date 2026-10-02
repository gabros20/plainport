# Contributing to plainport

Most of plainport is built by coding agents dispatched with `/orchestrate`, and reviewed by the owner and by review
agents. These rules apply to everyone. `AGENTS.md` holds the rules that are not negotiable; this file holds how
work gets done and when it counts as done.

## The loop

1. Pick up the next task from the current milestone's plan in `docs/plans/` (see `docs/ROADMAP.md`).
2. Work on the local milestone branch (`m1-local-core`, …), never on `main`. The orchestrator merges into
   `main` at each phase boundary.
3. Write the failing test that states the task's acceptance. Run it and see it fail.
4. Implement until it passes. Keep commits small and by path (`git add <files>`), message `m<n>(task N): …`.
5. Run the task's verification commands, then the full T0 suite.

```sh
bun install
bun run typecheck && bun run lint
bun test              # T0: unit, fakes, in-process crash matrix
bun run test:t1       # adds real restic and rclone (after `bun scripts/fetch-tools.ts`)
bun run contract      # regenerates plainport.json and schemas/; commit the result
bun run build && ./dist/plainport --version
```

### Pinned restic and rclone

`bun scripts/fetch-tools.ts` downloads the restic and rclone that `tools.lock.json` pins into
`.tools/<os>-<arch>/` (gitignored), checks each archive's SHA-256 against the lock and refuses a mismatch without
writing anything. `--target all` fetches every target; `--dest <dir>` writes somewhere else. It needs the system
`bunzip2` and `unzip`.

plainport looks for each tool in this order and takes the first executable it finds:

1. `$PLAINPORT_TOOLS_DIR/restic` and `$PLAINPORT_TOOLS_DIR/rclone`: a flat folder holding the two binaries, no
   `<os>-<arch>/` level. An empty value is ignored, and a folder without the tool falls through to the next step.
2. Beside the compiled `plainport` binary, where releases bundle them. Skipped when running from source.
3. `.tools/<os>-<arch>/` in the checkout: this checkout's when running from source, or, for a compiled build such
   as `dist/plainport`, the nearest folder above the binary that holds `tools.lock.json`.

`PLAINPORT_TOOLS_DIR` is a developer and test override, not user configuration: use it to try other tool
builds or to point tests at fakes. If nothing is found, plainport stops with finding `tool.missing` and exit
code 6, naming every path it tried.

## Definition of Done

A task's review checks every line. A "no" sends it back.

- [ ] The acceptance test was written first, and the report shows its red run and its green run.
- [ ] Every bug fix has a test that fails without it.
- [ ] Tests touch only temp directories and the sandboxed home; nothing reaches the real home, real stores or
      agent folders.
- [ ] `bun run typecheck`, `bun run lint`, `bun test` and gitleaks pass; CI is green on `main` after the orchestrator's merge.
- [ ] If a command, output, exit code or finding changed: `bun run contract` was run and the regenerated files
      are committed, and `docs/machine-contract.md` agrees. A breaking contract change bumps the contract version.
- [ ] If behaviour changed: `docs/DESIGN.md` is updated in the same change, and a changed decision has a new
      ADR in `docs/adr/`.
- [ ] Code copied from plainkeep starts with a provenance comment naming the source path and commit (ADR-0003).
- [ ] Every child process goes through the one process runner; every side effect goes through a port.
- [ ] Expected failures return values with exit and finding codes; refusals name the finding code and the exact
      fix.
- [ ] No secret value is written to a file, log, config or fixture.
- [ ] `CHANGELOG.md` has a line under `[Unreleased]` for anything a user would notice.

## Releases

Each milestone gate is a release, and the routine follows plainkeep's (ADR-0020):

1. Merge the milestone branch into `main` and confirm CI is green on `main`.
2. Commit `release: X.Y.Z`: drop the `-dev` suffix from `VERSION`, and date the `[Unreleased]` section of
   `CHANGELOG.md` as `[X.Y.Z] — YYYY-MM-DD`.
3. Tag `vX.Y.Z` and push the commit and the tag.
4. Commit the next version as `X.Y+1.0-dev` with a fresh `[Unreleased]` section.
5. Update `docs/HANDOFF.md` and the status table in `docs/ROADMAP.md`.

No signing, notarization, checksum files or package-manager taps. Third-party tool downloads are still checked
against `tools.lock.json`.

## Updating dependencies

By hand, in a reviewed commit: bump the version in `package.json` or `tools.lock.json` (with the new checksums
from the project's official release), run the full suite including `test:t1`, and note it in `CHANGELOG.md`.
