// A lock file shared by processes on one machine (managed.toml.lock now; the same format as the per-project locks in
// DESIGN.md "Local state per machine"): it holds the PID, host and start time of its holder.
//
// Taking it is an atomic create-if-absent (createExclusive), so two processes can never both create it. A lock
// whose holder is a dead process on this host is stale: it is moved aside under a unique name, checked to still be
// the stale one, and deleted. A lock held from another host is never broken, since its process cannot be checked.
//
// Known limit: if a breaker moves aside a lock that a live process took between the breaker's read and its rename,
// and a third process creates a new lock before the breaker puts it back, two processes hold it at once. It needs a
// crashed holder and three racing processes; stillHeld() lets a writer re-check before it commits.

import { dirname } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";
import { z } from "zod";
import { createExclusive, tempPathFor } from "./atomic.ts";
import { type ConfigIo, errorCode } from "./io.ts";

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
  stillHeld(): boolean;
  /** Deletes the lock file if it is still this one's. Safe to call more than once. */
  release(): void;
}

export interface LockOptions {
  /** How long to wait for a live holder before giving up with config.locked. */
  timeoutMs: number;
  pollMs?: number;
  /** What the lock protects, for the message: "managed.toml". */
  what: string;
  now?: () => Date;
}

const readLock = (
  io: ConfigIo,
  path: string,
): { text: string; holder: LockHolder | undefined } | undefined => {
  let text: string;
  try {
    text = io.readText(path);
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
const breakStale = (io: ConfigIo, path: string, staleText: string): void => {
  const aside = tempPathFor(path, io).replace(/\.tmp$/, ".stale");
  try {
    io.rename(path, aside);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return; // Someone else broke it first.
    throw error;
  }
  try {
    if (io.readText(aside) !== staleText) {
      try {
        io.link(aside, path);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
  } finally {
    io.unlink(aside);
  }
};

const describeHolder = (holder: LockHolder | undefined): string =>
  holder === undefined
    ? "an unreadable lock file"
    : `process ${holder.pid} on ${holder.host} (since ${holder.startedAt})`;

export const acquireLock = async (
  io: ConfigIo,
  path: string,
  options: LockOptions,
): Promise<Result<HeldLock>> => {
  const holder: LockHolder = {
    pid: io.pid,
    host: io.hostname(),
    startedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  const text = `${JSON.stringify(holder)}\n`;
  const pollMs = options.pollMs ?? 20;
  const deadline = Date.now() + options.timeoutMs;
  io.mkdirp(dirname(path));

  for (;;) {
    if (createExclusive(io, path, text)) {
      const stillHeld = (): boolean => readLock(io, path)?.text === text;
      return ok({
        path,
        holder,
        stillHeld,
        release: () => {
          if (stillHeld()) {
            try {
              io.unlink(path);
            } catch (error) {
              if (errorCode(error) !== "ENOENT") throw error;
            }
          }
        },
      });
    }
    const current = readLock(io, path);
    if (current === undefined) continue; // Released between our create and our read.
    const owner = current.holder;
    if (owner !== undefined && owner.host === holder.host && !io.isAlive(owner.pid)) {
      breakStale(io, path, current.text);
      continue;
    }
    if (Date.now() >= deadline) {
      const sameHost = owner !== undefined && owner.host === holder.host;
      return fail(
        finding("config.locked", {
          message: `${options.what} is locked by ${describeHolder(owner)}`,
          fix:
            owner === undefined
              ? `delete ${path} if no plainport is running, then re-run`
              : sameHost
                ? `wait for process ${owner.pid} to finish and re-run; if it is not plainport, delete ${path}`
                : `wait for plainport on ${owner.host} to finish and re-run; if none is running there, delete ${path}`,
          paths: [path],
        }),
      );
    }
    await io.sleep(pollMs);
  }
};
