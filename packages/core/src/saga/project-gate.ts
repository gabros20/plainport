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
import type { ProjectRegistry } from "../registry.ts";
import { writeFailed } from "./journaled.ts";

/** Steps after which an operation is finished but for deleting its trash: they hold no project back. An onload
 * closes its journal once it is committed and registered, so every onload step holds it back. */
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

export interface ProjectLock {
  /** Whether this run still holds the project's lock. */
  stillHeld(): Promise<boolean>;
}

export interface GateOptions {
  /**
   * The registered projects nested with this one (inside it, or holding it, D53): their locks are taken too, so no
   * operation on one runs while this one changes the folder that holds or contains it.
   */
  related?: readonly { id: string; address: string }[];
  /** An interrupted operation of this project the caller takes over instead of refusing (onload's staging). */
  resume?(journal: Journal): boolean;
}

/** The registered projects whose folders hold, or lie inside, this project's (D53), by address. */
export const nestedProjects = (
  registry: ProjectRegistry,
  project: { id?: string; root: string; path: string },
): { id: string; address: string; path: string; inside: boolean; override?: string }[] =>
  Object.entries(registry.projects)
    .filter(
      ([id, e]) =>
        id !== project.id &&
        e.root === project.root &&
        e.path !== project.path &&
        (e.path.startsWith(`${project.path}/`) || project.path.startsWith(`${e.path}/`)),
    )
    .map(([id, e]) => ({
      id,
      address: `${e.root}:${e.path}`,
      path: e.path,
      inside: e.path.startsWith(`${project.path}/`),
      ...(e.override === undefined ? {} : { override: e.override }),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

/**
 * Runs `body` holding the project's lock and its nested projects' (options.related), once no interrupted operation
 * of the project is open; an open one `options.resume` accepts is handed to the body instead.
 */
export const withProjectLock = async <T>(
  ctx: GateContext,
  project: { id: string; address: string },
  body: (lock: ProjectLock, resumed?: Journal) => Promise<Result<T>>,
  options: GateOptions = {},
): Promise<Result<T>> => {
  const { io, paths } = ctx;
  const held: { path: string; release(): Promise<void>; stillHeld(): Promise<boolean> }[] = [];
  try {
    // The project's own lock first, then each nested one's (D53), all without waiting: a held one refuses at once.
    for (const each of [project, ...(options.related ?? [])]) {
      const lockFile = join(paths.locksDir, `${each.id}.lock`);
      let lock: Awaited<ReturnType<typeof acquireLock>>;
      try {
        lock = await acquireLock(io, lockFile, {
          timeoutMs: 0,
          held: lockHeld(each.address),
          now: ctx.clock,
        });
      } catch (error) {
        return writeFailed(error, `taking the lock ${lockFile}`, false, lockFile);
      }
      if (!lock.ok) {
        if (each === project) return lock;
        return fail({
          ...lock.finding,
          message: `${lock.finding.message}; ${each.address} is nested with ${project.address} (D53), so nothing was started`,
        });
      }
      held.push({ path: lockFile, release: lock.value.release, stillHeld: lock.value.stillHeld });
    }
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
    const open = journals.journals.filter((j) => j.project.id === project.id && holdsProjectBack(j));
    const [blocking] = open.filter((j) => options.resume?.(j) !== true);
    if (blocking !== undefined) {
      return fail(
        finding("journal.pending", {
          message: `an ${blocking.kind} of ${project.address} (${blocking.op}) was interrupted at ${blocking.step}; nothing new was started`,
          fix: "plainport recover finishes or rolls it back, then re-run",
          paths: [journalFile(paths, blocking.op)],
        }),
      );
    }
    const own = held[0] as (typeof held)[number];
    return await body({ stillHeld: () => own.stillHeld() }, open[0]);
  } finally {
    for (const lock of held.reverse()) {
      try {
        await lock.release();
      } catch (error) {
        assertSystemError(error);
        ctx.log(
          "warn",
          `the lock ${lock.path} could not be removed; a later run breaks it once this process is gone`,
        );
      }
    }
  }
};
