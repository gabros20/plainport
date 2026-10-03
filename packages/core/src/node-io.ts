// The real LocalIo, on node:fs and the running process. Only the composition root (the CLI's main, and tests)
// imports it; core modules take a LocalIo as a parameter (run decision D21). Its `proc` is the one ProcessInfo of
// this process: the host port reuses it rather than making another.

import { constants } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  unlink,
} from "node:fs/promises";
import { hostname, uptime } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { type DirEntry, errorCode, type FileKind, type LinkStat, type LocalIo } from "./io.ts";

/**
 * realpath(3) through Bun 1.3.14 reports ENOENT for any path holding a backslash, although lstat and readdir see
 * it (Node resolves it). When a path reported missing is there, it is resolved here one component at a time:
 * realpath(3) wherever it works, and for a component it refuses, readlink for a symlink, or the parent's listing
 * for the spelling the volume stores. A missing path still rejects with ENOENT, a link loop with ELOOP.
 */
const realpathByParts = async (path: string, depth = 0): Promise<string> => {
  if (depth > 40)
    throw Object.assign(new Error(`ELOOP: too many symbolic links, realpath '${path}'`), { code: "ELOOP" });
  let current: string = sep;
  for (const name of resolve(path)
    .split(sep)
    .filter((part) => part !== "")) {
    const next = join(current, name);
    try {
      current = await realpath(next);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      // Missing, or refused: lstat tells which; a missing component rejects as realpath did.
      const info = await lstat(next);
      if (info.isSymbolicLink()) {
        current = await realpathByParts(resolve(dirname(next), await readlink(next)), depth + 1);
        continue;
      }
      const listed = await readdir(current);
      const fold = (s: string) => s.normalize("NFC").toLowerCase();
      current = join(
        current,
        listed.find((e) => e === name) ?? listed.find((e) => fold(e) === fold(name)) ?? name,
      );
    }
  }
  return current;
};

const linkKindOf = (info: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isSocket(): boolean;
  isFIFO(): boolean;
}): LinkStat["kind"] =>
  info.isSymbolicLink()
    ? "symlink"
    : info.isDirectory()
      ? "dir"
      : info.isFile()
        ? "file"
        : info.isSocket()
          ? "socket"
          : info.isFIFO()
            ? "fifo"
            : "device";

const kindOf = (entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind =>
  entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other";

/** Gives every folder below `path` (itself included) owner rwx, so rm can empty a read-only one; never follows links. */
const openUp = async (path: string): Promise<void> => {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (!info.isDirectory()) return;
  if ((Number(info.mode) & 0o700) !== 0o700) await chmod(path, (Number(info.mode) & 0o7777) | 0o700);
  for (const entry of await readdir(path, { withFileTypes: true }))
    if (entry.isDirectory()) await openUp(join(path, entry.name));
};

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
    readBytes: async (path) => new Uint8Array(await readFile(path)),
    writeBytesDurable: async (path, data, options = {}) => {
      const handle = await open(path, options.exclusive ? "wx" : "w", 0o644);
      try {
        await handle.writeFile(data);
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
    realpath: async (path) => {
      try {
        return await realpath(path);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        return realpathByParts(path);
      }
    },
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
    lstat: async (path) => {
      const info = await lstat(path, { bigint: true });
      return {
        kind: linkKindOf(info),
        size: Number(info.size),
        mode: Number(info.mode) & 0o7777,
        mtimeNs: info.mtimeNs,
        ctimeNs: info.ctimeNs,
      };
    },
    readlink: (path) => readlink(path),
    readable: async (path) => {
      try {
        await access(path, constants.R_OK);
        return true;
      } catch {
        return false;
      }
    },
    chmod: (path, mode) => chmod(path, mode & 0o7777),
    freeBytes: async (path) => {
      const info = await statfs(path);
      return Number(info.bavail) * Number(info.bsize);
    },
    removeTree: async (path) => {
      await openUp(path);
      await rm(path, { recursive: true, force: true });
    },
    rmdir: (path) => rmdir(path),
    mkdir: async (path) => {
      await mkdir(path);
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
    bootedAtMs: () => Date.now() - uptime() * 1000,
    sleep: (ms) => Bun.sleep(ms),
    monotonicMs: () => performance.now(),
  },
};
