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
bun run contract      # regenerates plainport.json, schemas/ and completions/; commit the result (CI runs --check)
bun run build && ./dist/plainport --version
```

### Pinned restic and rclone

`bun scripts/fetch-tools.ts` downloads the restic and rclone that `tools.lock.json` pins into
`.tools/<os>-<arch>/` (gitignored), checks each archive's SHA-256 against the lock and refuses a mismatch without
writing anything. `--target all` fetches every target; `--dest <dir>` writes somewhere else. It needs the system
`bunzip2` and `unzip`.

How plainport finds each tool:

- **`PLAINPORT_TOOLS_DIR` set** (a developer and test override, not user configuration): only
  `$PLAINPORT_TOOLS_DIR/restic` and `$PLAINPORT_TOOLS_DIR/rclone` are tried. It is a flat folder, with no
  `<os>-<arch>/` level. If the tool isn't there, plainport stops; it never falls back to other binaries, so tests
  that point it at fakes stay hermetic. An empty value counts as unset.
- **Otherwise**, the first executable among:
  1. the folder of the compiled `plainport` binary, where releases bundle them. Symlinks to the binary are
     resolved. This is skipped when running from source.
  2. `.tools/<os>-<arch>/` in a checkout: this checkout's when running from source, or, for a development build
     (`VERSION` ends in `-dev`) such as `dist/plainport`, the nearest folder above the binary that holds
     `tools.lock.json`. Release builds never look here, and neither does a build `scripts/install` made
     (`scripts/build.ts --installed`), whatever its version.

If nothing is found, plainport stops with finding `tool.missing` and exit code 6, naming every path it tried.
The fix it prints depends on the case: run `bun scripts/fetch-tools.ts` (source and development builds),
reinstall plainport (release and installed builds), or put the tool in `PLAINPORT_TOOLS_DIR` or unset it.

### Installing from a checkout

`scripts/install` (after `bun scripts/fetch-tools.ts`) builds the binary and installs it as ADR-0020 lays it out:
`~/.local/share/plainport/versions/<version>/` holds `plainport`, `restic`, `rclone` and `build.json` (the commit),
read-only; `~/.local/share/plainport/current` points at the active version and `~/.local/bin/plainport` points
through it. A release installs as `<version>` and only from a clean tree; a dev build installs as
`<version>+<UTC build time>.<commit>[.dirty]`. A version already installed from the same commit is activated again
rather than rebuilt; one installed from another commit is refused. After an install only `current` and `previous` (the
rollback target) are kept, and an install first sweeps the `.staging-*` folders and `.tmp-*` links an interrupted
one left. restic and rclone must match `tools.lock.json` (their pin files); `--tools <dir>` bundles other binaries
and skips that check. `scripts/install --rollback` makes the previous version current again; `--prefix <dir>`
replaces `~/.local`. Tests use only temp prefixes.

### The crash matrix

`test/crash-matrix/` kills both sagas at every journal step and after every side effect, runs `recover` and checks
the six invariants (ADR-0017). Its rows come from the sagas' exported steps, seams and branches, so a new step adds
rows by itself; a new branch must say how each variant reaches it. The in-process variant runs in `bun test` (T0);
the SIGKILL subprocess variant runs in `bun run test:t1` and, on macOS, puts the project on a case-sensitive APFS
disk image it makes with `hdiutil` and deletes afterwards.

The subprocess variant drives the compiled binary through a test hook, not configuration: `PLAINPORT_TEST_FAULT_AT`
(with `PLAINPORT_TEST_FAULT_OCCURRENCE`) makes it SIGKILL itself at a step, and `PLAINPORT_TEST_PAUSE_AT` with
`PLAINPORT_TEST_PAUSE_FILE` makes it wait at a step until the file is removed. Only a binary compiled with
`--define globalThis.PLAINPORT_TEST_HOOKS=true` reads them; the matrix builds its own. `scripts/build.ts` (so
`bun run build` and every release) defines it false, the hook is compiled out, and `scripts/build.test.ts` checks the
release binary holds none of these names (D67). In a matrix build, `PLAINPORT_TRIPWIRE_REAL_HOME` must name the real
home and `HOME` lie outside it, and the pause file must lie under `HOME` and pass the home guard
(`packages/cli/src/test-hooks.ts`).

Two more knobs for the matrix itself: `PLAINPORT_CRASH_PARALLEL` sets how many subprocess rows run at once (default 6,
3 under CI, never more than the cores), and `PLAINPORT_CRASH_MATRIX_DAMAGE=1` runs every row of both variants with
harm done after recover (a deleted `.env` or stub) and passes only if each row reports it, which proves the checks
still bite.

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
