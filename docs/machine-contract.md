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
{"plainport_json": 1, "ok": true, "verb": "offload", "data": {"op": "01J9Z6K2", "exitCode": 0, "freedBytes": 2746000000}}
```

**Failure:**

```json
{"plainport_json": 1, "ok": false, "verb": "offload", "error": {"code": 3, "message": "offload is confirm-class", "hint": "re-run: plainport offload web --yes"}}
```

**Partial success** (the files are back, the dependencies are not):

```json
{"plainport_json": 1, "ok": false, "verb": "onload", "error": {"code": 10, "message": "web is restored but its dependencies are not installed", "hint": "plainport hydrate web"}, "data": {"project": "work:clients/acme/web", "snapshot": "01J9Z6K2"}}
```

The rules:

- The keys are exactly `plainport_json`, `ok`, `verb`, and `data` (when `ok` is true) or `error` (when `ok` is
  false). This version prints no other top-level key; a later one may add keys (§7).
- A failure carries `data` next to `error` only when the operation partly succeeded: exit 10 carries the restored
  project and snapshot, exit 8 the kept snapshot. Otherwise a failure has no `data`. When present, `data` has the
  command's declared output shape.
- `plainport_json` is the envelope version, `1`. It changes only on a breaking change to the envelope (§7).
- `verb` is the command as registered, such as `offload` or `root add`.
- `data` is any JSON value; its shape is the command's declared output schema in `plainport.json`.
- `error.code` **equals the process exit code**, always one of the failure codes in §3. `error.message` is one
  plain sentence; `error.hint`, when present, is the exact next step, often a command to run.
- With `ok: true` the process exits 0. With `ok: false` it exits `error.code`.

Unlike plainkeep, plainport has no multi-row header form: a command that returns a list puts it in `data`.

## 2. Event lines

A command that runs an operation streams events before the envelope. Under `--json`, stdout is NDJSON: zero or
more event lines, then the envelope. Each line is one JSON object; nothing else is printed to stdout.

```
{"type":"phase","op":"01J9Z6K2","phase":"snapshot","status":"start"}
{"type":"progress","op":"01J9Z6K2","phase":"snapshot","bytesDone":512000000,"bytesTotal":1934000000,"etaSeconds":41}
{"type":"finding","op":"01J9Z6K2","finding":{"code":"git.unpushed","severity":"warn","message":"2 commits on feature/pricing are not on origin","allowable":true}}
{"plainport_json":1,"ok":true,"verb":"offload","data":{"op":"01J9Z6K2","exitCode":0,"project":"work:clients/acme/web","snapshot":"01J9Z6K2","freedBytes":2746000000}}
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
| 4 | `notFound` | Not found: project, snapshot, device or store |
| 5 | `denied` | Denied by policy: a root not allowed on this device, untrusted hooks, a key without permission |
| 6 | `blocked` | Blocked by a preflight finding, or the plan is stale |
| 7 | `verifyFailed` | Verification failed |
| 8 | `conflict` | Conflict, or a strict lease held elsewhere |
| 9 | `unreachable` | Store or peer unreachable |
| 10 | `unhydrated` | Restored but not hydrated |
| 11 | `locked` | Another operation holds the lock |
| 130 | `cancelled` | Cancelled |

The names are the keys of `EXIT` in `packages/contract`. Exit 1 means a bug or an unforeseen failure; every
expected failure has a more specific code and a finding. A process killed by a signal other than an interrupt
reports what the operating system reports; that is outside this table.

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
- An option can carry a higher class than its command: `onload` is `safe_write`, but `onload --adopt` is
  `confirm` and is gated as such.

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
`packages/contract`) with its severity, whether it is allowable, and its exit code. The catalogue so far:

| Code | Severity | Allowable | Exit | Meaning |
| --- | --- | --- | --- | --- |
| `contract.invalid` | block | no | 1 | A value crossing an edge did not match its schema |
| `risk.needs-yes` | block | no | 3 | A confirm-class command ran without `--yes` or an approved `--plan`; `fix` is the exact re-run |
| `usage.dry-run-unsupported` | block | no | 2 | `--dry-run` was given to a command that has no preview; `fix` depends on the risk class (§4) |
| `tool.missing` | block | no | 6 | A bundled binary (restic or rclone) was not found; `paths` lists every place searched |

Later milestones add codes such as `git.unpushed`, `git.locked` and `fs.dataless` (DESIGN.md "Edge cases").

## 6. The `--dry-run` contract

A command that supports `--dry-run` treats it as a true preview: it builds and prints the plan, then stops,
writing nothing. A `--dry-run` run is always a `read`, so it needs no `--yes`: `plainport offload web --dry-run`
runs freely. Under `--json`, its envelope's `data` is the plan. A command that has no preview refuses
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

## JSON Schemas

`contractJsonSchemas()` in `packages/contract` exports each schema as a draft 2020-12 JSON Schema document:
`envelope`, `event`, `stream-event`, `finding`, `exit-code`, `risk-class`, `phase`, `project-state` and
`operation-result`. `bun run contract` writes them to `schemas/`, next to `plainport.json`.
