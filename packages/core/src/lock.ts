// A lock file shared by processes on one machine: managed.toml.lock, and the per-project locks in DESIGN.md
// "Local state per machine". It holds the PID, host and start time of its holder. The caller says what finding a
// held lock means (config.locked, …), so every lock shares one implementation.
//
// Taking it is an atomic create-if-absent (createExclusive), so two processes can never both create it. A lock is
// stale when its holder is on this host and is either a dead process or this process's own pid without this
// process holding it (the pid was reused after a crash or reboot). A stale lock is moved aside under a unique name,
// checked to still be the stale one, and deleted. A lock held from another host, or one that cannot be read, is
// never broken: its holder cannot be checked. Waiting polls with the io's sleep and clock and writes nothing.
//
// Known limit: if a breaker moves aside a lock that a live process took between the breaker's read and its rename,
// and a third process creates a new lock before the breaker puts it back, two processes hold it at once. It needs a
// crashed holder and three racing processes; stillHeld() lets a writer re-check before it commits.

import { dirname, resolve } from "node:path";
import { type Finding, fail, ok, type Result } from "@plainport/contract";
import { z } from "zod";
import { createExclusive, TEMP_SUFFIX, tempPathFor } from "./atomic.ts";
import { errorCode, type LocalIo } from "./io.ts";

export const LockHolderSchema = z.strictObject({
  pid: z.number().int().positive(),
  host: z.string().min(1),
  startedAt: z.string().min(1),
});
export type LockHolder = z.infer<typeof LockHolderSchema>;

export interface HeldLock {
  readonly path: string;
  readonly holder: LockHolder;
  /** Whether the lock file is still this one's: false if something broke or replaced it. */
  stillHeld(): Promise<boolean>;
  /** Deletes the lock file if it is still this one's. Safe to call more than once. */
  release(): Promise<void>;
}

export interface LockOptions {
  /** How long to wait for a live holder, on the io's monotonic clock. */
  timeoutMs: number;
  pollMs?: number;
  /** The finding to fail with when the lock stays held; holder is undefined for an unreadable lock file. */
  held(holder: LockHolder | undefined, path: string): Finding;
  now?: () => Date;
}

/** Lock files this process holds right now, by resolved path. */
const heldHere = new Set<string>();

const readLock = async (
  io: LocalIo,
  path: string,
): Promise<{ text: string; holder: LockHolder | undefined } | undefined> => {
  let text: string;
  try {
    text = await io.fs.readText(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  let holder: LockHolder | undefined;
  try {
    const parsed = LockHolderSchema.safeParse(JSON.parse(text));
    holder = parsed.success ? parsed.data : undefined;
  } catch {
    holder = undefined;
  }
  return { text, holder };
};

/** Moves a stale lock aside and deletes it, putting it back if it turns out to be a newer, live one. */
const breakStale = async (io: LocalIo, path: string, staleText: string): Promise<void> => {
  const aside = `${tempPathFor(path, io).slice(0, -TEMP_SUFFIX.length)}.stale`;
  try {
    await io.fs.rename(path, aside);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return; // Someone else broke it first.
    throw error;
  }
  try {
    if ((await io.fs.readText(aside)) !== staleText) {
      try {
        await io.fs.link(aside, path);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
  } finally {
    await io.fs.unlink(aside);
  }
};

const isStale = async (io: LocalIo, key: string, owner: LockHolder | undefined): Promise<boolean> => {
  if (owner === undefined || owner.host !== io.proc.hostname()) return false;
  if (owner.pid === io.proc.pid) return !heldHere.has(key);
  return !(await io.proc.isAlive(owner.pid));
};

/** Takes the lock at `path`, waiting up to timeoutMs for a live holder; rejects only on unexpected I/O errors. */
export const acquireLock = async (
  io: LocalIo,
  path: string,
  options: LockOptions,
): Promise<Result<HeldLock>> => {
  const key = resolve(path);
  const holder: LockHolder = {
    pid: io.proc.pid,
    host: io.proc.hostname(),
    startedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  const text = `${JSON.stringify(holder)}\n`;
  const pollMs = options.pollMs ?? 20;
  const deadline = io.proc.monotonicMs() + options.timeoutMs;
  await io.fs.mkdirp(dirname(path));

  for (;;) {
    const current = await readLock(io, path);
    if (current === undefined) {
      if (!heldHere.has(key) && (await createExclusive(io, path, text))) {
        heldHere.add(key);
        const stillHeld = async (): Promise<boolean> => (await readLock(io, path))?.text === text;
        let released = false;
        return ok({
          path,
          holder,
          stillHeld,
          release: async () => {
            if (released) return;
            released = true;
            heldHere.delete(key);
            if (await stillHeld()) {
              try {
                await io.fs.unlink(path);
              } catch (error) {
                if (errorCode(error) !== "ENOENT") throw error;
              }
            }
          },
        });
      }
      if (!heldHere.has(key)) continue; // Someone else created it between our read and our create.
    } else if (await isStale(io, key, current.holder)) {
      await breakStale(io, path, current.text);
      continue;
    }
    if (io.proc.monotonicMs() >= deadline) return fail(options.held(current?.holder, path));
    await io.proc.sleep(pollMs);
  }
};
