// The file system and process calls core makes on this machine (run decision D21). Core never imports node:fs for
// them: every entry point takes a LocalIo, and only the composition root (the CLI's main, and tests) passes the real
// one, nodeLocalIo from node-io.ts. The host port (Task 7) implements this same shape, so it can take over by being
// passed in. Calls are async, like the rest of the core API. Fs methods reject with Node errors (with `code`:
// ENOENT, EEXIST, …) like node:fs; callers turn the expected ones into findings.

export interface LocalFs {
  /** The file's text; rejects with ENOENT when it does not exist. */
  readText(path: string): Promise<string>;
  /** Creates or truncates the file, writes the text and fsyncs it before resolving. */
  writeTextDurable(path: string, text: string): Promise<void>;
  /** A hard link; rejects with EEXIST if `to` exists, which makes it an atomic create-if-absent. */
  link(from: string, to: string): Promise<void>;
  /** Atomically replaces `to`. */
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  /** Flushes a folder's entries (a rename or link in it); best effort where the platform cannot. */
  syncDir(path: string): Promise<void>;
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
