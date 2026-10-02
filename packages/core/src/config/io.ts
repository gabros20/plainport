// The file system and process seam for config, locks and device identity. Every call the config code makes on the
// machine goes through a ConfigIo, so the host port (Task 7) can route it through itself and tests can inject
// faults. Methods throw Node errors (with `code`: ENOENT, EEXIST, …) like node:fs; callers turn the expected ones
// into findings.

import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";

export interface ConfigIo {
  /** The file's text; throws ENOENT when it does not exist. */
  readText(path: string): string;
  /** Creates or truncates the file, writes the text and flushes it to disk (fsync) before returning. */
  writeTextDurable(path: string, text: string): void;
  /** A hard link; throws EEXIST if `to` exists, which makes it an atomic create-if-absent. */
  link(from: string, to: string): void;
  /** Atomically replaces `to`. */
  rename(from: string, to: string): void;
  unlink(path: string): void;
  mkdirp(path: string): void;
  readdir(path: string): string[];
  /** Flushes a folder's entries (a rename or link in it) to disk; best effort where the platform cannot. */
  syncDir(path: string): void;
  readonly pid: number;
  hostname(): string;
  /** Whether a process with this pid exists on this host. */
  isAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
}

/** The `code` of a Node error (ENOENT, EEXIST, …), if it has one. */
export const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;

export const nodeConfigIo: ConfigIo = {
  readText: (path) => readFileSync(path, "utf8"),
  writeTextDurable: (path, text) => {
    const fd = openSync(path, "w", 0o644);
    try {
      const bytes = Buffer.from(text, "utf8");
      for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  link: (from, to) => linkSync(from, to),
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path),
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true });
  },
  readdir: (path) => readdirSync(path),
  syncDir: (path) => {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      fsyncSync(fd);
    } catch {
      // Some platforms and file systems cannot fsync a folder; the rename itself is still atomic.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
  pid: process.pid,
  hostname: () => hostname(),
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM: it exists but belongs to someone else.
      return errorCode(error) === "EPERM";
    }
  },
  sleep: (ms) => Bun.sleep(ms),
};
