// The BlobStore port on a local file system (DESIGN.md "Plugin interfaces → BlobStore", "Store kinds": external SSD
// or local disk). A key is a file under the store's root. Every call goes through the io port it is given, so the
// composition root passes the host port and its path guard sees each read and write (D21).
//
// A replacing write goes to a temporary file beside the target, is flushed, and is renamed over it: a reader sees
// the whole old value or the whole new one. A create-only write hard-links the flushed temporary file into place,
// which fails if the key exists, so exactly one of racing writers wins. File systems without hard links (exFAT and
// FAT32, the usual factory format of external SSDs, and some SMB mounts) refuse link(); there create-only falls back
// to opening the key itself with O_CREAT|O_EXCL (D41), which keeps the one winner but can leave a torn file if the
// process dies mid-write. Readers skip a torn event (catalog.event-skipped) and a retry of the same append completes
// it (catalog/log.ts).
//
// The store's root must already exist: a disk that is not mounted is store.unreachable, and nothing is ever created
// at its mount point (which would quietly fill the system disk). Folders below the root are made as needed. The root
// is looked at before every call, within STORE_PROBE_DEADLINE_MS: a network mount that hangs is store.unreachable then
// (D32), though the stat itself cannot be cancelled and waits on in the background (deadline.ts).

import { dirname, join } from "node:path";
import { type Failure, fail, finding, ok, type Result } from "@plainport/contract";
import {
  assertBlobKey,
  assertBlobPrefix,
  type BlobEntry,
  type BlobStore,
  type LocalIo,
  type PutOptions,
  STORE_PROBE_DEADLINE_MS,
  systemErrorCode,
  TEMP_SUFFIX,
  tempPathFor,
  withinDeadline,
} from "@plainport/core";

/** `<name>.<pid>.<12 hex>.tmp`: what a write leaves behind if the process dies before its link or rename. */
const TEMP_NAME = new RegExp(`\\.\\d+\\.[0-9a-f]{12}\\${TEMP_SUFFIX}$`);

/**
 * Files macOS writes beside others: AppleDouble `._<name>` sidecars on volumes without extended attributes (exFAT,
 * FAT, SMB) and Finder's `.DS_Store`. They are never plainport's keys, so a listing leaves them out.
 */
const MAC_METADATA = (name: string): boolean => name.startsWith("._") || name === ".DS_Store";

/** What link() fails with where the file system has no hard links. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface FsBlobStoreOptions {
  /** How long the root's probe may take; STORE_PROBE_DEADLINE_MS by default (tests shorten it). */
  probeDeadlineMs?: number;
}

export const fsBlobStore = (io: LocalIo, root: string, options: FsBlobStoreOptions = {}): BlobStore => {
  const { fs } = io;
  const deadline = options.probeDeadlineMs ?? STORE_PROBE_DEADLINE_MS;
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
  const exists = (key: string): Failure =>
    fail(
      finding("store.key-exists", {
        message: `${key} already exists in the store at ${root}; it was left as it was`,
        paths: [pathOf(key)],
      }),
    );

  /** Undefined when the root is a folder; store.unreachable when it is missing or is not one. */
  const checkRoot = async (): Promise<Failure | undefined> => {
    try {
      const probed = await withinDeadline(fs.stat(root), deadline);
      if (probed.timedOut)
        return unreachable(`did not answer within ${deadline / 1000} seconds (a network mount that hangs?)`);
      if (probed.value.kind === "dir") return undefined;
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
      systemErrorCode(error); // anything but a failed system call (a guard's refusal included) is thrown again
      return failed(key, error);
    }
  };

  const absent = (error: unknown): boolean => {
    const code = systemErrorCode(error);
    return code === "ENOENT" || code === "ENOTDIR";
  };

  const unlinkQuietly = async (path: string): Promise<void> => {
    try {
      await fs.unlink(path);
    } catch (error) {
      systemErrorCode(error); // already gone: a leftover temporary file is never listed as a key
    }
  };

  const get = async (key: string): Promise<Result<Uint8Array | null>> =>
    guarded(key, async () => {
      try {
        return ok(await fs.readBytes(pathOf(key)));
      } catch (error) {
        if (absent(error)) return ok(null);
        throw error;
      }
    });

  /** Creates the key with an exclusive open, where hard links are missing. */
  const createDirectly = async (
    key: string,
    target: string,
    data: Uint8Array,
  ): Promise<Result<{ etag?: string }>> => {
    try {
      await fs.writeBytesDurable(target, data, { exclusive: true });
    } catch (error) {
      if (systemErrorCode(error) === "EEXIST") return exists(key);
      throw error;
    }
    await fs.syncDir(dirname(target));
    return ok({});
  };

  const put = async (key: string, data: Uint8Array, opts: PutOptions): Promise<Result<{ etag?: string }>> =>
    guarded(key, async () => {
      const target = pathOf(key);
      await fs.mkdirp(dirname(target));
      const temp = tempPathFor(target, io);
      let linkless = false;
      try {
        await fs.writeBytesDurable(temp, data, { exclusive: true });
        if (opts.ifNotExists) {
          try {
            await fs.link(temp, target);
          } catch (error) {
            const code = systemErrorCode(error);
            if (code === "EEXIST") return exists(key);
            if (!NO_HARD_LINKS.has(code)) throw error;
            linkless = true;
          }
        } else {
          await fs.rename(temp, target);
        }
      } finally {
        await unlinkQuietly(temp);
      }
      if (linkless) return createDirectly(key, target, data);
      await fs.syncDir(dirname(target));
      return ok({});
    });

  /** Files under `dir` (a key's folder, or the root), as keys; symlinks, temporary files and macOS metadata are skipped. */
  const walk = async (dir: string, keyPrefix: string, out: BlobEntry[]): Promise<void> => {
    let entries: Awaited<ReturnType<typeof fs.entries>>;
    try {
      entries = await fs.entries(dir);
    } catch (error) {
      if (absent(error)) return;
      throw error;
    }
    for (const { name, kind } of entries) {
      const path = join(dir, name);
      const key = `${keyPrefix}${name}`;
      if (kind === "dir") await walk(path, `${key}/`, out);
      else if (kind === "file" && !TEMP_NAME.test(name) && !MAC_METADATA(name)) {
        try {
          out.push({ key, size: (await fs.lstat(path)).size });
        } catch (error) {
          if (!absent(error)) throw error; // removed while listing
        }
      }
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
        const info = await fs.lstat(pathOf(key));
        return ok(info.kind === "file" ? { size: info.size } : null);
      } catch (error) {
        if (absent(error)) return ok(null);
        throw error;
      }
    });

  const remove = async (key: string): Promise<Result<void>> =>
    guarded(key, async () => {
      try {
        await fs.unlink(pathOf(key));
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
