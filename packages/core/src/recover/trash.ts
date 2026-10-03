// A released offload's trash (DESIGN.md "Offload process" step 8, "CLI design" → gc): the folder waits in
// `<root>/.plainport-trash/<op>/` until the detached delete removes it, or, with keepLocalFor, until its deadline
// (journal at offload.release.delete with keepUntil). Two ways remove a kept trash:
//
// - `plainport gc` (collectTrash): deletes, under the project's lock, every released trash whose deadline has passed
//   (or that has none: its detached delete never ran); `--now` (early) deletes kept ones before their deadline too.
//   A trash an interrupted onload is renaming back (its journal names it as `reuse`) is never deleted.
// - housekeeping at the start of any command (D59): a trash whose deadline has passed gets the detached delete, under
//   the project's lock, after its journal drops keepUntil, so an onload never renames back a folder being deleted.
//   It also says, on stderr, which operations were interrupted and that `plainport recover` settles them; it never
//   replays a journal itself (read commands never write, D45; an onload stopped before its swap is taken over by the
//   next onload).
//
// Only plainport's own trash and journals are deleted, and only for operations whose journal says committed and
// released; nothing else is touched.

import { join } from "node:path";
import { type Failure, type Finding, failWith, ok, type Result } from "@plainport/contract";
import { type LocalIo, systemErrorCode } from "../io.ts";
import {
  type Journal,
  JournalSchema,
  journalFile,
  type OffloadJournal,
  readJournals,
  removeJournal,
  writeJournal,
} from "../journal/index.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import type { HostPorts } from "../ports/host.ts";
import { writeFailed } from "../saga/journaled.ts";
import { holdsProjectBack, withProjectLock } from "../saga/project-gate.ts";
import { offloadTrashOf } from "../saga/release.ts";

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

const reread = async (io: LocalIo, paths: PlainportPaths, op: string): Promise<Journal | undefined> => {
  try {
    const parsed = JournalSchema.safeParse(JSON.parse(await io.fs.readText(journalFile(paths, op))));
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    systemErrorCode(error);
    return undefined;
  }
};

/** Bytes of the files below a folder; what cannot be read counts as nothing. */
const treeBytes = async (io: LocalIo, path: string): Promise<number> => {
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
      if (entry.kind === "dir") await visit(child);
      else {
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
 * Removes a released trash folder, which its own detached delete may be removing at the same moment: a tree that
 * changes under the walk (ENOENT, ENOTEMPTY) is walked again, and a folder that is gone is done.
 */
export const removeTrash = async (io: LocalIo, trash: string): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      await io.fs.removeTree(trash);
      return;
    } catch (error) {
      const code = systemErrorCode(error);
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
      try {
        await io.fs.lstat(trash);
      } catch (gone) {
        if (systemErrorCode(gone) === "ENOENT") return;
        throw gone;
      }
      if (attempt >= 5) throw error;
      await io.proc.sleep(20 * attempt);
    }
  }
};

/** The onload journals renaming a released offload's trash back, by that offload's op. */
const renamedBack = (journals: readonly Journal[]): Map<string, string> => {
  const out = new Map<string, string>();
  for (const j of journals) if (j.kind === "onload" && j.reuse !== undefined) out.set(j.reuse.op, j.op);
  return out;
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
  const report: GcReport = { deleted: [], kept: [], skipped: [], freedBytes: 0 };
  let problem: Failure | undefined;
  for (const journal of read.journals.filter(released)) {
    const item = itemOf(journal);
    const due = journal.keepUntil === undefined || Date.parse(journal.keepUntil) <= clock().getTime();
    if (!due && !options.early) {
      report.kept.push(item);
      continue;
    }
    const gate = { io, paths, clock, log: deps.log };
    const done = await withProjectLock(
      gate,
      { id: journal.project.id, address: journal.project.address },
      async () => {
        // Read again under the lock: an onload may have renamed the folder back, a detached delete finished it.
        const now = await reread(io, paths, journal.op);
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
  if (problem !== undefined) return failWith(problem.finding, report, problem.exitCode);
  return ok(report);
};

export type Housekept = {
  /** Trash past its deadline handed to the detached delete. */
  started: TrashItem[];
  /** One line per interrupted operation: what stopped where, and that plainport recover settles it. */
  notices: string[];
};

/**
 * Housekeeping at the start of any command (D59; see above). It never fails the command: what it cannot do now
 * (a lock held, a journal it cannot rewrite) is left for gc or recover, with a warning in the log.
 */
export const housekeeping = async (deps: TrashDeps): Promise<Housekept> => {
  const { host, paths } = deps;
  const io: LocalIo = host;
  const clock = (): Date => deps.now?.() ?? host.clock.now();
  const done: Housekept = { started: [], notices: [] };
  let journals: Journal[];
  try {
    journals = (await readJournals(io, paths)).journals;
  } catch (error) {
    systemErrorCode(error);
    return done;
  }
  const reused = renamedBack(journals);
  for (const journal of journals) {
    if (holdsProjectBack(journal)) {
      // One a live plainport on this host is still writing is running, not interrupted.
      const running = journal.host === io.proc.hostname() && (await io.proc.isAlive(journal.pid));
      if (!running)
        done.notices.push(
          `the ${journal.kind} ${journal.op} of ${journal.project.address} was interrupted at ${journal.step}; plainport recover finishes or rolls it back`,
        );
      continue;
    }
    if (!released(journal) || journal.keepUntil === undefined) continue;
    if (Date.parse(journal.keepUntil) > clock().getTime() || reused.has(journal.op)) continue;
    const gate = { io, paths, clock, log: deps.log };
    const started = await withProjectLock(
      gate,
      { id: journal.project.id, address: journal.project.address },
      async () => {
        const now = await reread(io, paths, journal.op);
        if (now === undefined || !released(now) || now.keepUntil === undefined) return ok(undefined);
        // Without a deadline the trash is no longer renamed back by an onload (it may be being deleted).
        const { keepUntil: _, ...rest } = now;
        try {
          await writeJournal(io, paths, rest);
        } catch (error) {
          return writeFailed(error, `writing the journal of ${now.op}`, true, journalFile(paths, now.op));
        }
        const item = itemOf(now);
        const detached = await host.deleteTrashDetached(item.trash, journalFile(paths, now.op));
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
