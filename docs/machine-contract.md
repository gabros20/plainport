# The machine contract: `--json`, exit codes, risk classes

**Reference.** The exact shapes a program or coding agent can rely on when driving `plainport`. Read this to
build a frontend, an agent skill, or any tool that shells out to `plainport`.

Everything here is public API (ADR-0007). The schemas live in `packages/contract` and are exported as JSON Schema;
tests pin the exit-code table, the envelope and the finding catalogue. Sections 1 to 3 and 7 are adapted from
plainkeep's `docs/machine-contract.md` §1–3 and §6 (`gabros20/plainkeep@d7eb27e`, ADR-0003); this file is
authoritative for plainport.

---

## 1. The `--json` envelope

Every command accepts the global `--json` flag. Without it, output is human text; the exit code is the same
either way.

Under `--json`, the **last line on stdout** is exactly one envelope object.

**Success:**

```json
{"plainport_json": 1, "ok": true, "verb": "offload", "data": {"op": "01J9Z6K2QF8M3V7XN4T5R6Y1AB", "exitCode": 0, "project": "work:clients/acme/web", "snapshot": "01J9Z6K2QF8M3V7XN4T5R6Y1AB", "freedBytes": 2746000000, "keptBytes": 0, "store": "local", "stub": "/Users/me/work/clients/acme/web.plainport", "localCopy": "deleted"}}
```

**Failure:**

```json
{"plainport_json": 1, "ok": false, "verb": "offload", "error": {"code": 3, "message": "offload is confirm-class", "hint": "re-run: plainport offload web --yes", "finding": {"code": "risk.needs-yes", "severity": "block", "message": "offload is confirm-class", "fix": "plainport offload web --yes", "allowable": false}}}
```

**Partial success** (the files are back, the dependencies are not):

```json
{"plainport_json": 1, "ok": false, "verb": "onload", "error": {"code": 10, "message": "work:clients/acme/web is restored, but npm ci failed with exit code 1; the files are safe and the dependencies are not installed", "hint": "plainport hydrate work:clients/acme/web", "finding": {"code": "hydrate.failed", "severity": "block", "message": "work:clients/acme/web is restored, but npm ci failed with exit code 1; the files are safe and the dependencies are not installed", "fix": "plainport hydrate work:clients/acme/web", "allowable": false}}, "data": {"op": "01J9Z7A1BC2D3E4F5G6H7J8K9M", "exitCode": 10, "project": "work:clients/acme/web", "snapshot": "01J9Z6K2QF8M3V7XN4T5R6Y1AB", "over": "01J9Z6K2QF8M3V7XN4T5R6Y1AB", "store": "local", "dir": "/Users/me/work/clients/acme/web", "restored": "restore", "files": 1834, "bytes": 1934000000, "hydrate": {"status": "failed", "steps": [{"path": "", "command": "npm ci", "ok": false, "exitCode": 1}], "untrusted": []}}}
```

The rules:

- The keys are exactly `plainport_json`, `ok`, `verb`, and `data` (when `ok` is true) or `error` (when `ok` is
  false). This version prints no other top-level key; a later one may add keys (§7).
- A failure carries `data` next to `error` only when it still has a useful result (D14): exit 10 carries the
  restore that stands (the project, the snapshot, the install that failed); exit 8 the kept snapshot (a fork) or
  the committed one (`offload.diverged-after-commit`); exit 6 from a `--dry-run` the plan its blockers stopped
  (§6), and exit 6 `plan.stale` from a real run the fresh plan it saved. `recover` and `gc` carry their report
  whenever they fail, whatever the code (1, 6, 8, 9, 11, 130…), since part of it may have been settled. Otherwise a
  failure has no `data`. The envelope schema allows `data` on any failure code; when present, `data` has the
  command's declared output shape (offload's output schema is a union that includes the conflict and the plan), or
  its plan shape under `--dry-run`.
- `plainport_json` is the envelope version, `1`. It changes only on a breaking change to the envelope (§7).
- `verb` is the command as registered, such as `offload` or `root add`.
- `data` is any JSON value; its shape is the command's declared output schema in `plainport.json`.
- `error.code` **equals the process exit code**, always one of the failure codes in §3. Whatever fails, even a bug
  (exit 1, `internal.unexpected`) or a result that cannot be serialized, the last line is still an envelope. `error.message` is one
  plain sentence; `error.hint`, when present, is the exact next step, often a command to run. `error.finding`,
  when present, is the finding behind the failure (§5), so a reader can branch on its stable `code`: every
  refusal the CLI prints carries it.
- With `ok: true` the process exits 0. With `ok: false` it exits `error.code`.

Unlike plainkeep, plainport has no multi-row header form: a command that returns a list puts it in `data`.

## 2. Event lines

A command that runs an operation streams events before the envelope. Under `--json`, stdout is NDJSON: zero or
more event lines, then the envelope. Each line is one JSON object; nothing else is printed to stdout.

```
{"type":"phase","op":"01J9Z6K2","phase":"snapshot","status":"start"}
{"type":"progress","op":"01J9Z6K2","phase":"snapshot","bytesDone":512000000,"bytesTotal":1934000000,"etaSeconds":41}
{"type":"finding","op":"01J9Z6K2","finding":{"code":"git.unpushed","severity":"warn","message":"2 commits on feature/pricing are not on origin","allowable":true}}
{"plainport_json":1,"ok":true,"verb":"offload","data":{"op":"01J9Z6K2","exitCode":0,"project":"work:clients/acme/web","snapshot":"01J9Z6K2","freedBytes":2746000000,"keptBytes":0,"store":"local","stub":"/Users/me/work/clients/acme/web.plainport","localCopy":"deleted"}}
```

| `type` | Fields | Meaning |
| --- | --- | --- |
| `phase` | `op`, `phase`, `status`: `start`, `end` or `skip` | An operation entered, left or skipped a phase |
| `progress` | `op`, `phase`, `bytesDone`, `bytesTotal`, optional `etaSeconds` | Bytes moved so far in a phase |
| `finding` | `op`, `finding` (a Finding, §5) | Something the operation noticed: information, a warning or a blocker |

`op` is the operation's ULID. `phase` is one of `resolve`, `preflight`, `scan`, `plan`, `snapshot`, `verify`,
`commit`, `release`, `restore`, `swap`, `agents`, `toolchain`, `hydrate`, `hooks`.

The core emits two more event types, which are not stdout lines: `log` events go to stderr as text, and the
`result` event becomes the final envelope. Over JSON-RPC (`plainport serve --stdio`) all five arrive as `event`
notifications.

A reader should rely on three rules: every line but the last is an event line, the last line is the envelope,
and an event line whose `type` it does not know is passed through or skipped, never an error, since a later
version may add event types (run decision D17). A line of a known type that does not match its shape is an error.
`parseJsonLines` in `packages/contract` checks exactly that, and returns unknown event lines separately.

## 3. Exit codes

The exit code is the first thing to branch on. Codes never change meaning; 0 to 5 mean what they mean in
plainkeep.

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | `ok` | Success |
| 1 | `unexpected` | Unexpected failure |
| 2 | `usage` | Usage error, or an ambiguous project name |
| 3 | `confirm` | Needs `--yes`; the message names the exact re-run |
| 4 | `notFound` | Not found: project, snapshot, device, store or command |
| 5 | `denied` | Denied by policy: a root not allowed on this device, untrusted hooks, a key without permission |
| 6 | `blocked` | Blocked by a preflight finding, or the plan is stale |
| 7 | `verifyFailed` | Verification failed |
| 8 | `conflict` | Conflict, or a strict lease held elsewhere |
| 9 | `unreachable` | Store or peer unreachable |
| 10 | `unhydrated` | Restored but not hydrated |
| 11 | `locked` | Another operation holds the lock |
| 130 | `cancelled` | Cancelled |

The names are the keys of `EXIT` in `packages/contract`. Exit 1 means a bug or an unforeseen failure; every
expected failure has a more specific code and a finding. Ctrl-C (SIGINT), SIGTERM and SIGHUP end in 130: a saga
stops at its next safe point and reports `operation.cancelled` itself; a command that ends before it reports
(no saga running, or a second signal while one winds down) prints an `operation.cancelled` envelope under `--json`
(D81). A process killed by a signal it cannot handle (SIGKILL) reports what the operating system reports; that is
outside this table.

## 4. Risk classes

Every command declares one risk class in the registry, and `plainport.json` publishes it.

| Class | Meaning | Gate |
| --- | --- | --- |
| `read` | Reads only | Runs freely |
| `safe_write` | Changes files only inside your roots, in ways plainport can undo or regenerate | Runs freely |
| `confirm` | Sends data off the machine or deletes it | Needs `--yes`, or an approved `--plan <id>` |

- A `confirm` command without `--yes` (or `--plan <id>`) does nothing and exits 3 with the finding `risk.needs-yes`.
  Its message ends with the exact command to re-run, `--yes` added: `re-run: plainport offload web --yes`. Under
  `--json` that line is `error.hint`. The re-run repeats the arguments exactly as given, each quoted for a POSIX
  shell when it needs to be (`'my project'`), with `--yes` placed before any `--`.
- A command that declares no risk class is treated as `confirm`.
- `--dry-run` always runs as `read` (ADR-0007, §6). A command that has no dry run refuses the flag before it
  runs: exit 2 with the finding `usage.dry-run-unsupported` (run decision D18). It never runs for real as a read.
  The `fix` never sends you to run it blind: for a `read` command it is the command without `--dry-run`; for a
  `safe_write` command it is `plainport help <command>`; for a `confirm` command it is the command without
  `--dry-run`, which still asks for `--yes` before changing anything.
- The gate is one pure function, `checkInvocation()` in `packages/contract` (run decision D15). It makes the
  `--dry-run` check before the risk check, so the CLI cannot do one without the other. It returns the risk class
  to run as, or a failure with exit 2 or 3 and the finding; the CLI parses the flags, prints the refusal and exits.
- An option can carry a higher class than its command: `gc` is `safe_write`, but `gc --now` (delete kept trash
  before its deadline) is `confirm` and is gated as such. The registry resolves it before calling `checkInvocation()`: an option set on
  the command line raises the class to the one it declares.
- A refusal names its finding. Under `--json`, `error.finding` is the finding and `error.hint` its `fix`; for
  `risk.needs-yes` the hint is `re-run: <command>`. In human mode the refusal goes to stderr as
  `plainport: <code>: <message>`, then `re-run: …` or `fix: …`.
- `--plan <id>` exists only on a command whose registry entry declares `acceptsPlan`. It stands in for `--yes` only
  when the plan store holds that id as approved for that command; any other id is refused like a missing `--yes`.
  A plan is approved for the command that made it while it is fresh: within an hour of its `--dry-run` (D36).
- A command's dry run declares its own schema: the plan, which is `data` under `--dry-run` (§6). The output schema
  is the `data` of a real run.
- Arguments are checked before the risk: a usage error exits 2 even on a `confirm` command without `--yes`. An
  unregistered command exits 4 (`command.unknown`) with the closest registered name, if one is close.

## 5. Findings

A finding is something an operation noticed, with a stable code an agent can act on.

```json
{"code": "git.unpushed", "severity": "warn", "message": "2 commits on feature/pricing are not on origin", "fix": "git push", "allowable": true}
```

| Field | Meaning |
| --- | --- |
| `code` | Stable dotted code: lower-case words joined by dots, words may contain hyphens (`git.in-progress`) |
| `severity` | `info`, `warn` or `block` |
| `message` | One plain sentence |
| `paths` | Optional: the files or folders concerned |
| `fix` | Optional: the exact next step |
| `allowable` | Whether `--allow <code>` may override it |

A `block` finding stops the operation before anything changes and exits 6, unless the finding's catalogue
entry names another code. Each finding code is listed once in the catalogue (`FINDINGS` in
`packages/contract`) with its severity, whether it is allowable, its exit code and its meaning. The table below is
generated from that catalogue by `bun run contract` (so it lists every code this version can emit, and CI fails
when it drifts); a test also fails when the sources emit a code the catalogue lacks.

<!-- BEGIN finding table: generated by `bun run contract` from FINDINGS in packages/contract; do not edit -->
| Code | Severity | Allowable | Exit | Meaning |
| --- | --- | --- | --- | --- |
| `catalog.event-skipped` | warn | no | 6 | A catalog event file is not JSON, does not match its schema, is named for another id, or has a type this version does not know; it is left out of the fold and never changed |
| `catalog.head-moved` | block | no | 8 | The store's latest snapshot of the project is not the one this copy came from (another copy was offloaded since, or the project is conflicted). Found before the upload, nothing is uploaded; found at the commit, the snapshot is kept as a fork and the error's data names it (D14). Nothing local is deleted |
| `catalog.head-uncertain` | block | no | 6 | The catalog left out an event it could not read or use, and the snapshot this device knows of the project (its stub's or its registry's) is named by no readable event, so the head may be older than the newest snapshot; nothing is restored or offloaded. The fix names that newest known snapshot: onload or restore --snapshot <it> restores it from the repository by its tag; any other snapshot is refused until the event reads again (D86) |
| `catalog.incomplete` | block | no | 6 | The catalog names a snapshot of the project it does not hold (a partial mirror), so its head is unknown; connect or sync the store that holds every snapshot |
| `command.cancelled` | block | no | 130 | The person answering init's prompts cancelled; nothing was written |
| `command.unknown` | block | no | 4 | No registered command has this name; the message suggests the closest one and fix is the corrected command line |
| `config.invalid` | block | no | 6 | A config file does not parse or does not match its schema, and there is no last good copy to keep; paths names the file and the message the line or key |
| `config.kept-last-good` | warn | no | 6 | A config file broke since it was last loaded in this process; its last good contents stay in effect |
| `config.locked` | block | no | 11 | Another process holds managed.toml.lock; the message names its PID, host and start time |
| `config.no-home` | block | no | 6 | HOME is unset or not an absolute path, so plainport cannot find its config and state |
| `config.not-found` | block | no | 4 | The file named by --config or PLAINPORT_CONFIG does not exist |
| `config.owned` | block | no | 5 | config.toml already sets this root binding or store and wins over managed.toml; fix names the key and file to edit |
| `config.read-only` | block | no | 5 | A write would rewrite config.toml, which plainport never does |
| `config.write-failed` | block | no | 1 | managed.toml or device.json could not be written; the old file is intact |
| `contract.invalid` | block | no | 1 | A value crossing an edge did not match its schema |
| `delete.guard-refused` | block | no | 6 | plainport did not delete a folder because the check right before every recursive delete refused it: it holds a mount point, a store plainport made or a restic repository, it is, holds or lies inside a registered project's folder (or one cannot be resolved), or the configuration does not read cleanly; the journal stays and the message names the fix (D87) |
| `deps.ambiguous` | warn | yes | 6 | A package folder holds lockfiles of more than one package manager and no packageManager field; onload uses the first in DESIGN's table |
| `deps.no-lockfile` | warn | yes | 6 | A package folder has no lockfile for its package manager, so onload would install fresh versions; fix suggests --keep-deps |
| `device.invalid` | block | no | 6 | device.json, this device's identity, is unreadable; plainport never replaces it |
| `device.none` | block | no | 6 | This device has no identity yet; fix points at plainport init |
| `env.docker-mount` | block | yes | 6 | A running container bind-mounts the project folder or a folder inside it; offloading would pull files from under it |
| `fs.case-collision` | block | no | 6 | The snapshot holds names that differ only by case (Foo.ts, foo.ts) and the landing volume ignores case, so one would overwrite the other; onload to a case-sensitive volume with --to |
| `fs.cross-volume` | block | no | 6 | The project folder is on another volume than the folder it would be moved aside into, so release could not rename it in one step |
| `fs.dataless` | block | no | 6 | A file is an iCloud or Dropbox placeholder (dataless): reading it triggers a download or fails |
| `fs.link-outside` | warn | yes | 6 | A symlink points outside the project; the link is stored, its target is not |
| `fs.no-space` | block | no | 6 | The landing volume has less free space than the snapshot, the dependencies recorded at offload and a 10% margin need; nothing is restored |
| `fs.unreadable` | block | no | 6 | plainport cannot read some files or folders in the project, so a snapshot would be incomplete |
| `fs.write-failed` | block | no | 1 | A file or folder an operation keeps for itself (its journal, lock, trash or stub) could not be read, written or moved; after a commit, fix is plainport recover |
| `git.failed` | block | no | 1 | A git command plainport runs to read the repository's state failed; the message is git's |
| `git.in-progress` | warn | yes | 6 | A rebase, merge, cherry-pick, revert or bisect is in progress; it restores exactly as it is |
| `git.is-worktree` | block | no | 6 | The folder is a linked git worktree or submodule: its .git is only a pointer to a repository elsewhere |
| `git.locked` | block | yes | 6 | The repository's index.lock exists: a git process is running or crashed |
| `git.nested-repos` | info | no | 6 | Repositories inside the project (nested clones, submodules) travel as plain files, their own .git included; paths lists them |
| `git.unpushed` | warn | yes | 6 | Commits or stashes exist only in this copy of the repository, so the snapshot becomes their only copy |
| `git.unpushed-required` | block | no | 6 | requirePushed is set and work exists only in this copy of the repository; it replaces git.unpushed (D30) |
| `git.worktrees` | block | no | 6 | Linked worktrees of this repository live outside the folder; offloading would orphan them |
| `hydrate.failed` | block | no | 10 | The files are restored but installing the dependencies failed (restored-unhydrated). The error's data is the command's output with the install that failed (onload's also names the snapshot, D14), and fix is plainport hydrate <project> |
| `internal.unexpected` | block | no | 1 | A bug: an exception escaped a command; the message names it |
| `journal.pending` | block | no | 6 | An earlier operation on the project was interrupted and its journal is still open; fix is plainport recover. From recover itself: a journal file this version cannot read, left as it is |
| `lease.held` | warn | no | 8 | Another device holds the project's lease; a warning, or a refusal with exit 8 when onload.leases = "strict" |
| `offload.diverged-after-commit` | block | no | 8 | Raised by offload (an edit between verification and the rename) and by plainport recover (an edit since the crash): the snapshot is committed and is the project's head, but the folder changed after the commit. The folder is kept with its edits, no stub is written, the device's base becomes that snapshot, and the next offload builds on it; no resolve is needed. The error's data has kind: "diverged-after-commit", where a fork (catalog.head-moved) has kind: "fork" (D51, D52); from recover, data is its report, and the operation's conflict holds that kind |
| `operation.cancelled` | block | no | 130 | A signal (Ctrl-C, a closed terminal) stopped the operation at a safe point: before it changed anything local, or, for onload and hydrate, during the install after a good restore, when the project is restored-unhydrated and plainport hydrate retries (D56). Also the envelope of a command a signal ended before it reported, under --json: one that runs no operation, or a second signal while an operation wound down, when plainport recover settles what it journaled (D81) |
| `path.occupied` | block | no | 6 | Something already stands where onload or restore would put the project; it never merges, and fix names --to <path> (or, for the folder offload.diverged-after-commit kept, says to keep working in it). Also from an offload's release, finished by recover, when a folder stands at the project's place after the project folder was moved aside: neither is touched and no stub is written |
| `path.reserved` | block | no | 6 | The path is, or lies inside, a folder plainport reserves for itself (.plainport-staging, .plainport-trash, any .plainport-*), whose contents gc deletes: it is never a project's place, a restore's landing folder or a root (D84) |
| `path.stub-occupied` | block | no | 6 | Something other than this project's stub is at <project>.plainport, where the stub would go; plainport never overwrites it (D47) |
| `plan.expired` | block | no | 6 | The saved plan is more than an hour old; fix plans again with --dry-run |
| `plan.not-found` | block | no | 4 | No saved plan has this id on this device |
| `plan.stale` | block | no | 6 | The folder, the options or the config changed since the approved plan was made, or the plan is for another project; a fresh plan is saved, fix names its id and the error's data is that plan (D14) |
| `proc.cwd` | block | yes | 6 | Another process has its working directory inside the project folder |
| `proc.cwd-shell` | warn | yes | 6 | The shell or agent that started plainport has its working directory inside the project folder |
| `proc.open-files` | block | yes | 6 | A process holds files open inside the project folder (an editor, a dev server, an agent) |
| `process.cancelled` | block | no | 130 | A child process (restic, rclone, git, an install, a hook) was cancelled; its whole process group was stopped |
| `process.idle-timeout` | block | no | 1 | A child process printed nothing for its idle deadline; its whole process group was stopped and the message ends with its last output |
| `process.output-incomplete` | block | no | 1 | A child process exited, but its stdout, parsed as data, cannot be taken as whole: something outside its process group kept it open, reading it failed, or processes it left in its group were stopped |
| `process.output-too-large` | block | no | 1 | A child process printed more on stdout than its caller can take whole (a file list, a JSON document); it was stopped, never read in part |
| `process.spawn-failed` | block | no | 1 | A child process could not be started; paths names the program and its working folder |
| `process.timeout` | block | no | 1 | A child process ran past its overall deadline; its whole process group was stopped and the message ends with its last output |
| `project.already-local` | block | no | 6 | onload --to while the project's own onloaded copy is on this device: a device holds one working copy; fix names plainport restore <project> --snapshot <id> --to <path> for a side-by-side copy (D56) |
| `project.ambiguous` | block | no | 2 | A project name matches more than one project; the message lists every candidate address |
| `project.locked` | block | no | 11 | Another plainport process holds the project's lock (locks/<project>.lock), or the lock of a registered project nested with it (D53); a lock left by a dead process is broken instead |
| `project.nested` | block | no | 6 | The folder holds another registered project's effective folder (its --to override, else its root's place) on this device, so offload refuses and fix offloads the inner project first; onload --to refuses a landing folder inside another registered project's folder (D53) |
| `project.not-found` | block | no | 4 | No project matches the name, address or path |
| `project.unregistered` | block | no | 4 | The folder is a project folder under a root that this device has not registered or offloaded yet, so it has no status; offload takes it as it is (fix: offload <root>:<folder> --dry-run), and root scan registers the root's projects (D76) |
| `registry.invalid` | block | no | 6 | registry.json, this device's project registry, is unreadable; plainport never overwrites it |
| `registry.locked` | block | no | 11 | Another process holds registry.json.lock |
| `registry.unreadable` | block | no | 6 | registry.json exists but plainport may not read it; fix is about permissions, and the file is left as it is |
| `restic.failed` | block | no | 1 | restic exited with a fatal error (exit code 1, or one plainport does not map); the message is restic's |
| `restic.interrupted` | block | no | 130 | restic was interrupted (exit code 130) before it finished |
| `restic.locked` | block | no | 11 | Another restic process holds a lock on the store's repository (restic exit code 11) |
| `restic.output-invalid` | block | no | 1 | restic's JSON output did not match what this restic version is known to print |
| `restic.repo-exists` | block | no | 6 | A restic repository already exists where a new one was to be created |
| `restic.repo-missing` | block | no | 4 | No restic repository exists at the store's location (restic exit code 10) |
| `restic.snapshot-not-found` | block | no | 4 | The store's repository has no snapshot with this id |
| `restic.symlinks-unclear` | block | no | 6 | Too many symlinks in a snapshot have names or targets that restic's listing cannot place in one pass (line breaks, ' -> '); the message lists them |
| `restic.unreadable-files` | block | no | 6 | restic could not read some files (restic exit code 3); the snapshot is incomplete and counts as failed, never as a partial success |
| `restic.version-mismatch` | block | no | 6 | The restic binary found is not the version this plainport pins and was tested with |
| `restic.wrong-password` | block | no | 5 | The store's password does not open its restic repository (restic exit code 12) |
| `risk.needs-yes` | block | no | 3 | A confirm-class command ran without --yes or an approved --plan; fix is the exact re-run |
| `root.defined-twice` | warn | no | 6 | config.toml and managed.toml both define a root; config.toml wins key by key, and fix says where to edit |
| `root.exists` | block | no | 6 | A root with this key already exists; fix is the root bind command |
| `root.none` | block | no | 2 | The folder is outside every root; file it with --root and --as, or add a root that holds it |
| `root.not-found` | block | no | 4 | No root has this key |
| `root.not-writable` | block | no | 6 | plainport cannot write to the root's folder |
| `root.overlap` | block | no | 6 | Two roots on this device overlap or resolve to the same real path (symlinks resolved, case folded on case-insensitive volumes); paths names both folders |
| `root.path-missing` | block | no | 6 | The root's folder on this device does not exist or is not a folder; --create makes it |
| `root.synced-folder` | warn | yes | 6 | The root is inside an iCloud Drive or Dropbox folder, whose sync clients fight with node_modules and half-written files |
| `root.unbound` | block | no | 6 | The root has no folder on this device; fix is plainport root bind <root> <path> |
| `snapshot.not-found` | block | no | 4 | The catalog has no snapshot of the project with this id (--snapshot), or the store holds no copy of it; fix names the head or the store that holds it |
| `store.failed` | block | no | 1 | A read or write in a store failed (permissions, a full disk, an I/O error); the message names the key and the error |
| `store.identity-changed` | block | no | 6 | The store at this path is not the one this device knows (its meta/v1/store.json names another id, or none): a re-pointed path, another disk or a restored copy; nothing is synced |
| `store.inside-project` | block | no | 6 | A local store and a project overlap (the store lies inside the project's folder, or the project inside the store), compared by real path: an offload would move the store into the trash with the folder and delete its snapshots, so setup, offload and its release refuse; move one of them (D83) |
| `store.key-exists` | block | no | 1 | A create-only write found the key already there; the existing value is left as it was |
| `store.not-set-up` | block | no | 6 | The store is not configured, or this device has not set it up (no id recorded); fix is plainport init |
| `store.root-mismatch` | block | no | 6 | The store already holds another root's snapshots; one repository serves one root (ADR-0010, D48), so fix is to give this root its own store |
| `store.secret-missing` | block | no | 6 | The store's repository password could not be read from its secret reference (env: or file: in M1) |
| `store.setup-pending` | warn | no | 6 | init recorded the store but could not set it up yet (its disk is not mounted); plainport init sets it up once it is reachable |
| `store.unreachable` | block | no | 9 | The store's folder is missing or is not a folder: a disk that is not mounted, or a path that moved |
| `store.unsupported` | block | no | 6 | This build cannot use the store's kind yet; M1 supports local stores (an external disk or a local folder) |
| `strip.kept` | info | no | 6 | Paths a plugin or strip.extra proposed stay in the snapshot; the message says why for each (git tracks it, strip.keep or strip.never matches, it holds a repository, dependencies are kept) |
| `stub.invalid` | block | no | 6 | A .plainport stub file does not match the stub schema |
| `tool.missing` | block | no | 6 | A bundled binary (restic or rclone) was not found; paths lists every place searched |
| `toolchain.mismatch` | warn | no | 6 | The project asks for a tool version (.nvmrc, engines, packageManager) that is not active and no version manager (mise, fnm, Volta) on PATH can activate; the install runs with what is there |
| `usage.dry-run-unsupported` | block | no | 2 | --dry-run was given to a command that has no preview; fix depends on the risk class (machine-contract §4) |
| `usage.invalid` | block | no | 2 | The arguments or options do not match the command's declared arguments; fix is plainport help <command>. Also restore without --snapshot when the project has no head (incomplete or conflicted): the message lists the candidate ids (D60); and offload.verify = "full" in config, which arrives in M5 and is refused rather than downgraded (D50) |
| `verify.changed` | block | no | 7 | Files changed while the snapshot was made, again after one retry; nothing local was deleted |
| `verify.mismatch` | block | no | 7 | The snapshot's listing does not match the folder (entries, types, sizes, modes or link targets): at offload the scan of the project, and nothing local was deleted; at onload the restored staging folder, which is removed while the stub stays |
<!-- END finding table -->

`command.unavailable` (exit 1), which `offload` returned until its saga landed (D38), is retired and never reused.

## 6. The `--dry-run` contract

A command that supports `--dry-run` treats it as a true preview: it builds and prints the plan, then stops. It
writes nothing but its plan file: nothing in the project, its roots or any store changes, and the plan is saved to
plainport's own state as `plans/<id>.json`, valid for an hour, so `plainport offload web --plan <id>` can run
exactly that plan (run decision D36). Start-of-command housekeeping (D59) runs as notices only under
`--dry-run`, as it does for every read-class command: it prints on stderr which operations were interrupted, and
deletes no trash whose `keepLocalFor` deadline has passed (D61); a write command, or `plainport gc`, does that.
A `--dry-run` run is always a `read`, so it needs no `--yes`:
`plainport offload web --dry-run` runs freely. Under `--json`, its envelope's `data` is the plan. A plan that holds
a `block` finding exits 6 (D38): its envelope is a failure whose `error.finding` is the first blocker and whose
`data` is still the whole plan (D14), and human output prints the plan on stdout, then the refusal on stderr. A command that has no preview refuses
`--dry-run` with exit 2 before doing anything (§4); `plainport.json` says which commands support it.

## 7. Stability policy

- The envelope, the event lines, the exit codes, the risk classes, finding codes and every command's schemas are
  public API (ADR-0007).
- A breaking change to the envelope or the event lines (a removed or renamed key, a changed meaning) needs a
  `plainport_json` bump, and a release with a new major version.
- Exit codes never change meaning, and a finding code, once released, keeps its meaning. A retired code is never
  reused.
- **Additive** (keeps `plainport_json`): a new optional key on any printed object, a new event type, a new finding
  code, a new command. Consumers ignore keys they don't know and pass through or skip event lines whose `type`
  they don't know (D17); the published `event` and `stream-event` schemas accept an unknown type.
- **Breaking** (bumps `plainport_json`): removing or renaming a key, making an optional key required, changing a
  key's type or meaning, and adding a value to a closed set: a new phase, project state, severity, risk class or
  exit code. Readers may treat those sets as complete (D17).
- So that a new field is not breaking, the published schemas for everything plainport prints (the envelope, event
  lines, findings, each command's `data`) leave `additionalProperties` open. What plainport reads (arguments,
  config, files it owns) stays strict, so a mistyped key is an error rather than silently ignored (run decision
  D16).
- Consumers should key on `plainport_json` and the schemas, not on the plainport version string.
- Tests hold this: the exit-code table and the finding catalogue are frozen literals in
  `packages/contract`, and every command's `--json` output is validated against its declared schema in CI.

## 8. `plainport.json` and completions

`plainport.json` is generated from the command registry by `bun run contract`; nothing in it is edited by hand,
and CI fails when the committed copy is stale (`bun run contract --check`). It holds no plainport version, so a
release does not change it.

```json
{
  "schema": "plainport.json/1",
  "plainport_json": 1,
  "globalOptions": [{"name": "json", "type": "boolean", "summary": "…"}, {"name": "store", "type": "string", "summary": "…"}],
  "commands": [{"name": "help", "summary": "…", "usage": "plainport help [<command...>]", "risk": "read", "dryRun": false,
                "acceptsPlan": false, "group": "setup",
                "positionals": [{"name": "command", "summary": "…", "required": false, "variadic": true}],
                "options": [{"name": "allow", "type": "string", "multiple": true, "summary": "…"}],
                "arguments": {"…": "JSON Schema"}, "output": {"…": "JSON Schema"}, "plan": null,
                "examples": [{"argv": ["help", "version"], "summary": "…"}]}],
  "exitCodes": [{"code": 0, "name": "ok", "meaning": "Success"}],
  "findings": [{"code": "risk.needs-yes", "severity": "block", "allowable": false, "exitCode": 3, "summary": "…"}]
}
```

| Field | Meaning |
| --- | --- |
| `schema` | The version of this file's shape; a breaking change to it bumps the number |
| `plainport_json` | The envelope version (§1) |
| `globalOptions` | The global flags, in DESIGN.md order; `type` is `boolean` or `string` |
| `commands[].risk` | The command's risk class (§4); an option that raises it carries its own `risk` in `options` |
| `commands[].dryRun` | Whether `--dry-run` previews (§6); otherwise it is refused with exit 2 |
| `commands[].acceptsPlan` | Whether `--plan <id>`, the id its `--dry-run` printed, stands in for `--yes` |
| `commands[].group` | Where human `help` lists it: `projects`, `recovery`, `roots` or `setup` (an open set) |
| `commands[].options[]` | `type` is `boolean` (a flag) or `string` (takes a value); `multiple` is true when the option repeats (`--allow a --allow b`); `risk` appears only on an option that raises the command's class |
| `commands[].arguments` | The strict JSON Schema of the parsed arguments: positional names and option names as keys |
| `commands[].output` | The open JSON Schema of `data` on a real run: a success's, and a failure's that carries data (D14). For `offload` it is a union of the result, the conflict (exit 8) and the fresh plan (exit 6 `plan.stale`) |
| `commands[].plan` | The open JSON Schema of `data` under `--dry-run` (the plan, §6); `null` when the command has no dry run |

`plainport help --json` returns the same command entries without `arguments`, `output` and `plan`; `help <command>`
adds `topic`, the command asked about. Human `plainport help` is a short overview: the commands by group, each with
its risk class and one-line summary, the global options, and pointers to `help <command>`, `--json`,
`help --json` and `plainport.json`; it never prints the machine contract itself. `plainport --help`, `plainport <command> --help` and a bare `plainport`
are `help`; `plainport --version` is `version`.

`bun run contract` also writes `completions/_plainport` (zsh, for a folder on `$fpath`) and
`completions/plainport.bash` (bash). They complete command names, the words of a command group, `help`'s argument
and each command's options plus the global ones.

## JSON Schemas

`contractJsonSchemas()` in `packages/contract` exports the machine contract's schemas as draft 2020-12 JSON Schema
documents: `envelope`, `event`, `stream-event`, `finding`, `exit-code`, `risk-class`, `phase`, `project-state` and
`operation-result`. `packages/core` exports the schemas of the files plainport writes: `config` and
`project-config`; `device` and `registry`; `catalog-event`, `catalog-state`, `event-mirror`, `root-claim` and
`store-identity` in the store; `journal`, `manifest-entry` and `stub`; `staging-holder` and `staging-record`; and
`trash-claim`. `bun run contract` writes all of them to `schemas/`, next to `plainport.json`.
