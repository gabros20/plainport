// The gate every project operation passes (ADR-0008, DESIGN.md "Offload process" step 1): the project's lock
// (locks/<project>.lock; a lock held by a dead process is broken, a live one is project.locked, exit 11), then the
// journals: an operation of this project that was interrupted must be finished or rolled back by `plainport recover`
// before a new one starts (journal.pending). A journal this build cannot read fails closed: it could be this
// project's. The lock is released on every way out but a crash. A simulated crash (InjectedFault) unwinds through
// here and releases it, which a killed process never does; the crash matrix uses the seam's `kill` action wherever
// what it checks is recover breaking a dead holder's lock. The body gets stillHeld(), to re-check the lock before an
// irreversible step (lock.ts's known limit). Offload uses it now; onload and recover take the same lock.

import { join } from "node:path";
import { fail, finding, type Result } from "@plainport/contract";
import { assertSystemError, type LocalIo } from "../io.ts";
import { type Journal, journalFile, readJournals } from "../journal/index.ts";
import { acquireLock, type LockHolder } from "../lock.ts";
import type { PlainportPaths } from "../paths.ts";
import { writeFailed } from "./journaled.ts";

/** Steps after which an operation is finished but for deleting its trash: they hold no project back. */
const RELEASED: ReadonlySet<string> = new Set(["offload.release.delete"]);

/** Whether an interrupted operation still holds its project back from a new one. */
export const holdsProjectBack = (journal: Journal): boolean => !RELEASED.has(journal.step);

const lockHeld = (address: string) => (holder: LockHolder | undefined, path: string, ours: boolean) =>
  finding("project.locked", {
    message: ours
      ? `this process is already working on ${address}`
      : `${address} is locked by ${
          holder === undefined
            ? "an unreadable lock file"
            : `plainport process ${holder.pid} on ${holder.host}, started ${holder.startedAt}`
        }`,
    fix:
      ours || holder !== undefined
        ? "wait for the other plainport run to finish, then re-run"
        : `delete ${path} if no plainport is running, then re-run`,
    paths: [path],
  });

export interface GateContext {
  io: LocalIo;
  paths: PlainportPaths;
  clock(): Date;
  log(level: "warn", message: string): void;
}

/** Runs `body` holding the project's lock, once no interrupted operation of the project is open. */
export interface ProjectLock {
  /** Whether this run still holds the project's lock. */
  stillHeld(): Promise<boolean>;
}

export const withProjectLock = async <T>(
  ctx: GateContext,
  project: { id: string; address: string },
  body: (lock: ProjectLock) => Promise<Result<T>>,
): Promise<Result<T>> => {
  const { io, paths } = ctx;
  const lockFile = join(paths.locksDir, `${project.id}.lock`);
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(io, lockFile, { timeoutMs: 0, held: lockHeld(project.address), now: ctx.clock });
  } catch (error) {
    return writeFailed(error, `taking the lock ${lockFile}`, false, lockFile);
  }
  if (!lock.ok) return lock;
  const held = lock.value;
  try {
    let journals: Awaited<ReturnType<typeof readJournals>>;
    try {
      journals = await readJournals(io, paths);
    } catch (error) {
      return writeFailed(error, `reading the journals in ${paths.journalDir}`, false, paths.journalDir);
    }
    const [unreadable] = journals.unreadable;
    if (unreadable !== undefined) {
      return fail(
        finding("journal.pending", {
          message: `${unreadable} is a journal this version of plainport cannot read, so it may be an interrupted operation of ${project.address}; nothing new was started`,
          fix: "run the plainport that wrote it (plainport recover), or plainport doctor, then re-run",
          paths: [unreadable],
        }),
      );
    }
    const open = journals.journals.find((j) => j.project.id === project.id && holdsProjectBack(j));
    if (open !== undefined) {
      return fail(
        finding("journal.pending", {
          message: `an ${open.kind} of ${project.address} (${open.op}) was interrupted at ${open.step}; nothing new was started`,
          fix: "plainport recover finishes or rolls it back, then re-run",
          paths: [journalFile(paths, open.op)],
        }),
      );
    }
    return await body({ stillHeld: () => held.stillHeld() });
  } finally {
    try {
      await held.release();
    } catch (error) {
      assertSystemError(error);
      ctx.log(
        "warn",
        `the lock ${lockFile} could not be removed; a later run breaks it once this process is gone`,
      );
    }
  }
};
