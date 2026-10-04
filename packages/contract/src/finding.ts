// Findings: what preflight, plans and refusals report (DESIGN.md "Core API", "Edge cases").

import { z } from "zod";
import type { FailureExitCode } from "./exit-codes.ts";
import { outputObject } from "./objects.ts";

/** Lower-case words joined by dots, at least two segments; a word may contain single hyphens (git.in-progress). */
export const FindingCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/)
  .meta({ title: "FindingCode", description: "Stable dotted code, e.g. git.unpushed" });

export const SeveritySchema = z.enum(["info", "warn", "block"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingSchema = outputObject({
  code: FindingCodeSchema,
  severity: SeveritySchema,
  message: z.string().min(1),
  paths: z.array(z.string()).optional(),
  fix: z.string().min(1).optional().meta({ description: "The exact next step, e.g. a command to run" }),
  allowable: z.boolean().meta({ description: "May --allow <code> override it?" }),
}).meta({ title: "Finding" });
export type Finding = z.infer<typeof FindingSchema>;

export interface FindingSpec {
  severity: Severity;
  allowable: boolean;
  /** The exit code when this finding ends a command. */
  exitCode: FailureExitCode;
  summary: string;
}

/** Every finding code plainport emits. A code, once listed, keeps its meaning; later tasks add entries. */
export const FINDINGS = Object.freeze({
  "catalog.head-moved": {
    severity: "block",
    allowable: false,
    exitCode: 8,
    summary:
      "The store's latest snapshot of the project is not the one this copy came from (another copy was offloaded since, or the project is conflicted). Found before the upload, nothing is uploaded; found at the commit, the snapshot is kept as a fork and the error's data names it (D14). Nothing local is deleted",
  },
  "catalog.event-skipped": {
    severity: "warn",
    allowable: false,
    exitCode: 6,
    summary:
      "A catalog event file is not JSON, does not match its schema, is named for another id, or has a type this version does not know; it is left out of the fold and never changed",
  },
  "catalog.head-uncertain": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "The catalog left out an event it could not read or use, and the snapshot this device knows of the project (its stub's or its registry's) is named by no readable event, so the head may be older than the newest snapshot; nothing is restored or offloaded. The fix names that newest known snapshot: onload or restore --snapshot <it> restores it from the repository by its tag; any other snapshot is refused until the event reads again (D86)",
  },
  "catalog.incomplete": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "The catalog names a snapshot of the project it does not hold (a partial mirror), so its head is unknown; connect or sync the store that holds every snapshot",
  },
  "command.cancelled": {
    severity: "block",
    allowable: false,
    exitCode: 130,
    summary: "The person answering init's prompts cancelled; nothing was written",
  },
  "command.unknown": {
    severity: "block",
    allowable: false,
    exitCode: 4,
    summary:
      "No registered command has this name; the message suggests the closest one and fix is the corrected command line",
  },
  "config.invalid": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "A config file does not parse or does not match its schema, and there is no last good copy to keep; paths names the file and the message the line or key",
  },
  "config.kept-last-good": {
    severity: "warn",
    allowable: false,
    exitCode: 6,
    summary:
      "A config file broke since it was last loaded in this process; its last good contents stay in effect",
  },
  "config.locked": {
    severity: "block",
    allowable: false,
    exitCode: 11,
    summary: "Another process holds managed.toml.lock; the message names its PID, host and start time",
  },
  "config.no-home": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "HOME is unset or not an absolute path, so plainport cannot find its config and state",
  },
  "config.not-found": {
    severity: "block",
    allowable: false,
    exitCode: 4,
    summary: "The file named by --config or PLAINPORT_CONFIG does not exist",
  },
  "config.owned": {
    severity: "block",
    allowable: false,
    exitCode: 5,
    summary:
      "config.toml already sets this root binding or store and wins over managed.toml; fix names the key and file to edit",
  },
  "config.read-only": {
    severity: "block",
    allowable: false,
    exitCode: 5,
    summary: "A write would rewrite config.toml, which plainport never does",
  },
  "config.write-failed": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary: "managed.toml or device.json could not be written; the old file is intact",
  },
  "contract.invalid": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary: "A value crossing an edge did not match its schema",
  },
  "deps.ambiguous": {
    severity: "warn",
    allowable: true,
    exitCode: 6,
    summary:
      "A package folder holds lockfiles of more than one package manager and no packageManager field; onload uses the first in DESIGN's table",
  },
  "delete.guard-refused": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "plainport did not delete a folder because the check right before every recursive delete refused it: it holds a mount point, a store plainport made or a restic repository, it is, holds or lies inside a registered project's folder (or one cannot be resolved), or the configuration does not read cleanly; the journal stays and the message names the fix (D87)",
  },
  "deps.no-lockfile": {
    severity: "warn",
    allowable: true,
    exitCode: 6,
    summary:
      "A package folder has no lockfile for its package manager, so onload would install fresh versions; fix suggests --keep-deps",
  },
  "device.invalid": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "device.json, this device's identity, is unreadable; plainport never replaces it",
  },
  "device.none": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "This device has no identity yet; fix points at plainport init",
  },
  "env.docker-mount": {
    severity: "block",
    allowable: true,
    exitCode: 6,
    summary:
      "A running container bind-mounts the project folder or a folder inside it; offloading would pull files from under it",
  },
  "fs.dataless": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "A file is an iCloud or Dropbox placeholder (dataless): reading it triggers a download or fails",
  },
  "fs.link-outside": {
    severity: "warn",
    allowable: true,
    exitCode: 6,
    summary: "A symlink points outside the project; the link is stored, its target is not",
  },
  "fs.unreadable": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "plainport cannot read some files or folders in the project, so a snapshot would be incomplete",
  },
  "fs.cross-volume": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "The project folder is on another volume than the folder it would be moved aside into, so release could not rename it in one step",
  },
  "fs.write-failed": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary:
      "A file or folder an operation keeps for itself (its journal, lock, trash or stub) could not be read, written or moved; after a commit, fix is plainport recover",
  },
  "git.failed": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary: "A git command plainport runs to read the repository's state failed; the message is git's",
  },
  "git.in-progress": {
    severity: "warn",
    allowable: true,
    exitCode: 6,
    summary: "A rebase, merge, cherry-pick, revert or bisect is in progress; it restores exactly as it is",
  },
  "git.is-worktree": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "The folder is a linked git worktree or submodule: its .git is only a pointer to a repository elsewhere",
  },
  "git.locked": {
    severity: "block",
    allowable: true,
    exitCode: 6,
    summary: "The repository's index.lock exists: a git process is running or crashed",
  },
  "git.nested-repos": {
    severity: "info",
    allowable: false,
    exitCode: 6,
    summary:
      "Repositories inside the project (nested clones, submodules) travel as plain files, their own .git included; paths lists them",
  },
  "git.unpushed": {
    severity: "warn",
    allowable: true,
    exitCode: 6,
    summary:
      "Commits or stashes exist only in this copy of the repository, so the snapshot becomes their only copy",
  },
  "git.unpushed-required": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "requirePushed is set and work exists only in this copy of the repository; it replaces git.unpushed (D30)",
  },
  "git.worktrees": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "Linked worktrees of this repository live outside the folder; offloading would orphan them",
  },
  "internal.unexpected": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary: "A bug: an exception escaped a command; the message names it",
  },
  "journal.pending": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "An earlier operation on the project was interrupted and its journal is still open; fix is plainport recover. From recover itself: a journal file this version cannot read, left as it is",
  },
  "path.reserved": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "The path is, or lies inside, a folder plainport reserves for itself (.plainport-staging, .plainport-trash, any .plainport-*), whose contents gc deletes: it is never a project's place, a restore's landing folder or a root (D84)",
  },
  "path.stub-occupied": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "Something other than this project's stub is at <project>.plainport, where the stub would go; plainport never overwrites it (D47)",
  },
  "plan.expired": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "The saved plan is more than an hour old; fix plans again with --dry-run",
  },
  "offload.diverged-after-commit": {
    severity: "block",
    allowable: false,
    exitCode: 8,
    summary:
      "Raised by offload (an edit between verification and the rename) and by plainport recover (an edit since the crash): the snapshot is committed and is the project's head, but the folder changed after the commit. The folder is kept with its edits, no stub is written, the device's base becomes that snapshot, and the next offload builds on it; no resolve is needed. The error's data has kind: \"diverged-after-commit\", where a fork (catalog.head-moved) has kind: \"fork\" (D51, D52); from recover, data is its report, and the operation's conflict holds that kind",
  },
  "operation.cancelled": {
    severity: "block",
    allowable: false,
    exitCode: 130,
    summary:
      "A signal (Ctrl-C, a closed terminal) stopped the operation at a safe point: before it changed anything local, or, for onload and hydrate, during the install after a good restore, when the project is restored-unhydrated and plainport hydrate retries (D56). Also the envelope of a command a signal ended before it reported, under --json: one that runs no operation, or a second signal while an operation wound down, when plainport recover settles what it journaled (D81)",
  },
  "plan.not-found": {
    severity: "block",
    allowable: false,
    exitCode: 4,
    summary: "No saved plan has this id on this device",
  },
  "plan.stale": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "The folder, the options or the config changed since the approved plan was made, or the plan is for another project; a fresh plan is saved, fix names its id and the error's data is that plan (D14)",
  },
  "proc.cwd": {
    severity: "block",
    allowable: true,
    exitCode: 6,
    summary: "Another process has its working directory inside the project folder",
  },
  "proc.cwd-shell": {
    severity: "warn",
    allowable: true,
    exitCode: 6,
    summary: "The shell or agent that started plainport has its working directory inside the project folder",
  },
  "proc.open-files": {
    severity: "block",
    allowable: true,
    exitCode: 6,
    summary: "A process holds files open inside the project folder (an editor, a dev server, an agent)",
  },
  "process.cancelled": {
    severity: "block",
    allowable: false,
    exitCode: 130,
    summary:
      "A child process (restic, rclone, git, an install, a hook) was cancelled; its whole process group was stopped",
  },
  "process.idle-timeout": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary:
      "A child process printed nothing for its idle deadline; its whole process group was stopped and the message ends with its last output",
  },
  "process.output-incomplete": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary:
      "A child process exited, but its stdout, parsed as data, cannot be taken as whole: something outside its process group kept it open, reading it failed, or processes it left in its group were stopped",
  },
  "process.output-too-large": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary:
      "A child process printed more on stdout than its caller can take whole (a file list, a JSON document); it was stopped, never read in part",
  },
  "process.spawn-failed": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary: "A child process could not be started; paths names the program and its working folder",
  },
  "process.timeout": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary:
      "A child process ran past its overall deadline; its whole process group was stopped and the message ends with its last output",
  },
  "project.ambiguous": {
    severity: "block",
    allowable: false,
    exitCode: 2,
    summary: "A project name matches more than one project; the message lists every candidate address",
  },
  "project.locked": {
    severity: "block",
    allowable: false,
    exitCode: 11,
    summary:
      "Another plainport process holds the project's lock (locks/<project>.lock), or the lock of a registered project nested with it (D53); a lock left by a dead process is broken instead",
  },
  "project.not-found": {
    severity: "block",
    allowable: false,
    exitCode: 4,
    summary: "No project matches the name, address or path",
  },
  "project.unregistered": {
    severity: "block",
    allowable: false,
    exitCode: 4,
    summary:
      "The folder is a project folder under a root that this device has not registered or offloaded yet, so it has no status; offload takes it as it is (fix: offload <root>:<folder> --dry-run), and root scan registers the root's projects (D76)",
  },
  "registry.invalid": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "registry.json, this device's project registry, is unreadable; plainport never overwrites it",
  },
  "registry.locked": {
    severity: "block",
    allowable: false,
    exitCode: 11,
    summary: "Another process holds registry.json.lock",
  },
  "registry.unreadable": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "registry.json exists but plainport may not read it; fix is about permissions, and the file is left as it is",
  },
  "restic.failed": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary:
      "restic exited with a fatal error (exit code 1, or one plainport does not map); the message is restic's",
  },
  "restic.interrupted": {
    severity: "block",
    allowable: false,
    exitCode: 130,
    summary: "restic was interrupted (exit code 130) before it finished",
  },
  "restic.locked": {
    severity: "block",
    allowable: false,
    exitCode: 11,
    summary: "Another restic process holds a lock on the store's repository (restic exit code 11)",
  },
  "restic.output-invalid": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary: "restic's JSON output did not match what this restic version is known to print",
  },
  "restic.repo-exists": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "A restic repository already exists where a new one was to be created",
  },
  "restic.repo-missing": {
    severity: "block",
    allowable: false,
    exitCode: 4,
    summary: "No restic repository exists at the store's location (restic exit code 10)",
  },
  "restic.snapshot-not-found": {
    severity: "block",
    allowable: false,
    exitCode: 4,
    summary: "The store's repository has no snapshot with this id",
  },
  "restic.symlinks-unclear": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "Too many symlinks in a snapshot have names or targets that restic's listing cannot place in one pass (line breaks, ' -> '); the message lists them",
  },
  "restic.unreadable-files": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "restic could not read some files (restic exit code 3); the snapshot is incomplete and counts as failed, never as a partial success",
  },
  "restic.version-mismatch": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "The restic binary found is not the version this plainport pins and was tested with",
  },
  "restic.wrong-password": {
    severity: "block",
    allowable: false,
    exitCode: 5,
    summary: "The store's password does not open its restic repository (restic exit code 12)",
  },
  "risk.needs-yes": {
    severity: "block",
    allowable: false,
    exitCode: 3,
    summary: "A confirm-class command ran without --yes or an approved --plan; fix is the exact re-run",
  },
  "root.defined-twice": {
    severity: "warn",
    allowable: false,
    exitCode: 6,
    summary:
      "config.toml and managed.toml both define a root; config.toml wins key by key, and fix says where to edit",
  },
  "root.exists": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "A root with this key already exists; fix is the root bind command",
  },
  "root.none": {
    severity: "block",
    allowable: false,
    exitCode: 2,
    summary: "The folder is outside every root; file it with --root and --as, or add a root that holds it",
  },
  "root.not-found": {
    severity: "block",
    allowable: false,
    exitCode: 4,
    summary: "No root has this key",
  },
  "root.not-writable": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "plainport cannot write to the root's folder",
  },
  "root.overlap": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "Two roots on this device overlap or resolve to the same real path (symlinks resolved, case folded on case-insensitive volumes); paths names both folders",
  },
  "root.path-missing": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "The root's folder on this device does not exist or is not a folder; --create makes it",
  },
  "root.synced-folder": {
    severity: "warn",
    allowable: true,
    exitCode: 6,
    summary:
      "The root is inside an iCloud Drive or Dropbox folder, whose sync clients fight with node_modules and half-written files",
  },
  "root.unbound": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "The root has no folder on this device; fix is plainport root bind <root> <path>",
  },
  "store.failed": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary:
      "A read or write in a store failed (permissions, a full disk, an I/O error); the message names the key and the error",
  },
  "store.identity-changed": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "The store at this path is not the one this device knows (its meta/v1/store.json names another id, or none): a re-pointed path, another disk or a restored copy; nothing is synced",
  },
  "store.inside-project": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "A local store and a project overlap (the store lies inside the project's folder, or the project inside the store), compared by real path: an offload would move the store into the trash with the folder and delete its snapshots, so setup, offload and its release refuse; move one of them (D83)",
  },
  "store.key-exists": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary: "A create-only write found the key already there; the existing value is left as it was",
  },
  "store.not-set-up": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "The store is not configured, or this device has not set it up (no id recorded); fix is plainport init",
  },
  "store.root-mismatch": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "The store already holds another root's snapshots; one repository serves one root (ADR-0010, D48), so fix is to give this root its own store",
  },
  "store.secret-missing": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "The store's repository password could not be read from its secret reference (env: or file: in M1)",
  },
  "store.setup-pending": {
    severity: "warn",
    allowable: false,
    exitCode: 6,
    summary:
      "init recorded the store but could not set it up yet (its disk is not mounted); plainport init sets it up once it is reachable",
  },
  "store.unreachable": {
    severity: "block",
    allowable: false,
    exitCode: 9,
    summary:
      "The store's folder is missing or is not a folder: a disk that is not mounted, or a path that moved",
  },
  "store.unsupported": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "This build cannot use the store's kind yet; M1 supports local stores (an external disk or a local folder)",
  },
  "stub.invalid": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "A .plainport stub file does not match the stub schema",
  },
  "usage.dry-run-unsupported": {
    severity: "block",
    allowable: false,
    exitCode: 2,
    summary:
      "--dry-run was given to a command that has no preview; fix depends on the risk class (machine-contract §4)",
  },
  "usage.invalid": {
    severity: "block",
    allowable: false,
    exitCode: 2,
    summary:
      'The arguments or options do not match the command\'s declared arguments; fix is plainport help <command>. Also restore without --snapshot when the project has no head (incomplete or conflicted): the message lists the candidate ids (D60); and offload.verify = "full" in config, which arrives in M5 and is refused rather than downgraded (D50)',
  },
  "fs.case-collision": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "The snapshot holds names that differ only by case (Foo.ts, foo.ts) and the landing volume ignores case, so one would overwrite the other; onload to a case-sensitive volume with --to",
  },
  "fs.no-space": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "The landing volume has less free space than the snapshot, the dependencies recorded at offload and a 10% margin need; nothing is restored",
  },
  "hydrate.failed": {
    severity: "block",
    allowable: false,
    exitCode: 10,
    summary:
      "The files are restored but installing the dependencies failed (restored-unhydrated). The error's data is the command's output with the install that failed (onload's also names the snapshot, D14), and fix is plainport hydrate <project>",
  },
  "lease.held": {
    severity: "warn",
    allowable: false,
    exitCode: 8,
    summary:
      'Another device holds the project\'s lease; a warning, or a refusal with exit 8 when onload.leases = "strict"',
  },
  "path.occupied": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "Something already stands where onload or restore would put the project; it never merges, and fix names --to <path> (or, for the folder offload.diverged-after-commit kept, says to keep working in it). Also from an offload's release, finished by recover, when a folder stands at the project's place after the project folder was moved aside: neither is touched and no stub is written",
  },
  "project.already-local": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "onload --to while the project's own onloaded copy is on this device: a device holds one working copy; fix names plainport restore <project> --snapshot <id> --to <path> for a side-by-side copy (D56)",
  },
  "project.nested": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "The folder holds another registered project's effective folder (its --to override, else its root's place) on this device, so offload refuses and fix offloads the inner project first; onload --to refuses a landing folder inside another registered project's folder (D53)",
  },
  "snapshot.not-found": {
    severity: "block",
    allowable: false,
    exitCode: 4,
    summary:
      "The catalog has no snapshot of the project with this id (--snapshot), or the store holds no copy of it; fix names the head or the store that holds it",
  },
  "toolchain.mismatch": {
    severity: "warn",
    allowable: false,
    exitCode: 6,
    summary:
      "The project asks for a tool version (.nvmrc, engines, packageManager) that is not active and no version manager (mise, fnm, Volta) on PATH can activate; the install runs with what is there",
  },
  "strip.kept": {
    severity: "info",
    allowable: false,
    exitCode: 6,
    summary:
      "Paths a plugin or strip.extra proposed stay in the snapshot; the message says why for each (git tracks it, strip.keep or strip.never matches, it holds a repository, dependencies are kept)",
  },
  "verify.changed": {
    severity: "block",
    allowable: false,
    exitCode: 7,
    summary: "Files changed while the snapshot was made, again after one retry; nothing local was deleted",
  },
  "verify.mismatch": {
    severity: "block",
    allowable: false,
    exitCode: 7,
    summary:
      "The snapshot's listing does not match the folder (entries, types, sizes, modes or link targets): at offload the scan of the project, and nothing local was deleted; at onload the restored staging folder, which is removed while the stub stays",
  },
  "tool.missing": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "A bundled binary (restic or rclone) was not found; paths lists every place searched",
  },
} as const satisfies Record<string, FindingSpec>);

export type FindingCode = keyof typeof FINDINGS;

/** Builds a catalogued finding. Severity and allowable are properties of the code, so they come from the catalogue. */
export const finding = (
  code: FindingCode,
  detail: { message: string; fix?: string; paths?: string[] },
): Finding => {
  const spec: FindingSpec = FINDINGS[code];
  return {
    code,
    severity: spec.severity,
    message: detail.message,
    ...(detail.paths === undefined ? {} : { paths: detail.paths }),
    ...(detail.fix === undefined ? {} : { fix: detail.fix }),
    allowable: spec.allowable,
  };
};
