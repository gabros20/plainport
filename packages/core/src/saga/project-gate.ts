// The gate every project operation passes (ADR-0008, DESIGN.md "Offload process" step 1): the project's lock
// (locks/<project>.lock; a lock held by a dead process is broken, a live one is project.locked, exit 11), then the
// journals: an operation of this project that was interrupted must be finished or rolled back by `plainport recover`
// before a new one starts (journal.pending). A journal this build cannot read fails closed: when its `project.id`
// still reads it holds that project (and the projects nested with it) back, and when not it could be any project's,
// so it holds every one. The lock is released on every way out but a crash. A simulated crash (InjectedFault) unwinds through
// here and releases it, which a killed process never does; the crash matrix uses the seam's `kill` action wherever
// what it checks is recover breaking a dead holder's lock. The body gets stillHeld(), to re-check the lock before an
// irreversible step (lock.ts's known limit). Offload uses it now; onload and recover take the same lock.

import { join } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";
import { readDevice } from "../device.ts";
import { assertSystemError, type LocalIo, systemErrorCode } from "../io.ts";
import { type Journal, type JournalsRead, journalFile, readJournals } from "../journal/index.ts";
import { acquireLock, type LockHolder, liveHolder } from "../lock.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import { readRegistry } from "../registry.ts";
import { type CanonicalPath, canonicalPath, overlapByIdentity } from "../roots/canonical.ts";
import { listRoots } from "../roots/roots.ts";
import { writeFailed } from "./journaled.ts";

/** Steps after which an operation is finished but for deleting its trash: they hold no project back. An onload
 * closes its journal once it is committed and registered, so every onload step holds it back. */
const RELEASED: ReadonlySet<string> = new Set(["offload.release.delete"]);

/** Whether an interrupted operation still holds its project back from a new one. */
export const holdsProjectBack = (journal: Journal): boolean => !RELEASED.has(journal.step);

/** The unreadable journals that may be an operation of one of these projects: theirs, and those naming no project. */
export const unreadableOf = (read: JournalsRead, ids: ReadonlySet<string>): string[] =>
  read.unreadable.filter((path) => {
    const owner = read.owners[path];
    return owner === undefined || ids.has(owner.id);
  });

/**
 * Whether the plainport that wrote the journal is still running it: it holds the project's lock, live (lock.ts's
 * liveHolder: taken since this host booted, its process alive), under the journal's host and pid, and took it no later
 * than the journal's last write. A pid reused by another process after a crash or a reboot holds no such lock (a
 * crashed holder's lock is broken by the next acquirer, a pre-boot one is not live), so it never looks running.
 */
export const operationRunning = async (
  io: LocalIo,
  paths: PlainportPaths,
  journal: Journal,
): Promise<boolean> => {
  if (journal.host !== io.proc.hostname()) return false;
  let holder: LockHolder | undefined;
  try {
    holder = await liveHolder(io, join(paths.locksDir, `${journal.project.id}.lock`));
  } catch (error) {
    assertSystemError(error);
    return false;
  }
  return (
    holder !== undefined &&
    holder.pid === journal.pid &&
    Date.parse(holder.startedAt) <= Date.parse(journal.updatedAt)
  );
};

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
  /**
   * An interrupted operation the caller takes over or settles instead of refusing: onload's staging (`own`, this
   * project's), or every one for recover and gc. A nested project's (`own` false) is never handed to the body.
   */
  resume?(journal: Journal, own: boolean): boolean;
}

/** A registered project and its effective folder on this device: its override, else its root's place for it. */
export interface RegisteredFolder {
  id: string;
  address: string;
  folder: string;
  /** The folder's canonical form (symlinks resolved, the volume's spelling, its case rule), for comparing. */
  canon: CanonicalPath;
}

/**
 * Every registered project's effective folder on this device (D53 revised): `override ?? place`, where the place is
 * the root's binding here plus the path. A project whose root is not bound here, and has no override, has none.
 * Folders are compared canonically (R1): a spelling in another case on a volume that ignores case, or one through a
 * symlink, is the same folder.
 */
export const registeredFolders = async (
  io: LocalIo,
  paths: PlainportPaths,
  env: Env,
  /**
   * strict: a registered folder that cannot be resolved is a refusal, never dropped (D87, astra r2 finding 4): a
   * destructive caller cannot tell that the folder is not the one it is about to delete through another spelling.
   */
  options: { strict?: boolean } = {},
): Promise<Result<RegisteredFolder[]>> => {
  const registry = await readRegistry(io, paths);
  if (!registry.ok) return registry;
  const device = await readDevice(io, paths);
  if (!device.ok) return device;
  const listed = await listRoots(io, paths, {
    env,
    ...(device.value === undefined ? {} : { device: device.value.name }),
  });
  if (!listed.ok) return listed;
  const rootFolder = new Map(listed.value.roots.map((r) => [r.key, r.path]));
  const folders: RegisteredFolder[] = [];
  for (const [id, e] of Object.entries(registry.value.projects)) {
    const root = rootFolder.get(e.root);
    const folder = e.override ?? (root === undefined ? undefined : join(root, ...e.path.split("/")));
    if (folder === undefined) continue;
    const canon = await canonicalPath(io, folder, paths.home);
    if (!canon.ok && options.strict === true)
      return fail({
        ...canon.finding,
        message: `${e.root}:${e.path}'s folder ${folder} cannot be resolved, so nothing that may be it is deleted: ${canon.finding.message}`,
      });
    // For locking, a folder that cannot be resolved (a loop, no permission) holds nothing this device can reach.
    if (canon.ok)
      folders.push({ id, address: `${e.root}:${e.path}`, folder: canon.value.path, canon: canon.value });
  }
  return ok(folders);
};

export type Nested = RegisteredFolder & {
  /** Its folder lies inside this one. */
  inside: boolean;
  /** Its folder is this one (R2). */
  same: boolean;
};

/**
 * The registered projects nested with a folder (D53 revised), decided by canonical effective folders, never by
 * logical paths: those whose folder lies inside it (`inside`), is it (`same`), or holds it.
 */
export const nestedProjects = async (
  io: LocalIo,
  paths: PlainportPaths,
  folders: readonly RegisteredFolder[],
  project: { id?: string; folder: string },
): Promise<Result<Nested[]>> => {
  const canon = await canonicalPath(io, project.folder, paths.home);
  if (!canon.ok) return canon;
  const found: Nested[] = [];
  for (const f of folders) {
    if (f.id === project.id) continue;
    // By identity, so a firmlink or bind-mount spelling of one folder is still that folder (F3).
    const related = await overlapByIdentity(io, f.canon, canon.value);
    if (!related.ok) return related;
    const relation = related.value;
    if (relation === undefined) continue;
    found.push({ ...f, inside: relation === "inside", same: relation === "same" });
  }
  return ok(found.sort((x, y) => (x.id < y.id ? -1 : 1)));
};

/**
 * project.nested when `path`, something gc, housekeeping or recover is about to delete from a holder, is, holds or lies
 * inside a registered project's effective folder: a working copy is never deleted as staging or trash (D84). A
 * registry that cannot be read refuses too (fail closed).
 */
export const notAProject = async (
  io: LocalIo,
  paths: PlainportPaths,
  env: Env,
  path: string,
): Promise<Result<void>> => {
  const folders = await registeredFolders(io, paths, env, { strict: true });
  if (!folders.ok) return folders;
  const nested = await nestedProjects(io, paths, folders.value, { folder: path });
  if (!nested.ok) return nested;
  const [project] = nested.value;
  if (project === undefined) return ok(undefined);
  return fail(
    finding("project.nested", {
      message: `${path} ${project.same ? "is" : project.inside ? "holds" : "lies inside"} ${project.address}'s folder (${project.folder}), a registered working copy, so it was not deleted (D84)`,
      fix: `move ${project.folder} out of plainport's .plainport-* holder by hand (it is your working copy, not plainport's), then re-run`,
      paths: [path, project.folder],
    }),
  );
};

/**
 * The journals half of the gate, read-only: the project's own interrupted operation that `options.resume` takes over
 * (undefined when none), or journal.pending for an unreadable journal that may be the project's or a nested one's, or
 * an open operation the caller does not take over. withProjectLock runs it with the locks held; gateFindings without.
 */
const journalGate = async (
  ctx: GateContext,
  project: { id: string; address: string },
  options: GateOptions,
): Promise<Result<Journal | undefined>> => {
  const { io, paths } = ctx;
  let journals: Awaited<ReturnType<typeof readJournals>>;
  try {
    journals = await readJournals(io, paths);
  } catch (error) {
    return writeFailed(error, `reading the journals in ${paths.journalDir}`, false, paths.journalDir);
  }
  const [unreadable] = unreadableOf(
    journals,
    new Set([project.id, ...(options.related ?? []).map((r) => r.id)]),
  );
  if (unreadable !== undefined) {
    return fail(
      finding("journal.pending", {
        message: `${unreadable} is a journal this version of plainport cannot read, so it may be an interrupted operation of ${journals.owners[unreadable]?.address ?? project.address}; nothing new was started`,
        fix: "run plainport recover with the plainport version that wrote it, then re-run",
        paths: [unreadable],
      }),
    );
  }
  // The project's own interrupted operations, and those of the projects nested with it (D53): either changes the
  // folders this operation is about to touch.
  const nestedIds = new Set((options.related ?? []).map((r) => r.id));
  const open = journals.journals.filter((j) => j.project.id === project.id && holdsProjectBack(j));
  const nestedOpen = journals.journals.filter((j) => nestedIds.has(j.project.id) && holdsProjectBack(j));
  const [blocking] = [
    ...open.filter((j) => options.resume?.(j, true) !== true),
    ...nestedOpen.filter((j) => options.resume?.(j, false) !== true),
  ];
  if (blocking !== undefined) {
    const whose =
      blocking.project.id === project.id
        ? project.address
        : `${blocking.project.address}, which is nested with ${project.address} (D53)`;
    return fail(
      finding("journal.pending", {
        message: `an ${blocking.kind} of ${whose} (${blocking.op}) was interrupted at ${blocking.step}; nothing new was started`,
        fix: "plainport recover finishes or rolls it back, then re-run",
        paths: [journalFile(paths, blocking.op)],
      }),
    );
  }
  return ok(open[0]);
};

/**
 * What withProjectLock would refuse with, found without acquiring anything (a preview, D71): project.locked when the
 * project's lock, or a nested project's, is held by a live process, else journal.pending as the gate decides it;
 * otherwise the interrupted operation it would hand to the body. The same locks in the same order, the same journal
 * rules, so the preview and the run cannot disagree about a refusal.
 */
export const gateFindings = async (
  ctx: GateContext,
  project: { id: string; address: string },
  options: GateOptions = {},
): Promise<Result<Journal | undefined>> => {
  for (const each of [project, ...(options.related ?? [])]) {
    const lockFile = join(ctx.paths.locksDir, `${each.id}.lock`);
    let holder: LockHolder | undefined;
    try {
      holder = await liveHolder(ctx.io, lockFile);
    } catch (error) {
      assertSystemError(error);
    }
    if (holder === undefined) continue;
    const held = lockHeld(each.address)(holder, lockFile, false);
    return each === project
      ? fail(held)
      : fail({
          ...held,
          message: `${held.message}; ${each.address} is nested with ${project.address} (D53), so nothing was started`,
        });
  }
  return journalGate(ctx, project, options);
};

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
    const gated = await journalGate(ctx, project, options);
    if (!gated.ok) return gated;
    const open = gated.value;
    const own = held[0] as (typeof held)[number];
    // A lock file that cannot be read cannot be shown to be this run's: it reads as lost, so the body stops before
    // its next change, and the reason is said (AGENTS.md rule 7).
    const stillHeld = async (): Promise<boolean> => {
      try {
        return await own.stillHeld();
      } catch (error) {
        ctx.log(
          "warn",
          `the lock ${own.path} could not be read (${systemErrorCode(error)}), so this run cannot show it still holds it; it stops before its next change`,
        );
        return false;
      }
    };
    return await body({ stillHeld }, open);
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
