// The file system and process calls core makes on this machine (run decision D21). Core never imports node:fs for
// them: every entry point takes a LocalIo, and only the composition root (the CLI's main, and tests) passes the real
// one, nodeLocalIo from node-io.ts. The host port (ports/host.ts, built on it by @plainport/host-macos) extends this
// shape, so it can take over by being passed in. Calls are async, like the rest of the core API. Fs methods reject with Node errors (with `code`:
// ENOENT, EEXIST, …) like node:fs; callers turn the expected ones into findings.

export interface LocalFs {
  /** The file's text; rejects with ENOENT when it does not exist. */
  readText(path: string): Promise<string>;
  /** Creates or truncates the file, writes the text and fsyncs it before resolving. */
  writeTextDurable(path: string, text: string): Promise<void>;
  /** The file's bytes; rejects with ENOENT when it does not exist. */
  readBytes(path: string): Promise<Uint8Array>;
  /**
   * Writes the bytes and fsyncs them before resolving. It creates or truncates the file; with `exclusive` it opens
   * with O_CREAT|O_EXCL instead and rejects with EEXIST if anything is there (create-if-absent where hard links are
   * missing, D41).
   */
  writeBytesDurable(path: string, data: Uint8Array, options?: { exclusive?: boolean }): Promise<void>;
  /** A hard link; rejects with EEXIST if `to` exists, which makes it an atomic create-if-absent. */
  link(from: string, to: string): Promise<void>;
  /** Atomically replaces `to`. */
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  /** Flushes a folder's entries (a rename or link in it); best effort where the platform cannot. */
  syncDir(path: string): Promise<void>;
  /** The path with every symlink resolved, spelled as the file system stores it; rejects with ENOENT. */
  realpath(path: string): Promise<string>;
  /** What is at the path, following symlinks; rejects with ENOENT when nothing is. */
  stat(path: string): Promise<FileStat>;
  /** A folder's entries with their own kind; a symlink is reported as one, never followed. */
  entries(path: string): Promise<DirEntry[]>;
  /** Whether this process may create files in the folder. */
  writable(path: string): Promise<boolean>;
  /** Whether the path is a regular file (symlinks followed) this process may execute; false when missing. */
  executable(path: string): Promise<boolean>;
  /** What is at the path itself: a symlink is described, never followed. Rejects with ENOENT when nothing is. */
  lstat(path: string): Promise<LinkStat>;
  /** A symlink's target, as stored. */
  readlink(path: string): Promise<string>;
  /** Whether this process may read the path (access(2) with R_OK, so ACLs count); false when missing. Opens
   * nothing, so a placeholder file is not downloaded. */
  readable(path: string): Promise<boolean>;
  /** Sets the path's permission bits (mode & 0o7777), following a symlink as chmod(2) does. */
  chmod(path: string, mode: number): Promise<void>;
  /** Bytes this process may still write on the volume holding the path (statfs: available blocks × block size). */
  freeBytes(path: string): Promise<number>;
  /**
   * Removes the path and everything below it, making read-only folders writable first; symlinks are removed, never
   * followed. Nothing there is fine. Only for plainport's own folders (staging) and what a plugin proves regenerable.
   */
  removeTree(path: string): Promise<void>;
}

export type FileKind = "file" | "dir" | "symlink" | "other";

export interface FileStat {
  kind: Exclude<FileKind, "symlink">;
  /** Device and inode: two paths with equal ones are the same file. */
  dev: number;
  ino: number;
}

/** One entry as lstat(2) sees it, for the scan. Sockets, FIFOs and device files are their own kinds. */
export interface LinkStat {
  kind: "file" | "dir" | "symlink" | "socket" | "fifo" | "device";
  /** Bytes: a file's length, a symlink's target length. */
  size: number;
  /** Permission bits, setuid, setgid and sticky included (st_mode & 0o7777). */
  mode: number;
  /** Nanoseconds since the epoch. */
  mtimeNs: bigint;
  /** The inode's change time, which every write, chmod or replace moves and nothing can set back. */
  ctimeNs: bigint;
}

export interface DirEntry {
  name: string;
  kind: FileKind;
}

export interface ProcessInfo {
  /** This process's pid. */
  readonly pid: number;
  hostname(): string;
  /** Whether a process with this pid exists on this host. */
  isAlive(pid: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  /** Milliseconds on a clock that never goes backwards, for deadlines. */
  monotonicMs(): number;
}

export interface LocalIo {
  fs: LocalFs;
  proc: ProcessInfo;
}

/** The `code` of a Node error (ENOENT, EEXIST, …), if it has one. */
export const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;

/**
 * The errno code (ENOENT, EACCES, …) of a failed system call, for a catch site that turns expected failures into
 * findings. Anything else, a TypeError, a guard's refusal (ERR_PLAINPORT_PATH_REFUSED), a plain string, is a bug and
 * is thrown again, so a catch never swallows one (AGENTS.md rule 7: exceptions mean bugs).
 */
/**
 * For a catch site that tolerates any expected system error (a cleanup that may fail): returns when `error` is one,
 * throws it again when it is a bug (systemErrorCode).
 */
export const assertSystemError = (error: unknown): void => {
  systemErrorCode(error);
};

export const systemErrorCode = (error: unknown): string => {
  const code = error instanceof Error ? errorCode(error) : undefined;
  if (code !== undefined && /^E[A-Z0-9]+$/.test(code)) return code;
  throw error;
};
