// A lock file shared by processes on one machine: managed.toml.lock, and the per-project locks in DESIGN.md
// "Local state per machine". It holds the PID, host and start time of its holder. The caller says what finding a
// held lock means (config.locked, …), so every lock shares one implementation.
//
// Taking it is an atomic create-if-absent (createExclusive), so two processes can never both create it. Within one
// process, acquirers of the same lock queue in memory first, so only one of them touches the file at a time. Each
// acquisition writes a random token, which stillHeld() and release() compare. A lock is stale when its holder is on
// this host and is either a dead process, or this process's own pid with a token none of its live acquisitions
// wrote (the pid was reused after a crash or reboot). A stale lock is moved aside under a unique name,
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
  /** Unique per acquisition; optional so a lock written without one is still readable (and never ours). */
  token: z.string().min(1).optional(),
});
export type LockHolder = z.infer<typeof LockHolderSchema>;

export interface HeldLock {
  readonly path: string;
  readonly holder: LockHolder;
  /** Whether the lock file still carries this acquisition's token: false if something broke or replaced it. */
  stillHeld(): Promise<boolean>;
  /** Deletes the lock file if it is still this one's, then lets the next in-process acquirer go. Idempotent. */
  release(): Promise<void>;
}

export interface LockOptions {
  /** How long to wait for a holder, in this process or another, on the io's monotonic clock. */
  timeoutMs: number;
  pollMs?: number;
  /**
   * The finding to fail with when the lock stays held. `holder` is undefined for an unreadable lock file;
   * `ours` is true when the holder is this process (a nested or still-running acquisition), so the message must
   * not suggest deleting the lock.
   */
  held(holder: LockHolder | undefined, path: string, ours: boolean): Finding;
  now?: () => Date;
}

/**
 * Per process: the in-memory queue tail for each lock path, and the tokens of live locks. Keyed by pid, not by the
 * ProcessInfo object, so two ProcessInfo objects for one process (a host port and nodeLocalIo, or a test's copy)
 * share one queue and one token set and can never take each other's live lock for a stale one.
 */
interface ProcessLocks {
  tails: Map<string, Promise<void>>;
  tokens: Set<string>;
}
const processLocks = new Map<number, ProcessLocks>();
const locksOf = (io: LocalIo): ProcessLocks => {
  let state = processLocks.get(io.proc.pid);
  if (state === undefined) {
    state = { tails: new Map(), tokens: new Set() };
    processLocks.set(io.proc.pid, state);
  }
  return state;
};

const newToken = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

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

const isStale = async (io: LocalIo, owner: LockHolder | undefined): Promise<boolean> => {
  if (owner === undefined || owner.host !== io.proc.hostname()) return false;
  if (owner.pid === io.proc.pid) return owner.token === undefined || !locksOf(io).tokens.has(owner.token);
  return !(await io.proc.isAlive(owner.pid));
};

/** Waits for `turn` until the deadline; false if the deadline passed first. */
const waitTurn = async (
  io: LocalIo,
  turn: Promise<void>,
  deadline: number,
  pollMs: number,
): Promise<boolean> => {
  let done = false;
  void turn.then(() => {
    done = true;
  });
  await Promise.resolve();
  while (!done) {
    if (io.proc.monotonicMs() >= deadline) return false;
    await Promise.race([turn, io.proc.sleep(pollMs)]);
  }
  return true;
};

/** Takes the lock at `path`, waiting up to timeoutMs for a holder; rejects only on unexpected I/O errors. */
export const acquireLock = async (
  io: LocalIo,
  path: string,
  options: LockOptions,
): Promise<Result<HeldLock>> => {
  const key = resolve(path);
  const pollMs = options.pollMs ?? 20;
  const deadline = io.proc.monotonicMs() + options.timeoutMs;
  const state = locksOf(io);

  // Queue behind earlier acquirers of this lock in this process; `done` lets the next one go.
  const before = state.tails.get(key) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((resolveTurn) => {
    done = resolveTurn;
  });
  const tail = before.then(() => mine);
  state.tails.set(key, tail);
  let passed = false;
  const pass = (): void => {
    if (passed) return;
    passed = true;
    done();
    if (state.tails.get(key) === tail) state.tails.delete(key);
  };

  try {
    if (!(await waitTurn(io, before, deadline, pollMs))) {
      // Leave the queue without blocking it: our turn passes as soon as the one before us is done.
      void before.then(pass);
      const current = await readLock(io, path);
      return fail(options.held(current?.holder, path, true));
    }

    const holder: LockHolder = {
      pid: io.proc.pid,
      host: io.proc.hostname(),
      startedAt: (options.now?.() ?? new Date()).toISOString(),
      token: newToken(),
    };
    const token = holder.token as string;
    const text = `${JSON.stringify(holder)}\n`;
    await io.fs.mkdirp(dirname(path));

    for (;;) {
      const current = await readLock(io, path);
      if (current === undefined) {
        state.tokens.add(token);
        if (await createExclusive(io, path, text)) {
          const stillHeld = async (): Promise<boolean> => (await readLock(io, path))?.holder?.token === token;
          let released = false;
          return ok({
            path,
            holder,
            stillHeld,
            release: async () => {
              if (released) return;
              released = true;
              try {
                if (await stillHeld()) {
                  try {
                    await io.fs.unlink(path);
                  } catch (error) {
                    if (errorCode(error) !== "ENOENT") throw error;
                  }
                }
              } finally {
                state.tokens.delete(token);
                pass();
              }
            },
          });
        }
        state.tokens.delete(token);
        continue; // Another process created it between our read and our create.
      }
      if (await isStale(io, current.holder)) {
        await breakStale(io, path, current.text);
        continue;
      }
      if (io.proc.monotonicMs() >= deadline) {
        pass();
        return fail(options.held(current.holder, path, false));
      }
      await io.proc.sleep(pollMs);
    }
  } catch (error) {
    pass();
    throw error;
  }
};
