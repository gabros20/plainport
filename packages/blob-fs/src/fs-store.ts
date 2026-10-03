// The BlobStore port over node:fs (DESIGN.md "Plugin interfaces → BlobStore", "Store kinds": external SSD or local
// disk). A key is a file under the store's root. Every write goes to a temporary file beside the target first and is
// flushed; a create-only write then hard-links it into place, which fails if the key exists (exactly one of racing
// writers wins), and a replacing write renames it over the target. Either way a reader sees the whole old value or the
// whole new one.
//
// The store's root must already exist: a disk that is not mounted is store.unreachable, and nothing is ever created
// at its mount point (which would quietly fill the system disk). Folders below the root are made as needed.
//
// This adapter reads and writes the store's folder directly, as DESIGN.md says it does; that folder is the store,
// configured by the person, and never the home folder's plainport state.

import { link, lstat, mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Failure, fail, finding, ok, type Result } from "@plainport/contract";
import {
  assertBlobKey,
  assertBlobPrefix,
  type BlobEntry,
  type BlobStore,
  type PutOptions,
  systemErrorCode,
} from "@plainport/core";

/** `<name>.<pid>.<12 hex>.tmp`: what a write leaves behind if the process dies before its link or rename. */
const TEMP_NAME = /\.\d+\.[0-9a-f]{12}\.tmp$/;

const randomHex = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Flushes a folder's entries after a link or rename; not every platform can, so it is best effort. */
const syncDir = async (path: string): Promise<void> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    // Opening or syncing a folder is refused on some platforms; the write itself has been flushed.
  } finally {
    await handle?.close();
  }
};

const unlinkQuietly = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch {
    // Already gone; a leftover temporary file is never listed as a key.
  }
};

export const fsBlobStore = (root: string): BlobStore => {
  const pathOf = (key: string): string => join(root, ...key.split("/"));

  const unreachable = (detail: string): Failure =>
    fail(
      finding("store.unreachable", {
        message: `the store folder ${root} ${detail}`,
        fix: `mount the disk that holds ${root}, or point the store's path in config.toml at where it is now`,
        paths: [root],
      }),
    );
  const failed = (key: string, error: unknown): Failure =>
    fail(
      finding("store.failed", {
        message: `${key} in the store at ${root} could not be read or written: ${describe(error)}`,
        fix: `check that ${root} is writable and its disk has space, then re-run`,
        paths: [pathOf(key)],
      }),
    );

  /** Undefined when the root is a folder; store.unreachable when it is missing or is not one. */
  const checkRoot = async (): Promise<Failure | undefined> => {
    try {
      if ((await stat(root)).isDirectory()) return undefined;
      return unreachable("is not a folder");
    } catch (error) {
      const code = systemErrorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR")
        return unreachable("does not exist (is its disk mounted?)");
      return unreachable(`cannot be reached: ${describe(error)}`);
    }
  };

  /** Runs `body` once the root is there, turning I/O errors into store.failed for `key`. */
  const guarded = async <T>(key: string, body: () => Promise<Result<T>>): Promise<Result<T>> => {
    const missing = await checkRoot();
    if (missing) return missing;
    try {
      return await body();
    } catch (error) {
      systemErrorCode(error); // anything but a failed system call is a bug, and is thrown again
      return failed(key, error);
    }
  };

  const absent = (error: unknown): boolean => {
    const code = systemErrorCode(error);
    return code === "ENOENT" || code === "ENOTDIR";
  };

  const get = async (key: string): Promise<Result<Uint8Array | null>> =>
    guarded(key, async () => {
      try {
        return ok(new Uint8Array(await readFile(pathOf(key))));
      } catch (error) {
        if (absent(error)) return ok(null);
        throw error;
      }
    });

  const put = async (key: string, data: Uint8Array, opts: PutOptions): Promise<Result<{ etag?: string }>> =>
    guarded(key, async () => {
      const target = pathOf(key);
      await mkdir(dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.${randomHex()}.tmp`;
      try {
        const handle = await open(temp, "wx");
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (opts.ifNotExists) {
          try {
            await link(temp, target);
          } catch (error) {
            if (systemErrorCode(error) !== "EEXIST") throw error;
            return fail(
              finding("store.key-exists", {
                message: `${key} already exists in the store at ${root}; it was left as it was`,
                paths: [target],
              }),
            );
          }
        } else {
          await rename(temp, target);
        }
      } finally {
        await unlinkQuietly(temp);
      }
      await syncDir(dirname(target));
      return ok({});
    });

  /** Files under `dir` (a key's folder, or the root), as keys; symlinks and temporary files are skipped. */
  const walk = async (dir: string, keyPrefix: string, out: BlobEntry[]): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (absent(error)) return;
      throw error;
    }
    for (const name of names) {
      const path = join(dir, name);
      const key = `${keyPrefix}${name}`;
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(path);
      } catch (error) {
        if (absent(error)) continue; // removed while listing
        throw error;
      }
      if (info.isDirectory()) await walk(path, `${key}/`, out);
      else if (info.isFile() && !TEMP_NAME.test(name)) out.push({ key, size: info.size });
    }
  };

  const list = async (prefix: string): Promise<Result<BlobEntry[]>> =>
    guarded(prefix === "" ? "." : prefix, async () => {
      // Walk from the deepest folder the prefix names whole, then keep the keys that start with the prefix.
      const folder = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/") + 1) : "";
      const out: BlobEntry[] = [];
      await walk(folder === "" ? root : pathOf(folder.slice(0, -1)), folder, out);
      return ok(
        out
          .filter((entry) => entry.key.startsWith(prefix))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      );
    });

  const statKey = async (key: string): Promise<Result<{ size: number } | null>> =>
    guarded(key, async () => {
      try {
        const info = await lstat(pathOf(key));
        return ok(info.isFile() ? { size: info.size } : null);
      } catch (error) {
        if (absent(error)) return ok(null);
        throw error;
      }
    });

  const remove = async (key: string): Promise<Result<void>> =>
    guarded(key, async () => {
      try {
        await unlink(pathOf(key));
      } catch (error) {
        if (!absent(error)) throw error;
      }
      return ok(undefined);
    });

  // Keys are checked before anything is awaited, so a bad key throws at the call (a bug), not as a rejection.
  return {
    capabilities: () => ({ createIfAbsent: true, replaceIfMatch: false }),
    get: (key) => {
      assertBlobKey(key);
      return get(key);
    },
    put: (key, data, opts = {}) => {
      assertBlobKey(key);
      if (opts.ifMatch !== undefined)
        throw new Error("blob-fs cannot replace-if-match; check capabilities() first");
      return put(key, data, opts);
    },
    list: (prefix) => {
      assertBlobPrefix(prefix);
      return list(prefix);
    },
    stat: (key) => {
      assertBlobKey(key);
      return statKey(key);
    },
    delete: (key) => {
      assertBlobKey(key);
      return remove(key);
    },
  };
};
