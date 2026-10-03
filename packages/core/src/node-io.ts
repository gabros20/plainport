// The real LocalIo, on node:fs and the running process. Only the composition root (the CLI's main, and tests)
// imports it; core modules take a LocalIo as a parameter (run decision D21). Its `proc` is the one ProcessInfo of
// this process: the host port reuses it rather than making another.

import { constants } from "node:fs";
import {
  access,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { type DirEntry, errorCode, type FileKind, type LocalIo } from "./io.ts";

const kindOf = (entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind =>
  entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other";

export const nodeLocalIo: LocalIo = {
  fs: {
    readText: (path) => readFile(path, "utf8"),
    writeTextDurable: async (path, text) => {
      const handle = await open(path, "w", 0o644);
      try {
        await handle.writeFile(text, "utf8");
        // fsync: survives a process crash; on macOS a power loss needs F_FULLFSYNC, left to the host port.
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    link: (from, to) => link(from, to),
    rename: (from, to) => rename(from, to),
    unlink: (path) => unlink(path),
    mkdirp: async (path) => {
      await mkdir(path, { recursive: true });
    },
    readdir: (path) => readdir(path),
    syncDir: async (path) => {
      try {
        const handle = await open(path, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch {
        // Some platforms and file systems cannot fsync a folder; the rename itself is still atomic.
      }
    },
    // fs/promises' realpath is libuv's, so realpath(3): on macOS it also spells names as the volume stores them.
    realpath: (path) => realpath(path),
    stat: async (path) => {
      const info = await stat(path);
      const kind = kindOf(info);
      return { kind: kind === "symlink" ? "other" : kind, dev: info.dev, ino: info.ino };
    },
    entries: async (path) =>
      (await readdir(path, { withFileTypes: true })).map(
        (entry): DirEntry => ({ name: entry.name, kind: kindOf(entry) }),
      ),
    writable: async (path) => {
      try {
        await access(path, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    executable: async (path) => {
      try {
        if (!(await stat(path)).isFile()) return false;
        await access(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  },
  proc: {
    pid: process.pid,
    hostname: () => hostname(),
    isAlive: async (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM: it exists but belongs to someone else.
        return errorCode(error) === "EPERM";
      }
    },
    sleep: (ms) => Bun.sleep(ms),
    monotonicMs: () => performance.now(),
  },
};
