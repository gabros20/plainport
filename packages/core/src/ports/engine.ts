// The Engine port (DESIGN.md "Plugin interfaces → Engine"): what moves project data into and out of a store's
// repository. @plainport/engine-restic implements it over the pinned restic binary.
//
// It differs from the DESIGN sketch in three ways, all from AGENTS.md: every call returns a Result (rule 7), an
// engine is bound to one repository and its secret when it is made (so `init` takes neither), and `entries`
// returns the whole listing at once, because the listing is captured whole or not at all (the runner's capture
// mode). `stream`, `forget` and `prune` arrive with the milestones that need them.

import type { PlainportEvent, Result } from "@plainport/contract";

export type ProgressEvent = Extract<PlainportEvent, { type: "progress" }>;
export type EngineLogEvent = Extract<PlainportEvent, { type: "log" }>;

/** How a caller follows and stops one engine call. */
export interface RunContext {
  /** The operation's id, carried by every event. */
  op: string;
  /** Aborting it stops the engine's child processes; the call ends as process.cancelled. */
  signal?: AbortSignal;
  /** Receives progress events and the engine's log lines, secrets already removed. */
  emit?(event: ProgressEvent | EngineLogEvent): void;
}

export interface SnapshotInput {
  /** The project folder, absolute. The snapshot's root is this folder. */
  dir: string;
  /** Paths relative to dir to leave out (the strip set). Each names one path exactly; nothing is a pattern. */
  excludes: readonly string[];
  /** The previous snapshot of the same folder, so unchanged files are not read again. */
  parent?: string;
  /** Stored with the snapshot (DESIGN.md "Catalog": plainport, plainport:project=<ulid>, …). */
  tags: readonly string[];
}

export interface SnapshotStats {
  filesNew: number;
  filesChanged: number;
  filesUnmodified: number;
  dirsNew: number;
  dirsChanged: number;
  dirsUnmodified: number;
  /** Bytes added to the repository before compression. */
  dataAdded: number;
  totalFilesProcessed: number;
  totalBytesProcessed: number;
}

export interface SnapshotInfo {
  /** The engine's own id for the snapshot in this repository. */
  id: string;
  /** When the snapshot was started, as the engine wrote it (RFC 3339). */
  time: string;
  hostname: string;
  paths: string[];
  tags: string[];
  parent?: string;
}

export type EntryType = "file" | "dir" | "symlink" | "dev" | "chardev" | "fifo" | "socket" | "irregular";

export interface EntryMeta {
  /** Relative to the snapshot's root, "/"-separated, without a leading slash. */
  path: string;
  type: EntryType;
  /** Files only. */
  size?: number;
  /** POSIX permission bits, setuid, setgid and sticky included (mode & 0o7777). */
  mode: number;
  /** RFC 3339. */
  mtime: string;
  /** Symlinks only. */
  linkTarget?: string;
}

export type OverwriteMode = "always" | "if-changed" | "if-newer" | "never";

export interface RestoreOptions {
  /** What to do with a file that already exists in the target. Default: always. */
  overwrite?: OverwriteMode;
  /** Delete files in the target that the snapshot lacks, except excluded ones. */
  delete?: boolean;
  /** Paths relative to the snapshot's root to leave alone, as in SnapshotInput.excludes. */
  excludes?: readonly string[];
}

export interface RestoreStats {
  totalFiles: number;
  filesRestored: number;
  filesSkipped: number;
  filesDeleted: number;
  totalBytes: number;
  bytesRestored: number;
  bytesSkipped: number;
}

export interface CheckReport {
  /** No errors were found. */
  ok: boolean;
  errors: number;
  /** What the engine said about each problem, secrets removed. */
  messages: string[];
}

export interface Engine {
  readonly id: string;
  /** Creates the repository. */
  init(ctx?: RunContext): Promise<Result<{ id: string }>>;
  snapshot(input: SnapshotInput, ctx: RunContext): Promise<Result<{ id: string; stats: SnapshotStats }>>;
  /** Snapshots carrying every tag in the filter. */
  list(filter: { tags?: readonly string[] }, ctx?: RunContext): Promise<Result<SnapshotInfo[]>>;
  /** Every entry of a snapshot below its root. */
  entries(snapshot: string, ctx?: RunContext): Promise<Result<EntryMeta[]>>;
  /** Writes the snapshot's tree into target, which it creates if needed. */
  restore(
    snapshot: string,
    target: string,
    ctx: RunContext,
    options?: RestoreOptions,
  ): Promise<Result<RestoreStats>>;
  /** Integrity: a damaged repository is an ok Result whose report is not ok. */
  check(options?: { readDataSubset?: string }, ctx?: RunContext): Promise<Result<CheckReport>>;
}
