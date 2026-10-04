// One locked read-change-write of a file plainport owns (managed.toml, registry.json, later the kit ledger): take
// the file's lock, delete temporary files a crashed writer left beside it, read the current contents, apply the
// change, check the result, re-check the lock is still ours, and replace the file atomically. A refusal from the
// read, the change or the check writes nothing; the lock is always released, and a release that fails with an I/O
// error leaves a lock file the next writer breaks as stale (AGENTS.md rule 7: it is no exception). An exception
// thrown by the change is a bug: the lock is released and it propagates.

import { basename, dirname, join } from "node:path";
import { type Failure, type Finding, fail, type Result } from "@plainport/contract";
import { TEMP_SUFFIX, writeAtomic } from "./atomic.ts";
import { assertSystemError, errorCode, type LocalIo } from "./io.ts";
import { acquireLock, type HeldLock, type LockOptions } from "./lock.ts";

export interface LockedFile<T> {
  file: string;
  lockFile: string;
  /** The current contents (the empty value when the file does not exist), or a refusal to touch the file. */
  read(): Promise<Result<T>>;
  /** Checks what the change returned; a failure names the bug, since a change must keep the file valid. */
  check(value: T): Result<T>;
  encode(value: T): string;
  /** The finding when the lock stays held (see LockOptions.held). */
  held: LockOptions["held"];
  /** The finding when the lock was taken over while the change was being made. */
  takenOver: Finding;
  /** The refusal when the lock, the cleanup or the write fails with an I/O error. */
  writeFailed(path: string, error: unknown): Failure;
  timeoutMs?: number;
  now?: () => Date;
}

/** Temporary files a writer left behind when it died between writing and renaming: `<file>.<pid>.<hex>.tmp`. */
const removeOrphans = async (io: LocalIo, file: string): Promise<void> => {
  const prefix = `${basename(file)}.`;
  for (const name of await io.fs.readdir(dirname(file))) {
    if (!name.startsWith(prefix) || !name.endsWith(TEMP_SUFFIX)) continue;
    if (!/^\d+\.[0-9a-f]+$/.test(name.slice(prefix.length, -TEMP_SUFFIX.length))) continue;
    try {
      await io.fs.unlink(join(dirname(file), name));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
};

/** Applies `change` to the file under its lock; returns what was written. */
export const updateLockedFile = async <T>(
  io: LocalIo,
  spec: LockedFile<T>,
  change: (current: T) => Result<T> | Promise<Result<T>>,
): Promise<Result<T>> => {
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(io, spec.lockFile, {
      timeoutMs: spec.timeoutMs ?? 10_000,
      held: spec.held,
      ...(spec.now && { now: spec.now }),
    });
  } catch (error) {
    return spec.writeFailed(spec.lockFile, error);
  }
  if (!lock.ok) return lock;
  const held = lock.value;
  let result: Result<T>;
  try {
    result = await underLock(io, spec, change, held);
  } catch (error) {
    await releaseQuietly(held);
    throw error;
  }
  // The file is written (or refused) by now: a lock file that cannot be removed is broken as stale by the next writer.
  await releaseQuietly(held);
  return result;
};

/** Releases the lock; an I/O error leaves the lock file, which the next writer breaks once this process is gone. */
const releaseQuietly = async (held: HeldLock): Promise<void> => {
  try {
    await held.release();
  } catch (error) {
    assertSystemError(error);
  }
};

const underLock = async <T>(
  io: LocalIo,
  spec: LockedFile<T>,
  change: (current: T) => Result<T> | Promise<Result<T>>,
  held: HeldLock,
): Promise<Result<T>> => {
  try {
    await removeOrphans(io, spec.file);
  } catch (error) {
    return spec.writeFailed(spec.file, error);
  }
  const current = await spec.read();
  if (!current.ok) return current;
  const changed = await change(structuredClone(current.value));
  if (!changed.ok) return changed;
  const next = spec.check(changed.value);
  if (!next.ok) return next;
  // A lock file that cannot be read cannot be shown to be ours: nothing is written.
  let ours: boolean;
  try {
    ours = await held.stillHeld();
  } catch (error) {
    return spec.writeFailed(spec.lockFile, error);
  }
  if (!ours) return fail(spec.takenOver);
  try {
    await writeAtomic(io, spec.file, spec.encode(next.value));
  } catch (error) {
    return spec.writeFailed(spec.file, error);
  }
  return next;
};
