// plainport recover (ADR-0008, DESIGN.md "Offload process" and "Onload process" → Journal steps, "Edge cases →
// Concurrency and interruption"): every open journal on this device is settled, under its project's lock (and the
// locks of the registered projects nested with it, D53), by the recover tables in saga/offload.ts and saga/onload.ts.
// Before a saga's commit it rolls back: the folder stays as it was, a staging folder goes, the journal goes. After the
// commit it finishes, with the very functions the live sagas end with (releaseOffload, finishOnload). Where a lost
// write (D24) leaves the journal one step behind its effects, the world decides, never the journal's last word:
//
//   offload, up to snapshot.start           roll back
//   offload.snapshot.discarded              write the snapshot-discarded event the store lacks (D28), roll back
//   offload.snapshot.done, offload.verified  search the store for this op's offloaded event (D50): none, roll back;
//                                           the head, journal it as committed and release; forked, keep the folder
//   offload.diverged                        append the fork event the store lacks, keep the folder
//   offload.commit.start                    the event on the store: committed, release; not there: roll back
//   offload.committed .. release.stub       release (releaseOffload: the D51 fingerprint guard, the derived trash)
//   offload.release.delete                  delete the trash once keepUntil, if any, has passed
//   onload, up to onload.verified           roll back (staging removed; the stub stays)
//   onload.swap.start                       swapped (onloadSwapped): finish; otherwise roll back
//   onload.swapped .. onload.committed      finish (finishOnload)
//
// Recovery is idempotent and never deletes a folder on the strength of a write that might be missing: it rolls back
// by removing only plainport's own journal and staging, and finishes a release only once the event is on the store.
// What it cannot settle now (a store that does not answer, a lock a live process holds, a folder in the way) stays
// pending, its journal kept, and the report says why; recover can run again at any time.

import { dirname, join } from "node:path";
import {
  type Failure,
  type Finding,
  fail,
  failWith,
  finding,
  ok,
  type ProjectState,
  type Result,
} from "@plainport/contract";
import { TEMP_SUFFIX } from "../atomic.ts";
import { type CatalogEvent, OffloadedEventSchema } from "../catalog/events.ts";
import { foldCatalog } from "../catalog/fold.ts";
import { identityChanged, readStoreIdentity } from "../catalog/identity.ts";
import {
  appendEvent,
  eventAt,
  MIRROR_EVENTS_PREFIX,
  readEvents,
  STORE_EVENTS_PREFIX,
  storeEventLog,
} from "../catalog/log.ts";
import type { ConfigLoader } from "../config/load.ts";
import type { Device } from "../device.ts";
import { type LocalIo, systemErrorCode } from "../io.ts";
import {
  type Journal,
  JournalSchema,
  journalFile,
  type OffloadJournal,
  type OnloadJournal,
  readJournals,
  removeJournal,
} from "../journal/index.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { HostPorts } from "../ports/host.ts";
import type { StoreOpener } from "../ports/store.ts";
import { openSaga, withFix, writeFailed } from "../saga/journaled.ts";
import { OFFLOAD_STEPS, type OffloadStep } from "../saga/offload.ts";
import { finishOnload, ONLOAD_STEPS, type OnloadStep, onloadSwapped } from "../saga/onload.ts";
import {
  nestedProjects,
  type ProjectLock,
  registeredFolders,
  withProjectLock,
} from "../saga/project-gate.ts";
import { type OffloadConflict, offloadTrashOf, releaseOffload, rootFolderOf } from "../saga/release.ts";
import { kindAt } from "../saga/restore-tree.ts";
import { type ConfiguredStore, openStore } from "../store.ts";
import { STUB_SUFFIX } from "../stub.ts";
import { removeTrash } from "./trash.ts";

/**
 * What recover did with one operation. rolled-back: it had not committed, and nothing local changed. finished: the
 * release, or the onload, is done. forked: the offload's snapshot is kept as a fork and the folder stays (conflicted).
 * diverged-after-commit: committed, but the folder changed since, so it was kept (D51). trash-deleted, trash-kept: a
 * released offload's trash is gone, or waits for its keepLocalFor deadline. pending: not settled now (the finding
 * says why); its journal stays for the next recover.
 */
export const RECOVERY_OUTCOMES = [
  "rolled-back",
  "finished",
  "forked",
  "diverged-after-commit",
  "trash-deleted",
  "trash-kept",
  "pending",
] as const;
export type RecoveryOutcome = (typeof RECOVERY_OUTCOMES)[number];

export interface RecoverDeps {
  host: HostPorts;
  paths: PlainportPaths;
  /** This device: the events recover appends are its own. */
  device: Device;
  env: Env;
  loader: ConfigLoader;
  opener: StoreOpener;
  /** This device's event mirror for the store with this id, where an event is read when the store cannot be. */
  openMirror(storeId: string): Promise<Result<BlobStore>>;
  log(level: "debug" | "info" | "warn", message: string): void;
  /** The command's clock (keepLocalFor deadlines, events); the host's when absent. */
  now?: () => Date;
}

export type RecoveredOperation = {
  op: string;
  kind: "offload" | "onload";
  /** root:path. */
  project: string;
  projectId: string;
  /** The journal step recover found. */
  step: string;
  outcome: RecoveryOutcome;
  /** The project's state on this device afterwards. */
  state: ProjectState;
  /** The snapshot the operation made (offload) or restored (onload). */
  snapshot: string;
  /** A released offload's trash. */
  trash?: string;
  /** trash-kept: the trash is deleted after this. */
  keepUntil?: string;
  /** Why it is pending, or diverged-after-commit's finding. */
  finding?: Finding;
  /** diverged-after-commit: exit 8's data, as offload gives it (D52). */
  conflict?: Pick<OffloadConflict, keyof OffloadConflict>;
};

export type RecoveryReport = {
  operations: RecoveredOperation[];
  /** Journal files this version cannot read: never touched. */
  unreadable: string[];
};

const BEFORE_SNAPSHOT: ReadonlySet<string> = new Set<OffloadStep>([
  "offload.begin",
  "offload.preflight.done",
  "offload.scan.done",
  "offload.strip.done",
  "offload.planned",
  "offload.snapshot.start",
]);
const RELEASING: ReadonlySet<string> = new Set<OffloadStep>([
  "offload.committed",
  "offload.release.trash",
  "offload.release.moved",
  "offload.release.stub",
]);
const ONLOAD_BEFORE_SWAP: ReadonlySet<string> = new Set<OnloadStep>(
  ONLOAD_STEPS.slice(0, ONLOAD_STEPS.indexOf("onload.swap.start")),
);

/** One operation's settlement, and the failure behind it when it is not settled (its exit code). */
type Settled = { op: RecoveredOperation; problem?: Failure };

/** Settles every open journal on this device (see the file comment). */
export const recover = async (deps: RecoverDeps): Promise<Result<RecoveryReport>> => {
  const { host, paths } = deps;
  const io: LocalIo = host;
  const clock = (): Date => deps.now?.() ?? host.clock.now();
  let read: Awaited<ReturnType<typeof readJournals>>;
  try {
    read = await readJournals(io, paths);
  } catch (error) {
    return writeFailed(error, `reading the journals in ${paths.journalDir}`, false, paths.journalDir);
  }

  // One project at a time, under its lock; its onloads before a released offload's trash, which an onload may be
  // renaming back (finishOnload then clears that offload's journal).
  const byProject = new Map<string, Journal[]>();
  for (const journal of read.journals) {
    const group = byProject.get(journal.project.id) ?? [];
    group.push(journal);
    byProject.set(journal.project.id, group);
  }
  const settled: Settled[] = [];
  for (const group of byProject.values()) {
    const ordered = [
      ...group.filter((j) => j.step !== "offload.release.delete"),
      ...group.filter((j) => j.step === "offload.release.delete"),
    ];
    settled.push(...(await settleProject(ordered)));
  }

  const report: RecoveryReport = { operations: settled.map((s) => s.op), unreadable: read.unreadable };
  if (read.unreadable.length > 0) {
    return failWith(
      finding("journal.pending", {
        message: `${read.unreadable.join(", ")} ${read.unreadable.length === 1 ? "is a journal" : "are journals"} this version of plainport cannot read; ${read.unreadable.length === 1 ? "it was" : "they were"} left as ${read.unreadable.length === 1 ? "it is" : "they are"}`,
        fix: "run the plainport that wrote it (plainport recover), or plainport doctor",
        paths: read.unreadable,
      }),
      report,
    );
  }
  const problem = settled.find((s) => s.problem !== undefined)?.problem;
  if (problem !== undefined) return failWith(problem.finding, report, problem.exitCode);
  return ok(report);

  /** A project's journals, oldest first, under its lock and its nested projects' (D53). */
  async function settleProject(journals: Journal[]): Promise<Settled[]> {
    const first = journals[0] as Journal;
    const project = { id: first.project.id, address: first.project.address };
    const unsettled = (problem: Failure): Settled[] => journals.map((j) => pending(j, problem));
    const folders = await registeredFolders(io, paths, deps.env);
    if (!folders.ok) return unsettled(folders);
    const related = await nestedProjects(io, paths, folders.value, {
      id: project.id,
      folder: first.project.dir,
    });
    if (!related.ok) return unsettled(related);
    const gate = { io, paths, clock, log: deps.log };
    const done = await withProjectLock(
      gate,
      project,
      async (lock) => {
        const out: Settled[] = [];
        for (const journal of journals) {
          // Read again under the lock: a detached delete or the onload before it may have closed it since.
          const now = await reread(journal.op);
          if (now === undefined) continue;
          // The step found: settling moves the journal on.
          const found = now.step;
          const result = now.kind === "offload" ? await settleOffload(now, lock) : await settleOnload(now);
          result.op.step = found;
          await removeTemporaries(now.op);
          deps.log(
            result.problem === undefined ? "info" : "warn",
            `${now.kind} ${now.op} of ${now.project.address} at ${found}: ${result.op.outcome}${
              result.problem === undefined
                ? ""
                : ` (${result.problem.finding.code}: ${result.problem.finding.message})`
            }`,
          );
          out.push(result);
        }
        return ok(out);
      },
      { related: related.value, resume: () => true },
    );
    return done.ok ? done.value : unsettled(done);
  }

  /**
   * A journal write a kill cut short leaves `<op>.json.<pid>.<hex>.tmp` (atomic.ts); under the project's lock nobody
   * else writes this operation's journal, so they are removed, as locked-file.ts removes its own.
   */
  async function removeTemporaries(op: string): Promise<void> {
    const prefix = `${op}.json.`;
    let names: string[];
    try {
      names = await io.fs.readdir(paths.journalDir);
    } catch (error) {
      systemErrorCode(error);
      return;
    }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(TEMP_SUFFIX)) continue;
      if (!/^\d+\.[0-9a-f]+$/.test(name.slice(prefix.length, -TEMP_SUFFIX.length))) continue;
      try {
        await io.fs.unlink(join(paths.journalDir, name));
      } catch (error) {
        systemErrorCode(error);
      }
    }
  }

  async function reread(op: string): Promise<Journal | undefined> {
    try {
      const parsed = JournalSchema.safeParse(JSON.parse(await io.fs.readText(journalFile(paths, op))));
      return parsed.success ? parsed.data : undefined;
    } catch (error) {
      if (error instanceof SyntaxError) return undefined;
      systemErrorCode(error);
      return undefined;
    }
  }

  function entry(journal: Journal, outcome: RecoveryOutcome, state: ProjectState): RecoveredOperation {
    return {
      op: journal.op,
      kind: journal.kind,
      project: journal.project.address,
      projectId: journal.project.id,
      step: journal.step,
      outcome,
      state,
      snapshot: journal.kind === "offload" ? journal.op : journal.snapshot,
    };
  }

  function pending(journal: Journal, problem: Failure, state?: ProjectState): Settled {
    return {
      op: {
        ...entry(journal, "pending", state ?? (journal.kind === "offload" ? "offloading" : "onloading")),
        finding: problem.finding,
      },
      problem,
    };
  }

  /** The store the journal names, as this device set it up: the very store, by its identity (D45). */
  async function storeOf(journal: Journal): Promise<Result<ConfiguredStore>> {
    const loaded = await deps.loader.load({ env: deps.env, root: journal.project.root });
    if (!loaded.ok) return loaded;
    const opened = await openStore(io, {
      paths,
      env: deps.env,
      name: journal.store.name,
      config: loaded.value.config,
      opener: deps.opener,
    });
    if (!opened.ok) return opened;
    // The store itself says who it is (meta/v1/store.json), not this device's record of it: a disk swapped or a path
    // changed since is another store, which recover never writes to or reads a commit from.
    const identity = await readStoreIdentity(opened.value.blob);
    if (!identity.ok) return identity;
    if (opened.value.id !== journal.store.id || identity.value !== journal.store.id) {
      const changed = identityChanged(
        journal.store.id,
        identity.value === journal.store.id ? opened.value.id : identity.value,
        "store",
      );
      return withFix(
        changed,
        `connect the store the ${journal.kind} ${journal.op} wrote to (stores.${journal.store.name}), then run plainport recover`,
      );
    }
    return opened;
  }

  /**
   * What the store holds under an event id: "absent", "ours" only when the file parses, validates and is the event
   * the journal names (`ours`), else the finding that says why it is not: a torn write (D42) or another event is never
   * taken for a commit. A failure when the store cannot say.
   */
  async function eventState(
    store: BlobStore,
    id: string,
    ours: (event: CatalogEvent) => boolean,
  ): Promise<Result<"absent" | "ours" | Finding>> {
    const found = await eventAt(storeEventLog(store), id);
    if (!found.ok) return found;
    if (found.value === null) return ok("absent");
    if ("skipped" in found.value) return ok(found.value.skipped);
    if (ours(found.value.event)) return ok("ours");
    return ok(
      finding("catalog.event-skipped", {
        message: `${STORE_EVENTS_PREFIX}${id}.json is another operation's event, not the one this journal names; it is left as it is`,
      }),
    );
  }

  /** The project's root folder: when it is not there (an unmounted volume), nothing of the operation can be settled. */
  function rootOf(journal: Journal): string {
    if (journal.kind === "offload") return rootFolderOf(journal.project.path, journal.project.dir);
    if (journal.staging !== undefined) return dirname(dirname(journal.staging));
    if (journal.reuse !== undefined) return dirname(dirname(dirname(journal.reuse.folder)));
    return dirname(journal.project.dir);
  }

  async function unavailable(journal: Journal): Promise<Settled | undefined> {
    const root = rootOf(journal);
    let kind: string | undefined;
    try {
      kind = await kindAt(io, root);
    } catch (error) {
      systemErrorCode(error);
    }
    if (kind === "dir") return undefined;
    return pending(
      journal,
      fail(
        finding("root.path-missing", {
          message: `${root}, which holds ${journal.project.address}, is not there (a volume that is not mounted?), so the ${journal.kind} ${journal.op} was left as it is with its journal`,
          fix: "mount the volume, then run plainport recover",
          paths: [root],
        }),
      ),
      "unavailable",
    );
  }

  function unknownStep(journal: Journal): Settled {
    return pending(
      journal,
      fail(
        finding("journal.pending", {
          message: `the ${journal.kind} ${journal.op} of ${journal.project.address} stopped at ${journal.step}, a step this version of plainport does not know; it was left as it is`,
          fix: "run the plainport that wrote it (plainport recover)",
          paths: [journalFile(paths, journal.op)],
        }),
      ),
    );
  }

  /** Rolls back an operation that did not commit: only its staging folder and its journal go. */
  async function rollBack(journal: Journal, note?: Finding): Promise<Settled> {
    try {
      if (journal.kind === "onload" && journal.staging !== undefined) await io.fs.removeTree(journal.staging);
      await removeJournal(io, paths, journal.op);
    } catch (error) {
      return pending(
        journal,
        writeFailed(
          error,
          `rolling back the ${journal.kind} ${journal.op}`,
          false,
          journalFile(paths, journal.op),
        ),
      );
    }
    return {
      op: {
        ...entry(journal, "rolled-back", journal.kind === "offload" ? "local" : "shelved"),
        ...(note === undefined ? {} : { finding: note }),
      },
    };
  }

  async function settleOffload(journal: OffloadJournal, lock: ProjectLock): Promise<Settled> {
    const step = journal.step;
    if (!(OFFLOAD_STEPS as readonly string[]).includes(step)) return unknownStep(journal);
    if (BEFORE_SNAPSHOT.has(step)) return rollBack(journal);
    // From here recover may touch the folder or its trash: never while their volume is away.
    if (step !== "offload.snapshot.discarded") {
      const away = await unavailable(journal);
      if (away !== undefined) return away;
    }
    if (step === "offload.release.delete") return deleteTrash(journal);
    if (RELEASING.has(step)) return release(journal, lock);

    const store = await storeOf(journal);
    if (!store.ok) return pending(journal, store);
    const blob = store.value.blob;

    if (step === "offload.snapshot.discarded") {
      const discarded = journal.discarded;
      if (discarded !== undefined) {
        const there = await eventState(
          blob,
          discarded.event,
          (e) => e.type === "snapshot-discarded" && e.op === journal.op && e.snapshot === journal.op,
        );
        if (!there.ok) return pending(journal, there);
        // A torn or foreign file under its id stays as it is: the snapshot no event names is never a head (D28).
        if (typeof there.value === "object") return rollBack(journal, there.value);
        if (there.value === "absent") {
          const written = await appendEvent(storeEventLog(blob), {
            v: 1,
            id: discarded.event,
            type: "snapshot-discarded",
            device: deps.device.id,
            at: clock().toISOString(),
            op: journal.op,
            project: journal.project.id,
            root: journal.project.rootId,
            path: journal.project.path,
            snapshot: journal.op,
            stored: { [journal.store.name]: discarded.snapshot },
          });
          if (!written.ok) return pending(journal, written);
        }
      }
      return rollBack(journal);
    }

    if (step === "offload.diverged") return keepFork(journal, store.value);

    if (step === "offload.commit.start") {
      const there =
        journal.event === undefined
          ? ok("absent" as const)
          : await eventState(
              blob,
              journal.event,
              (e) =>
                e.type === "offloaded" &&
                e.op === journal.op &&
                e.snapshot === journal.op &&
                e.project === journal.project.id &&
                (journal.verified === undefined || e.stored[journal.store.name] === journal.verified),
            );
      if (!there.ok) return pending(journal, there);
      // Never appended: nothing was committed, and the folder was never touched (D24).
      if (there.value === "absent") return rollBack(journal);
      // A torn or foreign file is no commit (D41, D42): the folder stays, and the report says why.
      if (there.value !== "ours") return rollBack(journal, there.value);
      return committed(journal, lock, {});
    }

    // snapshot.done, verified: the write after them may be the one a power loss dropped (D50).
    const events = await readEvents(storeEventLog(blob));
    if (!events.ok) return pending(journal, events);
    const made = events.value.events.find(
      (e): e is Extract<CatalogEvent, { type: "offloaded" }> =>
        e.type === "offloaded" &&
        e.op === journal.op &&
        e.project === journal.project.id &&
        journal.attempts.includes(e.stored[journal.store.name] ?? ""),
    );
    if (made === undefined) return rollBack(journal);
    const head = foldCatalog(events.value.events).projects[journal.project.id]?.head;
    if (head !== journal.op) {
      // Forked: the event keeps the snapshot as a fork, as offload.diverged does, and the folder stays.
      const closed = await close(journal);
      return closed ?? { op: entry(journal, "forked", "conflicted") };
    }
    return committed(journal, lock, { event: made.id, verified: made.stored[journal.store.name] as string });
  }

  /** The event is on the store: the journal says committed, then release goes on. */
  async function committed(
    journal: OffloadJournal,
    lock: ProjectLock,
    change: Partial<OffloadJournal>,
  ): Promise<Settled> {
    const saga = openSaga<OffloadJournal, OffloadStep>(sagaContext("offload"), journal);
    const written = await saga.step("offload.committed", change);
    if (!written.ok) return pending(journal, written);
    return release(saga.journal, lock);
  }

  function sagaContext(kind: "offload" | "onload") {
    return { kind, io, paths, faultAt: (point: string) => host.faultAt(point), clock, log: deps.log };
  }

  /** The offloaded event's time and bytes, for the stub: from the mirror, else the store. */
  async function eventFacts(journal: OffloadJournal): Promise<Result<{ at: string; bytes: number }>> {
    const id = journal.event as string;
    const parse = (bytes: Uint8Array | null) => {
      if (bytes === null) return undefined;
      try {
        const parsed = OffloadedEventSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
        return parsed.success ? { at: parsed.data.at, bytes: parsed.data.stats.bytes } : undefined;
      } catch {
        return undefined;
      }
    };
    const mirror = await deps.openMirror(journal.store.id);
    if (mirror.ok) {
      const got = await mirror.value.get(`${MIRROR_EVENTS_PREFIX}${id}.json`);
      const facts = got.ok ? parse(got.value) : undefined;
      if (facts !== undefined) return ok(facts);
    }
    const store = await storeOf(journal);
    if (!store.ok) return store;
    const got = await store.value.blob.get(`${STORE_EVENTS_PREFIX}${id}.json`);
    if (!got.ok) return got;
    const facts = parse(got.value);
    if (facts !== undefined) return ok(facts);
    return fail(
      finding("store.failed", {
        message: `the offloaded event ${id} of ${journal.project.address} is not readable on store ${journal.store.name}; the folder was not touched`,
        fix: "check the store (plainport doctor), then run plainport recover",
      }),
    );
  }

  /** Finishes a committed offload's release, as the live saga does (releaseOffload, D51). */
  async function release(journal: OffloadJournal, lock: ProjectLock): Promise<Settled> {
    const needsStub = journal.release?.stub === true && journal.step !== "offload.release.stub";
    let facts = { at: journal.updatedAt, bytes: 0 };
    if (needsStub) {
      const read = await eventFacts(journal);
      if (!read.ok) return pending(journal, read);
      facts = read.value;
    }
    const saga = openSaga<OffloadJournal, OffloadStep>(sagaContext("offload"), journal);
    // The journal is past the commit, or the event was found on the store: committed either way.
    saga.commit();
    const released = await releaseOffload(
      { host, paths, saga, clock, log: deps.log, stillHeld: lock.stillHeld },
      facts,
    );
    if (released.ok) {
      return {
        op: {
          ...entry(journal, "finished", "shelved"),
          trash: released.value.trash,
          ...(released.value.keepUntil === undefined ? {} : { keepUntil: released.value.keepUntil }),
        },
      };
    }
    if (released.finding.code === "offload.diverged-after-commit") {
      return {
        op: {
          ...entry(journal, "diverged-after-commit", "local"),
          finding: released.finding,
          conflict: released.data as OffloadConflict,
        },
        problem: released,
      };
    }
    return pending(journal, released);
  }

  /** offload.diverged: the fork event the store lacks is appended, the folder stays, the journal goes. */
  async function keepFork(journal: OffloadJournal, store: ConfiguredStore): Promise<Settled> {
    const id = journal.event;
    const verified = journal.verified;
    if (id !== undefined && verified !== undefined) {
      const there = await eventState(
        store.blob,
        id,
        (e) => e.type === "offloaded" && e.op === journal.op && e.snapshot === journal.op,
      );
      if (!there.ok) return pending(journal, there);
      if (typeof there.value === "object") {
        // A torn fork event: the catalog skips it, so nothing records the fork; the folder stays local.
        const closed = await close(journal);
        return closed ?? { op: { ...entry(journal, "rolled-back", "local"), finding: there.value } };
      }
      if (there.value === "absent") {
        // The journal does not hold the event's totals: they are read again from the snapshot's listing. What was
        // stripped is not known any more, so the event records none.
        let files = 0;
        let bytes = 0;
        const listed = await store.engine.entries(
          verified,
          (e) => {
            if (e.type === "file") {
              files++;
              bytes += e.size ?? 0;
            }
          },
          { op: journal.op, emit: () => {} },
        );
        if (!listed.ok) return pending(journal, listed);
        let rootMode: number | undefined;
        try {
          rootMode = (await io.fs.lstat(journal.project.dir)).mode;
        } catch (error) {
          systemErrorCode(error);
        }
        const appended = await appendEvent(storeEventLog(store.blob), {
          v: 1,
          id,
          type: "offloaded",
          device: deps.device.id,
          at: clock().toISOString(),
          op: journal.op,
          project: journal.project.id,
          root: journal.project.rootId,
          path: journal.project.path,
          ...(journal.base === undefined ? {} : { base: journal.base }),
          snapshot: journal.op,
          stored: { [journal.store.name]: verified },
          ...(rootMode === undefined ? {} : { rootMode }),
          stats: { files, bytes, strippedBytes: 0, ecosystems: [] },
        });
        if (!appended.ok) return pending(journal, appended);
      }
    }
    const closed = await close(journal);
    return closed ?? { op: entry(journal, "forked", "conflicted") };
  }

  async function close(journal: Journal): Promise<Settled | undefined> {
    try {
      await removeJournal(io, paths, journal.op);
      return undefined;
    } catch (error) {
      return pending(
        journal,
        writeFailed(error, `removing the journal of ${journal.op}`, true, journalFile(paths, journal.op)),
      );
    }
  }

  /** A released offload: its trash goes once keepUntil (if any) has passed. */
  async function deleteTrash(journal: OffloadJournal): Promise<Settled> {
    const trash = journal.trash ?? offloadTrashOf(journal);
    // The project may be back since (an onload does not wait for the trash): its state is what stands now.
    let state: ProjectState = "shelved";
    try {
      const here =
        (await kindAt(io, journal.project.dir)) === "dir" &&
        (await kindAt(io, `${journal.project.dir}${STUB_SUFFIX}`)) === undefined;
      if (here) state = "local";
    } catch (error) {
      systemErrorCode(error);
    }
    if (journal.keepUntil !== undefined && Date.parse(journal.keepUntil) > clock().getTime()) {
      return { op: { ...entry(journal, "trash-kept", state), trash, keepUntil: journal.keepUntil } };
    }
    try {
      await removeTrash(io, trash);
      await removeJournal(io, paths, journal.op);
    } catch (error) {
      return pending(journal, writeFailed(error, `deleting the trash ${trash}`, true, trash));
    }
    return { op: { ...entry(journal, "trash-deleted", state), trash } };
  }

  async function settleOnload(journal: OnloadJournal): Promise<Settled> {
    if (!(ONLOAD_STEPS as readonly string[]).includes(journal.step)) return unknownStep(journal);
    const away = await unavailable(journal);
    if (away !== undefined) return away;
    if (ONLOAD_BEFORE_SWAP.has(journal.step)) return rollBack(journal);
    if (journal.step === "onload.swap.start") {
      let swapped: boolean;
      try {
        swapped = await onloadSwapped(io, journal);
      } catch (error) {
        return pending(
          journal,
          writeFailed(error, `looking for ${journal.project.dir}`, false, journal.project.dir),
        );
      }
      if (!swapped) return rollBack(journal);
    }
    const store = await storeOf(journal);
    if (!store.ok) return pending(journal, store);
    const saga = openSaga<OnloadJournal, OnloadStep>(sagaContext("onload"), journal);
    const finished = await finishOnload({
      host,
      paths,
      saga,
      store: store.value.blob,
      device: deps.device.id,
      clock,
      log: deps.log,
    });
    if (!finished.ok) return pending(journal, finished);
    return {
      op: entry(journal, "finished", journal.reuse === undefined ? "restored-unhydrated" : "local"),
    };
  }
};
