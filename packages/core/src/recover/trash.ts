// A released offload's trash (DESIGN.md "Offload process" step 8, "CLI design" → gc): the folder waits in
// `<root>/.plainport-trash/<op>/` until the detached delete removes it, or, with keepLocalFor, until its deadline
// (journal at offload.release.delete with keepUntil). Two ways remove a kept trash:
//
// - `plainport gc` (collectTrash): deletes, under the project's lock, every released trash whose deadline has passed
//   (or that has none: its detached delete never ran); `--now` (early) deletes kept ones before their deadline too.
//   A trash an interrupted onload is renaming back (its journal names it as `reuse`) is never deleted.
// - housekeeping at the start of any write command (D59): a trash whose deadline has passed gets the detached delete,
//   under the project's lock, after its journal drops keepUntil, so an onload never renames back a folder being
//   deleted. A read command or a --dry-run only gets the notices below, so it writes nothing (D61).
//   It also says, on stderr, which operations were interrupted and that `plainport recover` settles them; it never
//   replays a journal itself (read commands never write, D45; an onload stopped before its swap is taken over by the
//   next onload).
//
// Only plainport's own trash and journals are deleted, and only for operations whose journal says committed and
// released; nothing else is touched.

import { dirname, join } from "node:path";
import { type Failure, type Finding, fail, failWith, finding, ok, type Result } from "@plainport/contract";
import { readDevice } from "../device.ts";
import { removeEmptyHolder } from "../holder.ts";
import { assertSystemError, type LocalIo, systemErrorCode } from "../io.ts";
import {
  type Journal,
  journalFile,
  type OffloadJournal,
  readJournals,
  removeJournal,
  rereadJournal,
  writeJournal,
} from "../journal/index.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import type { HostPorts } from "../ports/host.ts";
import { readRegistry } from "../registry.ts";
import { listRoots } from "../roots/roots.ts";
import { writeFailed } from "../saga/journaled.ts";
import { STAGING_DIR } from "../saga/onload.ts";
import { holdsProjectBack, notAProject, operationRunning, withProjectLock } from "../saga/project-gate.ts";
import { offloadTrashOf, rootFolderOf, TRASH_DIR } from "../saga/release.ts";
import { trashClaim, trashClaimFile } from "../trash-claim.ts";
import { isUlid } from "../ulid.ts";
import { notedStagingHolders, readStagingRecords, removeStagingRecord } from "./staging.ts";

export interface TrashDeps {
  host: HostPorts;
  paths: PlainportPaths;
  env: Env;
  log(level: "debug" | "info" | "warn", message: string): void;
  /** The command's clock, which deadlines are compared with; the host's when absent. */
  now?: () => Date;
}

export type TrashItem = {
  op: string;
  /** root:path. */
  project: string;
  projectId: string;
  trash: string;
  keepUntil?: string;
  /** What the trash held when it was deleted. */
  bytes?: number;
  /** Why a due trash was kept. */
  reason?: string;
};

export type GcReport = {
  deleted: TrashItem[];
  /** Before their deadline, or renamed back by an interrupted onload. */
  kept: TrashItem[];
  /** Not reached now: the finding says why (a lock a live process holds). */
  skipped: (TrashItem & { finding: Finding })[];
  freedBytes: number;
  /** Staging folders no live operation owned (a crashed restore's, an onload's whose journal is gone), removed. */
  staging: string[];
  /** A crashed restore's staging folder that could not be reached (its volume away): kept, with its record. */
  stagingKept: { staging: string; finding: Finding }[];
};

const released = (journal: Journal): journal is OffloadJournal =>
  journal.kind === "offload" && journal.step === "offload.release.delete";

const itemOf = (journal: OffloadJournal): TrashItem => ({
  op: journal.op,
  project: journal.project.address,
  projectId: journal.project.id,
  trash: journal.trash ?? offloadTrashOf(journal),
  ...(journal.keepUntil === undefined ? {} : { keepUntil: journal.keepUntil }),
});

/** Bytes of the files below a folder, never entering a folder named in `skip`; what cannot be read counts as nothing. */
export const treeBytes = async (
  io: LocalIo,
  path: string,
  skip: ReadonlySet<string> = new Set(),
): Promise<number> => {
  let total = 0;
  const visit = async (at: string) => {
    let entries: Awaited<ReturnType<LocalIo["fs"]["entries"]>>;
    try {
      entries = await io.fs.entries(at);
    } catch (error) {
      systemErrorCode(error);
      return;
    }
    for (const entry of entries) {
      const child = join(at, entry.name);
      if (entry.kind === "dir") {
        if (!skip.has(entry.name)) await visit(child);
      } else {
        try {
          total += (await io.fs.lstat(child)).size;
        } catch (error) {
          systemErrorCode(error);
        }
      }
    }
  };
  await visit(path);
  return total;
};

/**
 * Removes a released trash folder, any claim on it and the trash holder when that leaves it empty, once no live deleter claims it (D64: the caller checked, under
 * the project's lock). A folder found gone under the walk (a deleter that finished just before) is done.
 */
export const removeTrash = async (io: LocalIo, trash: string): Promise<void> => {
  try {
    await io.fs.removeTree(trash);
  } catch (error) {
    systemErrorCode(error);
    if (await stillThere(io, trash)) throw error;
  }
  // The claim, and a temporary one a delete killed while claiming left behind.
  for (const file of [trashClaimFile(trash), `${trashClaimFile(trash)}.tmp`]) {
    try {
      await io.fs.unlink(file);
    } catch (error) {
      if (systemErrorCode(error) !== "ENOENT") throw error;
    }
  }
  await removeEmptyHolder(io, dirname(trash), TRASH_DIR);
};

const stillThere = async (io: LocalIo, path: string): Promise<boolean> => {
  try {
    await io.fs.lstat(path);
    return true;
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return false;
    throw error;
  }
};

/**
 * Whether a released offload's trash is already gone while its root is here (D67): its delete ran, and only the
 * journal is left to close. A root that is away is not "gone": its trash may be on the unmounted volume.
 */
const finished = async (io: LocalIo, journal: OffloadJournal): Promise<boolean> => {
  if ((await rootAway(io, journal)) !== undefined) return false;
  try {
    return !(await stillThere(io, itemOf(journal).trash));
  } catch (error) {
    // A trash that cannot be looked at is not known to be gone: deleting it is what then says why (rule 7).
    assertSystemError(error);
    return false;
  }
};

/** This device's id, which a trash claim names (D64); empty when it cannot be read, so no claim is this device's. */
const thisDeviceId = async (io: LocalIo, paths: PlainportPaths): Promise<string> => {
  const read = await readDevice(io, paths);
  return read.ok && read.value !== undefined ? read.value.id : "";
};

/** Why a trash is left now: a live detached delete of this device claims it (D64). */
export const claimedReason = async (
  io: LocalIo,
  trash: string,
  device: string,
): Promise<string | undefined> => {
  const claimed = await trashClaim(io, trash, device);
  if (claimed.state !== "live") return undefined;
  return `its detached delete (process ${claimed.claim?.pid}, since ${claimed.claim?.startedAt}, claim ${trashClaimFile(trash)}) is deleting it`;
};

/** The onload journals renaming a released offload's trash back, by that offload's op. */
const renamedBack = (journals: readonly Journal[]): Map<string, string> => {
  const out = new Map<string, string>();
  for (const j of journals) if (j.kind === "onload" && j.reuse !== undefined) out.set(j.reuse.op, j.op);
  return out;
};

/**
 * root.path-missing when the project's root folder is not there (a volume that is not mounted): its trash is then
 * unavailable, not deleted, and its journal stays (D24).
 */
const rootAway = async (io: LocalIo, journal: OffloadJournal): Promise<Failure | undefined> => {
  const root = rootFolderOf(journal.project.path, journal.project.dir);
  try {
    if ((await io.fs.lstat(root)).kind === "dir") return undefined;
  } catch (error) {
    systemErrorCode(error);
  }
  return fail(
    finding("root.path-missing", {
      message: `${root}, which holds the trash of ${journal.project.address}'s offload ${journal.op}, is not there (a volume that is not mounted?); the trash and its journal were left as they are`,
      fix: "mount the volume, then run plainport gc",
      paths: [root],
    }),
  );
};

/** plainport gc: deletes released offloads' trash past its deadline, or all of it with `early` (see above). */
export const collectTrash = async (
  deps: TrashDeps,
  options: { early: boolean },
): Promise<Result<GcReport>> => {
  const { host, paths } = deps;
  const io: LocalIo = host;
  const clock = (): Date => deps.now?.() ?? host.clock.now();
  let read: Awaited<ReturnType<typeof readJournals>>;
  try {
    read = await readJournals(io, paths);
  } catch (error) {
    return writeFailed(error, `reading the journals in ${paths.journalDir}`, false, paths.journalDir);
  }
  const report: GcReport = {
    deleted: [],
    kept: [],
    skipped: [],
    freedBytes: 0,
    staging: [],
    stagingKept: [],
  };
  const self = await thisDeviceId(io, paths);
  let problem: Failure | undefined;
  for (const journal of read.journals.filter(released)) {
    const item = itemOf(journal);
    const due = journal.keepUntil === undefined || Date.parse(journal.keepUntil) <= clock().getTime();
    if (!due && !options.early) {
      report.kept.push(item);
      continue;
    }
    const away = await rootAway(io, journal);
    if (away !== undefined) {
      report.skipped.push({ ...item, finding: away.finding });
      problem ??= away;
      continue;
    }
    const gate = { io, paths, clock, log: deps.log };
    const done = await withProjectLock(
      gate,
      { id: journal.project.id, address: journal.project.address },
      async () => {
        // Read again under the lock: an onload may have renamed the folder back, a detached delete finished it.
        const reread = await rereadJournal(io, paths, journal.op);
        if (!reread.ok) return reread;
        const now = reread.value;
        if (now === undefined || !released(now)) return ok(undefined);
        let journals: Journal[];
        try {
          journals = (await readJournals(io, paths)).journals;
        } catch (error) {
          return writeFailed(error, `reading the journals in ${paths.journalDir}`, false, paths.journalDir);
        }
        const onload = renamedBack(journals).get(now.op);
        if (onload !== undefined) {
          report.kept.push({
            ...itemOf(now),
            reason: `the interrupted onload ${onload} is renaming it back; plainport recover settles that onload first`,
          });
          return ok(undefined);
        }
        const trash = itemOf(now).trash;
        // One deleter at a time (D64): a live detached delete's trash is its own.
        const deleting = await claimedReason(io, trash, self);
        if (deleting !== undefined) {
          report.kept.push({ ...itemOf(now), reason: deleting });
          return ok(undefined);
        }
        // A registered working copy is never deleted as trash (D84).
        const guarded = await notAProject(io, paths, deps.env, trash);
        if (!guarded.ok) return guarded;
        // Its trash already gone (a delete killed before it closed the journal, D67): finished; the journal goes.
        if (await finished(io, now)) {
          try {
            await removeTrash(io, trash);
            await removeJournal(io, paths, now.op);
          } catch (error) {
            return writeFailed(error, `closing the journal of ${now.op}`, true, journalFile(paths, now.op));
          }
          return ok(undefined);
        }
        const bytes = await treeBytes(io, trash);
        try {
          await removeTrash(io, trash);
          await removeJournal(io, paths, now.op);
        } catch (error) {
          return writeFailed(error, `deleting the trash ${trash}`, true, trash);
        }
        report.deleted.push({ ...itemOf(now), bytes });
        report.freedBytes += bytes;
        deps.log("info", `deleted ${trash}, the trash of ${now.project.address}'s offload ${now.op}`);
        return ok(undefined);
      },
      // The trash holds nothing an interrupted operation of the project needs but the renamed-back folder above.
      { resume: () => true },
    );
    if (!done.ok) {
      report.skipped.push({ ...item, finding: done.finding });
      problem ??= done;
    }
  }
  const swept = await sweepStaging(deps, clock);
  report.staging.push(...swept.removed);
  report.stagingKept.push(...swept.kept);
  problem ??= swept.problems[0];
  if (problem !== undefined) return failWith(problem.finding, report, problem.exitCode);
  return ok(report);
};

/**
 * Abandoned staging (D60): a restore's that its record names, once nobody holds its project's lock (a running
 * restore holds it), or kept and reported while its volume is away; and, in the staging holders of this device's
 * roots, its registry's landing folders and every noted `onload --to` holder, an onload's whose journal is gone (a lost
 * write, D24). The holders are listed before the journals and records are read: an operation
 * writes its journal or record before it makes its staging folder, so a folder listed is owned by something read.
 */
const sweepStaging = async (
  deps: TrashDeps,
  clock: () => Date,
): Promise<{ removed: string[]; kept: GcReport["stagingKept"]; problems: Failure[] }> => {
  const { host, paths } = deps;
  const io: LocalIo = host;
  const removed: string[] = [];
  const kept: GcReport["stagingKept"] = [];
  const problems: Failure[] = [];
  const holders = new Set<string>();
  const device = await readDevice(io, paths);
  if (!device.ok) return { removed, kept, problems: [device] };
  const roots = await listRoots(io, paths, {
    env: deps.env,
    ...(device.value === undefined ? {} : { device: device.value.name }),
  });
  if (roots.ok)
    for (const r of roots.value.roots) if (r.path !== undefined) holders.add(join(r.path, STAGING_DIR));
  const registry = await readRegistry(io, paths);
  if (registry.ok)
    for (const e of Object.values(registry.value.projects))
      if (e.override !== undefined) holders.add(join(dirname(e.override), STAGING_DIR));
  try {
    for (const noted of await notedStagingHolders(io, paths)) holders.add(noted);
  } catch (error) {
    problems.push(writeFailed(error, "reading the noted staging holders", false, paths.stateDir));
  }
  const listed: [string, string][] = [];
  for (const holder of holders) {
    let names: string[];
    try {
      names = await io.fs.readdir(holder);
    } catch (error) {
      const code = systemErrorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      problems.push(
        fail(
          finding("fs.unreadable", {
            message: `${holder} cannot be read (${code}), so the staging folders in it were left as they are`,
            fix: `check that you can read ${holder}, then re-run plainport gc`,
            paths: [holder],
          }),
        ),
      );
      continue;
    }
    for (const name of names) if (isUlid(name)) listed.push([holder, name]);
  }
  let read: Awaited<ReturnType<typeof readJournals>>;
  let records: Awaited<ReturnType<typeof readStagingRecords>>;
  try {
    read = await readJournals(io, paths);
    records = await readStagingRecords(io, paths);
  } catch (error) {
    problems.push(writeFailed(error, `reading the journals in ${paths.journalDir}`, false, paths.journalDir));
    return { removed, kept, problems };
  }
  const owners = new Set(read.journals.map((j) => j.op));
  const recorded = new Set(records.map((r) => r.staging));
  // A journal this version cannot read may own any staging folder: none without an owner is removed (fail closed).
  if (read.unreadable.length > 0) {
    if (listed.some(([holder, name]) => !owners.has(name) && !recorded.has(join(holder, name))))
      problems.push(
        fail(
          finding("journal.pending", {
            message: `${read.unreadable.join(", ")} cannot be read by this version of plainport and may own a staging folder, so no staging folder without a known owner was removed`,
            fix: "run plainport recover with the plainport version that wrote it, then re-run plainport gc",
            paths: read.unreadable,
          }),
        ),
      );
  } else {
    for (const [holder, name] of listed) {
      const staging = join(holder, name);
      if (owners.has(name) || recorded.has(staging)) continue;
      // A registered working copy that landed in a holder is never abandoned staging (D84).
      const guarded = await notAProject(io, paths, deps.env, staging);
      if (!guarded.ok) {
        kept.push({ staging, finding: guarded.finding });
        problems.push(guarded);
        continue;
      }
      try {
        await io.fs.removeTree(staging);
        await removeEmptyHolder(io, holder, STAGING_DIR);
      } catch (error) {
        problems.push(writeFailed(error, `removing the abandoned staging folder ${staging}`, false, staging));
        continue;
      }
      removed.push(staging);
    }
  }
  for (const record of records) {
    // Its folder's volume away: the record stays for when it is back, and the report says so.
    const parent = dirname(dirname(record.staging));
    let there = false;
    try {
      there = (await io.fs.lstat(parent)).kind === "dir";
    } catch (error) {
      systemErrorCode(error);
    }
    if (!there) {
      const away = fail(
        finding("root.path-missing", {
          message: `${parent}, which holds the staging folder ${record.staging} of a restore of ${record.project.address} that stopped, is not there (a volume that is not mounted?); it was left as it is`,
          fix: "mount the volume, then run plainport gc",
          paths: [parent],
        }),
      );
      kept.push({ staging: record.staging, finding: away.finding });
      problems.push(away);
      continue;
    }
    const gate = { io, paths, clock, log: deps.log };
    // A running restore holds the project's lock: a held lock means the folder is live, and it is left alone.
    const done = await withProjectLock(
      gate,
      record.project,
      async () => {
        const guarded = await notAProject(io, paths, deps.env, record.staging);
        if (!guarded.ok) return guarded;
        try {
          await io.fs.removeTree(record.staging);
          await removeEmptyHolder(io, dirname(record.staging), STAGING_DIR);
          await removeStagingRecord(io, paths, record.op);
        } catch (error) {
          return writeFailed(error, `removing ${record.staging}`, false, record.staging);
        }
        removed.push(record.staging);
        return ok(undefined);
      },
      { resume: () => true },
    );
    if (done.ok) continue;
    if (done.finding.code === "project.locked")
      deps.log("info", `${record.staging} is left: ${done.finding.message}`);
    else problems.push(done);
  }
  return { removed, kept, problems };
};

export type Housekept = {
  /** Trash past its deadline handed to the detached delete. */
  started: TrashItem[];
  /** One line per interrupted operation: what stopped where, and that plainport recover settles it. */
  notices: string[];
};

/**
 * Housekeeping at the start of any command (D59; see above). It never fails the command: what it cannot do now
 * (a lock held, a journal it cannot rewrite) is left for gc or recover, with a warning in the log. `deleteDue` false
 * (a read command, or any --dry-run) only gathers the notices: nothing is written or deleted (D61).
 */
export const housekeeping = async (
  deps: TrashDeps,
  options: { deleteDue: boolean } = { deleteDue: true },
): Promise<Housekept> => {
  const { host, paths } = deps;
  const io: LocalIo = host;
  const clock = (): Date => deps.now?.() ?? host.clock.now();
  const done: Housekept = { started: [], notices: [] };
  let read: Awaited<ReturnType<typeof readJournals>>;
  try {
    read = await readJournals(io, paths);
  } catch (error) {
    systemErrorCode(error);
    return done;
  }
  // A journal this version cannot read holds its project back, or every project when none reads (project-gate.ts).
  for (const path of read.unreadable) {
    const owner = read.owners[path];
    done.notices.push(
      owner === undefined
        ? `${path} is a journal this version of plainport cannot read and may be any project's, so no project can be offloaded or onloaded until it is settled; plainport recover reports it`
        : `${path} is a journal of ${owner.address ?? owner.id} this version of plainport cannot read, so that project waits until it is settled; plainport recover reports it`,
    );
  }
  const journals = read.journals;
  const reused = renamedBack(journals);
  const self = await thisDeviceId(io, paths);
  for (const journal of journals) {
    if (holdsProjectBack(journal)) {
      // One a live plainport on this host is still running (it holds the project's lock) is not interrupted.
      if (!(await operationRunning(io, paths, journal)))
        done.notices.push(
          `the ${journal.kind} ${journal.op} of ${journal.project.address} was interrupted at ${journal.step}; plainport recover finishes or rolls it back`,
        );
      continue;
    }
    if (!released(journal) || reused.has(journal.op)) continue;
    const due = journal.keepUntil === undefined || Date.parse(journal.keepUntil) <= clock().getTime();
    if (!due) continue;
    // Its trash already gone, and no live delete about to close the journal: finished (D67). A write command closes the
    // journal, under the lock; a read command leaves it. Neither says anything.
    if (
      (await finished(io, journal)) &&
      (await claimedReason(io, itemOf(journal).trash, self)) === undefined
    ) {
      if (options.deleteDue) {
        const closed = await withProjectLock(
          { io, paths, clock, log: deps.log },
          { id: journal.project.id, address: journal.project.address },
          async () => {
            const reread = await rereadJournal(io, paths, journal.op);
            if (!reread.ok) return reread;
            const now = reread.value;
            if (now === undefined || !released(now) || !(await finished(io, now))) return ok(undefined);
            if ((await claimedReason(io, itemOf(now).trash, self)) !== undefined) return ok(undefined);
            const guarded = await notAProject(io, paths, deps.env, itemOf(now).trash);
            if (!guarded.ok) return guarded;
            try {
              await removeTrash(io, itemOf(now).trash);
              await removeJournal(io, paths, now.op);
            } catch (error) {
              return writeFailed(error, `closing the journal of ${now.op}`, true, journalFile(paths, now.op));
            }
            return ok(undefined);
          },
          { resume: () => true },
        );
        if (!closed.ok) deps.log("info", `the journal of ${journal.op} is left: ${closed.finding.message}`);
      }
      continue;
    }
    // A due trash that housekeeping does not hand on now, and that no live delete claims (one that crashed before its
    // claim, or could not write it): only gc deletes it, so say so.
    if (!options.deleteDue || journal.keepUntil === undefined) {
      if ((await claimedReason(io, itemOf(journal).trash, self)) === undefined)
        done.notices.push(
          `the trash ${itemOf(journal).trash} of ${journal.project.address}'s offload ${journal.op} is due and nothing is deleting it; plainport gc deletes it`,
        );
      continue;
    }
    const gate = { io, paths, clock, log: deps.log };
    const started = await withProjectLock(
      gate,
      { id: journal.project.id, address: journal.project.address },
      async () => {
        const reread = await rereadJournal(io, paths, journal.op);
        if (!reread.ok) return reread;
        const now = reread.value;
        if (now === undefined || !released(now) || now.keepUntil === undefined) return ok(undefined);
        // An onload may have started renaming the trash back since the journals were first read.
        let current: Journal[];
        try {
          current = (await readJournals(io, paths)).journals;
        } catch (error) {
          return writeFailed(error, `reading the journals in ${paths.journalDir}`, false, paths.journalDir);
        }
        if (renamedBack(current).has(now.op)) return ok(undefined);
        // A trash whose volume is away is not deleted: the detached delete would close the journal over nothing.
        const away = await rootAway(io, now);
        if (away !== undefined) return away;
        // A live deleter's already (D64); a dead one's is taken over by the new detached delete's claim.
        if ((await claimedReason(io, itemOf(now).trash, self)) !== undefined) return ok(undefined);
        // A registered working copy is never deleted as trash (D84).
        const guarded = await notAProject(io, paths, deps.env, itemOf(now).trash);
        if (!guarded.ok) return guarded;
        // Without a deadline the trash is no longer renamed back by an onload (it may be being deleted).
        const { keepUntil: _, ...rest } = now;
        try {
          await writeJournal(io, paths, rest);
        } catch (error) {
          return writeFailed(error, `writing the journal of ${now.op}`, true, journalFile(paths, now.op));
        }
        const item = itemOf(now);
        const detached = await host.deleteTrashDetached(item.trash, journalFile(paths, now.op), self);
        if (!detached.ok) return detached;
        done.started.push(item);
        return ok(undefined);
      },
      { resume: () => true },
    );
    if (!started.ok)
      deps.log(
        "warn",
        `the trash of ${journal.project.address}'s offload ${journal.op} is past its deadline but was not deleted now (${started.finding.message}); plainport gc deletes it`,
      );
  }
  return done;
};
