// The Engine port (DESIGN.md "Plugin interfaces → Engine"): what moves project data into and out of a store's
// repository. @plainport/engine-restic implements it over the pinned restic binary.
//
// As DESIGN.md's sketch says (run decision D27): every call returns a Result (AGENTS.md rule 7), and an engine is
// bound to one repository and its secret when it is made, so `init` takes neither. `entries` streams: a listing
// of hundreds of thousands of entries is handed over one by one, never held whole (fix r1 I3). `stream`, `forget`
// and `prune` arrive in M5.

import type { Failure, Ok, PlainportEvent, Result } from "@plainport/contract";

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
  /** RFC 3339 as the engine stores it, with nanoseconds and the local offset
   * (2026-10-03T03:36:47.319437918+02:00). Compare it as nanoseconds: a Date keeps only milliseconds. */
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

/**
 * A failed snapshot. `incomplete` names a snapshot the engine wrote anyway (restic exit 3, unreadable files): it is
 * in the repository but must never be used, so the offload saga journals it and records it as discarded (run
 * decision D28). Absent when the engine wrote none, or did not say which.
 */
export type SnapshotFailure = Failure & { incomplete?: { snapshot: string } };

export interface EntriesResult {
  /** The snapshot listed, as `list` describes it. */
  snapshot: SnapshotInfo;
  /** How many entries were handed to onEntry. */
  count: number;
}

export interface Engine {
  readonly id: string;
  /** Creates the repository. */
  init(ctx?: RunContext): Promise<Result<{ id: string }>>;
  snapshot(
    input: SnapshotInput,
    ctx: RunContext,
  ): Promise<Ok<{ id: string; stats: SnapshotStats }> | SnapshotFailure>;
  /** Snapshots carrying every tag in the filter. */
  list(filter: { tags?: readonly string[] }, ctx?: RunContext): Promise<Result<SnapshotInfo[]>>;
  /**
   * Hands every entry of a snapshot below its root to onEntry, one at a time (symlinks last, once their targets
   * are known). What onEntry received counts only when the Result is ok: a listing that cannot be shown whole
   * fails, after some entries may already have been handed over. onEntry runs inside the engine's output
   * handling: if it throws, that is a bug, so the engine stops restic and `entries` rejects with that error
   * instead of returning a Result.
   */
  entries(
    snapshot: string,
    onEntry: (entry: EntryMeta) => void,
    ctx?: RunContext,
  ): Promise<Result<EntriesResult>>;
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
