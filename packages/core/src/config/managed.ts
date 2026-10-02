// Writing managed.toml (DESIGN.md "Merging and writing"): every writer takes managed.toml.lock, reads the current
// file, applies its change, and replaces the file atomically through a temporary file and a rename. config.toml is
// never written: it is the user's, comments and all.

import { basename, dirname, join, resolve } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";
import { stringify } from "smol-toml";
import type { PlainportPaths } from "../paths.ts";
import { TEMP_SUFFIX, writeAtomic } from "./atomic.ts";
import { type ConfigIo, errorCode, nodeConfigIo } from "./io.ts";
import { acquireLock } from "./lock.ts";
import { type ConfigLayer, ConfigLayerSchema } from "./schema.ts";
import { describeIssues, readTomlFile } from "./toml.ts";

export const MANAGED_HEADER =
  "# Written by plainport. Put your own settings in config.toml: plainport rewrites this file without comments.\n";

export interface ManagedOptions {
  io?: ConfigIo;
  /** How long to wait for another writer's lock. Default 10 s. */
  timeoutMs?: number;
  now?: () => Date;
}

const writeFailed = (path: string, error: unknown): Result<never> =>
  fail(
    finding("config.write-failed", {
      message: `${path} could not be written: ${error instanceof Error ? error.message : String(error)}`,
      fix: `check that ${path} and its folder are writable and the disk has space, then re-run`,
      paths: [path],
    }),
  );

/** Temporary files a writer left behind when it died between writing and renaming: `managed.toml.<pid>.<hex>.tmp`. */
const removeOrphans = (io: ConfigIo, paths: PlainportPaths): void => {
  const prefix = `${basename(paths.managedFile)}.`;
  for (const name of io.readdir(dirname(paths.managedFile))) {
    if (!name.startsWith(prefix) || !name.endsWith(TEMP_SUFFIX)) continue;
    if (!/^\d+\.[0-9a-f]+$/.test(name.slice(prefix.length, -TEMP_SUFFIX.length))) continue;
    try {
      io.unlink(join(dirname(paths.managedFile), name));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
};

/**
 * Applies `update` to managed.toml under its lock. The update gets the current contents (an empty table if the file
 * does not exist yet) and returns the new ones, which must still be a valid config layer. Returns what was written.
 * An exception thrown by `update` is a bug: the lock is released and it propagates.
 */
export const updateManaged = async (
  paths: PlainportPaths,
  update: (managed: ConfigLayer) => ConfigLayer,
  options: ManagedOptions = {},
): Promise<Result<ConfigLayer>> => {
  const io = options.io ?? nodeConfigIo;
  const file = paths.managedFile;
  if (resolve(paths.configFile) === resolve(file)) {
    return fail(
      finding("config.read-only", {
        message: `the config file is ${file}, the file plainport writes; plainport never rewrites your config file`,
        fix: "point --config or PLAINPORT_CONFIG at your own config.toml, not managed.toml",
        paths: [file],
      }),
    );
  }

  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(io, paths.managedLock, {
      timeoutMs: options.timeoutMs ?? 10_000,
      what: "managed.toml",
      ...(options.now && { now: options.now }),
    });
  } catch (error) {
    return writeFailed(paths.managedLock, error);
  }
  if (!lock.ok) return lock;
  const held = lock.value;
  try {
    try {
      removeOrphans(io, paths);
    } catch (error) {
      return writeFailed(file, error);
    }
    const current = readTomlFile(io, file, ConfigLayerSchema);
    if (current.kind === "invalid") {
      return fail(
        finding("config.invalid", {
          message: `${file} is not valid (${current.message}), so plainport will not overwrite it`,
          fix: `fix ${file}${current.line === undefined ? "" : ` at line ${current.line}`}, or move it aside, then re-run`,
          paths: [file],
        }),
      );
    }
    const before: ConfigLayer = current.kind === "ok" ? structuredClone(current.value) : {};
    const next = ConfigLayerSchema.safeParse(update(before));
    if (!next.success) {
      return fail(
        finding("config.invalid", {
          message: `the change would make ${file} invalid: ${describeIssues(next.error)}; nothing was written`,
          fix: "this is a bug in the command that made the change; report it with the message above",
          paths: [file],
        }),
      );
    }
    if (!held.stillHeld()) {
      return fail(
        finding("config.locked", {
          message: `${paths.managedLock} was taken over while this change was being made; nothing was written`,
          fix: "re-run",
          paths: [paths.managedLock],
        }),
      );
    }
    try {
      writeAtomic(io, file, MANAGED_HEADER + stringify(next.data));
    } catch (error) {
      return writeFailed(file, error);
    }
    return ok(next.data);
  } finally {
    held.release();
  }
};
