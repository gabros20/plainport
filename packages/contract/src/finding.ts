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
      "The store's latest snapshot of the project is not the one this working copy came from (another copy was offloaded since, or the project is conflicted); nothing local is deleted",
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
      "The catalog left out an event it could not read or use, and the snapshot this device knows of the project (its stub's or its registry's) is named by no readable event, so the head may be older than the newest snapshot; nothing is restored or offloaded. Upgrade plainport or sync the store, or name a snapshot with --snapshot, which keeps the stub that names the newer one (D86)",
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
    summary: "The person answering the prompts cancelled; nothing was written",
  },
  "command.unknown": {
    severity: "block",
    allowable: false,
    exitCode: 4,
    summary: "No registered command has this name; the message suggests the closest one",
  },
  "config.invalid": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "A config file does not parse or does not match its schema, and there is no last good copy to keep",
  },
  "config.kept-last-good": {
    severity: "warn",
    allowable: false,
    exitCode: 6,
    summary: "A config file broke since it was last loaded; its last good contents stay in effect",
  },
  "config.locked": {
    severity: "block",
    allowable: false,
    exitCode: 11,
    summary: "Another process holds managed.toml.lock",
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
    summary: "The config file named by --config or PLAINPORT_CONFIG does not exist",
  },
  "config.owned": {
    severity: "block",
    allowable: false,
    exitCode: 5,
    summary:
      "config.toml sets this already and wins over managed.toml, so plainport will not write a copy it would shadow; edit config.toml",
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
      "A package folder holds lockfiles of more than one package manager and no packageManager field says which to use",
  },
  "deps.no-lockfile": {
    severity: "warn",
    allowable: true,
    exitCode: 6,
    summary:
      "A package folder has no lockfile for its package manager, so onload would resolve fresh dependency versions",
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
    summary: "This device has no identity yet; plainport init creates it",
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
      "A file or folder an operation keeps for itself (its journal, lock, trash or stub) could not be read, written or moved: permissions, a full disk, an I/O error",
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
      "Repositories inside the project (nested clones and submodules) travel as plain files, their own .git included",
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
      "requirePushed is set, and commits, branches or stashes exist only in this copy of the repository; push them first",
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
      "An earlier operation on this project was interrupted and its journal is still open; plainport recover finishes or rolls it back. From recover: a journal this version cannot read, left as it is",
  },
  "path.stub-occupied": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "Something other than this project's stub is at <project>.plainport, where the stub would go; plainport never overwrites it",
  },
  "plan.expired": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "The approved plan is more than an hour old; plan again with --dry-run",
  },
  "offload.diverged-after-commit": {
    severity: "block",
    allowable: false,
    exitCode: 8,
    summary:
      "The project folder changed after its offload was committed (found by offload right before the rename, or by recover): the snapshot is the head, the folder is kept with its edits and no stub is written, and the next offload builds on the snapshot (D51, D52)",
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
      "The folder changed since the plan was made (its fingerprint differs), or the plan is for another project; a fresh plan is saved",
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
    summary: "A child process was cancelled; its whole process group was stopped",
  },
  "process.idle-timeout": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary: "A child process printed nothing for its idle deadline; its whole process group was stopped",
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
      "A child process printed more on stdout than its caller's capture limit; it was stopped rather than read in part",
  },
  "process.spawn-failed": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary:
      "A child process could not be started: the program or its working folder is missing or not usable",
  },
  "process.timeout": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary: "A child process ran past its overall deadline; its whole process group was stopped",
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
    summary: "Another plainport process holds this project's lock",
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
    summary: "registry.json exists but plainport may not read it; the file is left as it is",
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
    summary: "A confirm-class command ran without --yes or an approved --plan",
  },
  "root.defined-twice": {
    severity: "warn",
    allowable: false,
    exitCode: 6,
    summary: "config.toml and managed.toml both define a root; config.toml wins key by key, so edit it there",
  },
  "root.exists": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "A root with this key already exists",
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
      "Two roots on this device overlap or resolve to the same real path; every project belongs to one root",
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
    summary: "The root has no folder on this device; plainport root bind gives it one",
  },
  "store.failed": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary:
      "A read or write in the store failed (permissions, a full disk, an I/O error); the message names the key and the error",
  },
  "store.identity-changed": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "The store at this path is not the one this device knows (its meta/v1/store.json names another id, or none): a re-pointed path, another disk or a restored copy; nothing is synced",
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
      "The store has no identity this device recorded (plainport init sets a store up: its store.json, its restic repository)",
  },
  "store.root-mismatch": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "The store already holds another root's snapshots; one restic repository serves one root (ADR-0010, D48)",
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
    summary: "--dry-run was given to a command that has no preview",
  },
  "usage.invalid": {
    severity: "block",
    allowable: false,
    exitCode: 2,
    summary:
      "The arguments or options do not match the command's declared arguments; also restore without --snapshot when the project has no head, listing the candidate ids (D60)",
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
      "The landing volume has less free space than the snapshot, the dependencies recorded at offload and a 10% margin need; nothing was restored",
  },
  "hydrate.failed": {
    severity: "block",
    allowable: false,
    exitCode: 10,
    summary:
      "The files are restored but installing the dependencies failed (restored-unhydrated); the error's data names the project and snapshot, and plainport hydrate retries",
  },
  "lease.held": {
    severity: "warn",
    allowable: false,
    exitCode: 8,
    summary:
      "Another device holds the project's lease (it is onloaded there); a warning, or a refusal with exit 8 when onload.leases is strict",
  },
  "path.occupied": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "Something already stands where onload or restore would put the project, which never merge into it (fix names --to <path>); or a folder stands at the project's place after its offload's release moved the project aside, and neither is touched",
  },
  "project.already-local": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "The project's own onloaded copy is already on this device, so onload --to would make a second working copy; a side-by-side copy is plainport restore --snapshot <id> --to <path> (D56)",
  },
  "project.nested": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "The folder holds another registered project's effective folder (its --to override, else its root's place) on this device: offload the inner project first, or unregister it; onload --to refuses a landing folder inside another registered project's folder (D53)",
  },
  "snapshot.not-found": {
    severity: "block",
    allowable: false,
    exitCode: 4,
    summary:
      "The catalog has no snapshot of the project with this id, or the store holds none of it; plainport status <project> names its head",
  },
  "toolchain.mismatch": {
    severity: "warn",
    allowable: false,
    exitCode: 6,
    summary:
      "The project asks for a tool version (.nvmrc, engines, packageManager) that is not active and no version manager (mise, fnm, Volta) can activate; the install runs with what is there",
  },
  "strip.kept": {
    severity: "info",
    allowable: false,
    exitCode: 6,
    summary:
      "Paths a plugin or strip.extra proposed stay in the snapshot: git tracks them, strip.keep or strip.never protects them, they hold a repository, or dependencies are kept",
  },
  "verify.changed": {
    severity: "block",
    allowable: false,
    exitCode: 7,
    summary:
      "Files in the project changed while the snapshot was being made, again after one retry; nothing local was deleted",
  },
  "verify.mismatch": {
    severity: "block",
    allowable: false,
    exitCode: 7,
    summary:
      "The snapshot's listing does not match the folder: at offload the scan of the project (nothing local was deleted), at onload the restored staging folder (it is removed, and the stub stays); entries, types, sizes, modes or link targets",
  },
  "tool.missing": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "A bundled binary (restic or rclone) was not found",
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
