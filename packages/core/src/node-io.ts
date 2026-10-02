// The real LocalIo, on node:fs and the running process. Only the composition root (the CLI's main, and tests)
// imports it; core modules take a LocalIo as a parameter (run decision D21).

import { link, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { errorCode, type LocalIo } from "./io.ts";

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
