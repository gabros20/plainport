// The held trash (Q16, Q21; M2 Task 24; DESIGN.md "Offload process" → "Held trash"): a released folder's trash parks at
// offload.release.held, and checkHeld, the one checked read, is the only way out of it to release.delete, the step at
// which every deleter (the detached delete, housekeeping, gc, recover) may delete. It runs under the project's lock,
// from recover, gc and a write command's housekeeping. The state is in the journal alone, in fields v0.1.1 reads (its
// strict schema parses the journal, and its recover, gc and housekeeping leave a step they do not know alone):
//
//   held(grace)     keepUntil set: the checked read waits until then (the commit plus offload.conflictGrace, or a
//                   resolution's fresh deadline)
//   held(conflict)  keepUntil absent: a fork names the snapshot (conflict-retained in views)
//
//   From             Event                                                                To
//   held(grace)      before keepUntil                                                      unchanged
//   held(grace)      the read finds no fork naming the snapshot, and Q21's proof finds     release.delete (keepUntil:
//                    the event and the restic snapshot                                    keepLocalFor's, if ahead)
//   held(grace)      the read finds a fork naming the snapshot                             held(conflict)
//   held(conflict)   the read finds no fork naming it any more: a resolution kept it, or   held(grace), a fresh
//                    rejected it (it stays in the store, restorable)                       deadline (now + grace)
//   any held         the store does not answer, the read is uncertain, Q21's proof finds   unchanged; retried by the
//                    data missing (store.lost-write), or the profile cannot release        next gc or recover
//   any held         onload of the same head with the folder's verified fingerprint       renamed back (onload.ts)
//
// A fork is one the fold's conflicts name with the snapshot, or (the snapshot's own event missing from a store whose
// listings lag) another kept snapshot made from the same base. A rejected snapshot is no live fork: its trash goes
// after the grace, and the snapshot stays restorable with restore --snapshot.

import { basename, dirname } from "node:path";
import { type Finding, fail, failWith, finding, ok, type Result, shellWord } from "@plainport/contract";
import { PLAIN_CATALOG, policyFits, UNOPENED_CODES } from "../catalog/codec.ts";
import { type CatalogRead, catalogReader } from "../catalog/head.ts";
import { identityChanged, readUsableStore } from "../catalog/identity.ts";
import { eventForOp, MIRROR_EVENTS_PREFIX, storeEventLog } from "../catalog/log.ts";
import type { ConfigLoader } from "../config/load.ts";
import { removeEmptyHolder, rmdirIfEmpty } from "../holder.ts";
import { type LocalIo, systemErrorCode } from "../io.ts";
import { type Journal, type OffloadJournal, removeJournal } from "../journal/index.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import type { BlobStore, StoreSemantics } from "../ports/blob-store.ts";
import type { StoreOpener } from "../ports/store.ts";
import { updateRegistry } from "../registry.ts";
import { openSaga, withFix, writeFailed } from "../saga/journaled.ts";
import {
  conflictGraceOf,
  forkAfterCommit,
  heldGrace,
  keepLocalUntil,
  offloadTrashOf,
  releaseRefused,
  TRASH_DIR,
} from "../saga/release.ts";
import { type ConfiguredStore, openStore } from "../store.ts";
import { readStub, STUB_SUFFIX } from "../stub.ts";

/** The step a trash is held at; v0.1.1 does not know it, so a rollback never deletes held trash (Q2). */
export const HELD_STEP = "offload.release.held";

/** Whether a journal holds its trash for the checked read. */
export const isHeld = (journal: Journal): journal is OffloadJournal =>
  journal.kind === "offload" && journal.step === HELD_STEP;

/** Whether a held trash is conflict-retained: a fork named its snapshot at the last checked read. */
export const conflictRetained = (journal: OffloadJournal): boolean =>
  isHeld(journal) && journal.keepUntil === undefined;

/** The pause and crash seam right after a checked read allowed the delete, before the journal moves on (S8, D67). */
export const CHECKED_SEAM = "trash.delete.checked";

/** The journal's own store as the checked read sees it. */
export interface HeldStore {
  name: string;
  /** Its profile: a store that cannot release a folder keeps its trash held (store.semantics-unknown). */
  semantics: StoreSemantics;
  /** offload.conflictGrace for it, in milliseconds: a resolution's fresh deadline. */
  grace: number;
  /** The store's catalog, read fresh (never the mirror alone). */
  read(): Promise<Result<CatalogRead>>;
  /**
   * Q21's proof: the commit's event read again from the store (not the mirror), whole and this operation's, and restic
   * still listing the snapshot it names. store.lost-write when either is missing.
   */
  proof(journal: OffloadJournal): Promise<Result<void>>;
}

export interface HeldContext {
  io: LocalIo;
  paths: PlainportPaths;
  clock(): Date;
  /** The crash and pause seams (the journal's steps and CHECKED_SEAM). */
  faultAt(point: string): void;
  log(level: "debug" | "info" | "warn", message: string): void;
  /** Opens the journal's own store (D45), or says why it cannot now. */
  open(journal: OffloadJournal): Promise<Result<HeldStore>>;
}

export type HeldVerdict =
  /** held(grace): the checked read waits until `until`. */
  | { kind: "grace"; until: string }
  /** held(conflict): a fork names the snapshot, so the trash is conflict-retained. */
  | { kind: "conflict"; finding: Finding }
  /** The read allowed the delete: the journal is now at release.delete, with keepLocalFor's deadline if it is ahead. */
  | { kind: "released"; journal: OffloadJournal };

/** The finding a conflict-retained trash is reported with: why it stays, and the way out. */
export const conflictFinding = (journal: OffloadJournal): Finding => {
  const trash = journal.trash ?? offloadTrashOf(journal);
  const address = journal.project.address;
  return finding("trash.conflict-retained", {
    message: `the trash ${trash} of ${address}'s offload ${journal.op} is kept: a fork names its snapshot ${journal.op} (Q16)`,
    fix: `plainport status ${shellWord(address)} shows both sides; once a resolution settles the fork, plainport onload ${shellWord(address)} renames this folder back when its snapshot is kept, and plainport gc deletes it after the grace otherwise`,
    paths: [trash],
  });
};

/**
 * The checked read (see the file comment), on a journal at offload.release.held, under the project's lock. Ok with
 * where the trash now stands; a failure leaves the journal as it was, for the next gc or recover.
 */
export const checkHeld = async (ctx: HeldContext, journal: OffloadJournal): Promise<Result<HeldVerdict>> => {
  if (journal.step !== HELD_STEP)
    throw new Error(`checkHeld: the offload ${journal.op} is at ${journal.step}`);
  const now = ctx.clock();
  if (journal.keepUntil !== undefined && Date.parse(journal.keepUntil) > now.getTime())
    return ok({ kind: "grace", until: journal.keepUntil });
  const trash = journal.trash ?? offloadTrashOf(journal);
  const kept = `the trash ${trash} is kept, and the next plainport gc or recover checks it again`;
  const store = await ctx.open(journal);
  if (!store.ok) return withFix(store, `${store.finding.fix ?? "connect the store"}; ${kept}`);
  const read = await store.value.read();
  if (!read.ok) return withFix(read, `${read.finding.fix ?? "connect the store"}; ${kept}`);
  const seen = forkAfterCommit(read.value, journal);
  if (!seen.ok) return seen;
  const saga = openSaga<OffloadJournal, string>(
    { kind: "offload", io: ctx.io, paths: ctx.paths, faultAt: ctx.faultAt, clock: ctx.clock, log: ctx.log },
    { ...journal, history: [...journal.history] },
  );
  saga.commit();
  if (seen.value === "forked") {
    // held(conflict): no deadline while the fork stands.
    if (journal.keepUntil !== undefined) {
      const written = await saga.step(HELD_STEP, { keepUntil: undefined });
      if (!written.ok) return written;
    }
    return ok({ kind: "conflict", finding: conflictFinding(journal) });
  }
  // held(conflict) with no fork left: a resolution settled it, so the grace starts again from now.
  if (journal.keepUntil === undefined && store.value.grace > 0) {
    const until = new Date(now.getTime() + store.value.grace).toISOString();
    const written = await saga.step(HELD_STEP, { keepUntil: until });
    if (!written.ok) return written;
    return ok({ kind: "grace", until });
  }
  // Q21: what the commit wrote is still there, read no earlier than the grace after it.
  const proved = await store.value.proof(journal);
  if (!proved.ok) return proved;
  const refused = releaseRefused(store.value.name, store.value.semantics, journal.project.address, trash);
  if (refused !== undefined) return fail(refused);
  ctx.faultAt(CHECKED_SEAM);
  const keepUntil = keepLocalUntil(journal, now);
  const moved = await saga.step("offload.release.delete", { keepUntil });
  if (!moved.ok) return moved;
  return ok({ kind: "released", journal: saga.journal });
};

/** What opening a journal's store needs: recover's, gc's and housekeeping's own dependencies. */
export interface JournalStoreDeps {
  io: LocalIo;
  paths: PlainportPaths;
  env: Env;
  loader: ConfigLoader;
  opener: StoreOpener;
  clock(): Date;
}

/**
 * The store the journal names, as this device set it up: the very store, by its identity (D45), with its format, which
 * keys the `stored` entry of an event written there (Q11). A disk swapped or a path changed since is another store,
 * which nothing reads a commit from or writes to.
 */
export const openJournalStore = async (
  deps: JournalStoreDeps,
  journal: Journal,
): Promise<Result<ConfiguredStore & { format: 1 | 2 }>> => {
  const loaded = await deps.loader.load({ env: deps.env, root: journal.project.root });
  if (!loaded.ok) return loaded;
  const opened = await openStore(deps.io, {
    paths: deps.paths,
    env: deps.env,
    name: journal.store.name,
    config: loaded.value.config,
    opener: deps.opener,
    now: deps.clock,
  });
  if (!opened.ok) return opened;
  // The store itself says who it is (meta/v1/store.json), not this device's record of it.
  const identity = await readUsableStore(opened.value.blob);
  if (!identity.ok) return identity;
  const found = identity.value?.id ?? null;
  if (opened.value.id !== journal.store.id || identity.value === null || found !== journal.store.id) {
    const changed = identityChanged(
      journal.store.id,
      found === journal.store.id ? opened.value.id : found,
      "store",
    );
    return withFix(
      changed,
      `connect the store the ${journal.kind} ${journal.op} wrote to (stores.${journal.store.name}), then run plainport recover`,
    );
  }
  const fits = policyFits(opened.value.catalog ?? PLAIN_CATALOG, identity.value);
  if (!fits.ok) return fits;
  return ok({ ...opened.value, format: identity.value.format });
};

/**
 * HeldContext.open from a command's dependencies: the journal's own store (openJournalStore), its profile (the
 * opener's, from config and this device's measurement, so an owner's assertion counts, D111; the opened store's for a
 * local one), its grace from config, its catalog read fresh, and Q21's proof.
 */
export const heldStoreOpener =
  (
    deps: JournalStoreDeps & {
      openMirror(storeId: string): Promise<Result<BlobStore>>;
      log(level: "debug" | "info" | "warn", message: string): void;
    },
  ) =>
  async (journal: OffloadJournal): Promise<Result<HeldStore>> => {
    const loaded = await deps.loader.load({ env: deps.env, root: journal.project.root });
    if (!loaded.ok) return loaded;
    const store = await openJournalStore(deps, journal);
    if (!store.ok) return store;
    const configured = loaded.value.config.stores[journal.store.name];
    let semantics = store.value.blob.semantics();
    if (configured !== undefined && configured.kind !== "local" && deps.opener.profile !== undefined) {
      const profile = await deps.opener.profile(journal.store.name, configured);
      if (!profile.ok) return profile;
      semantics = profile.value;
    }
    const mirror = await deps.openMirror(store.value.id);
    if (!mirror.ok) return mirror;
    const { blob, engine, catalog } = store.value;
    return ok({
      name: journal.store.name,
      semantics,
      // A store that needs Q21's proof waits at least the floor, a resolution's fresh deadline too (D115).
      grace: heldGrace(conflictGraceOf(loaded.value.config, journal.store.name), {
        name: journal.store.name,
        semantics,
      }).ms,
      read: catalogReader({
        store: blob,
        mirror: mirror.value,
        storeId: store.value.id,
        storeName: store.value.name,
        now: deps.clock,
        ...(catalog === undefined ? {} : { policy: catalog }),
        report: (f) => deps.log("warn", `${f.code}: ${f.message}`),
      }),
      proof: async (held) => {
        const lost = (what: string, absent?: string) =>
          failWith(
            finding("store.lost-write", {
              message: `${what}, so the trash ${held.trash ?? offloadTrashOf(held)} of ${held.project.address} is kept: the store acknowledged the offload ${held.op} but no longer holds all of it (Q21)`,
              fix: `nothing local was deleted: plainport recover puts the folder back at ${held.project.dir} (D115), then offload it again with plainport offload ${shellWord(held.project.address)} --yes; check the store (${journal.store.name}) and its disk`,
              paths: [held.trash ?? offloadTrashOf(held)],
            }),
            // The event the store no longer has, which this device's mirror still holds (put back, it is forgotten).
            absent === undefined ? {} : { absentEvent: absent },
          );
        const id = held.event;
        if (id === undefined || held.verified === undefined) return lost("the journal names no event");
        const there = await eventForOp(
          storeEventLog(blob, catalog),
          id,
          (e) =>
            e.type === "offloaded" &&
            e.op === held.op &&
            e.snapshot === held.op &&
            e.project === held.project.id &&
            Object.values(e.stored).includes(held.verified as string),
        );
        if (!there.ok) return there;
        // An event this policy cannot open may be the operation's own: kept, never judged lost (review r1 I2).
        if (typeof there.value === "object" && UNOPENED_CODES.includes(there.value.code))
          return fail(there.value);
        if (there.value !== "ours")
          return there.value === "absent"
            ? lost(`the offloaded event ${id} is not on the store`, id)
            : lost(`the offloaded event ${id} is not whole`);
        const listed = await engine.list({ tags: ["plainport", `plainport:op=${held.op}`] });
        if (!listed.ok) return listed;
        if (!listed.value.some((s) => s.id === held.verified))
          return lost(`the repository does not list the snapshot ${held.verified}`);
        return ok(undefined);
      },
    });
  };

/**
 * Puts a held trash back (D115): the store lost what the offload wrote (store.lost-write), or cannot be reached for
 * good, so the folder in the trash is the only copy of its work. Under the project's lock, it renames the folder back
 * to its place (path.occupied when something stands there), removes this project's stub, sets the registry's base
 * back to the snapshot the copy came from (so the next offload builds on what the catalog holds, not on the lost
 * snapshot), and closes the journal. Nothing on the store is read or written.
 */
export const putBackHeld = async (
  ctx: Pick<HeldContext, "io" | "paths" | "log">,
  journal: OffloadJournal,
  /** The commit's event the store lost: this device's mirror forgets it too, so no fold here names a lost snapshot. */
  forget?: { mirror: BlobStore; event: string },
): Promise<Result<{ dir: string }>> => {
  if (journal.step !== HELD_STEP)
    throw new Error(`putBackHeld: the offload ${journal.op} is at ${journal.step}`);
  const { io, paths } = ctx;
  const dir = journal.project.dir;
  const holder = journal.trash ?? offloadTrashOf(journal);
  const folder = `${holder}/${basename(dir)}`;
  const kind = async (path: string) => {
    try {
      return (await io.fs.lstat(path)).kind;
    } catch (error) {
      if (systemErrorCode(error) === "ENOENT") return undefined;
      throw error;
    }
  };
  try {
    if ((await kind(dir)) !== undefined)
      return fail(
        finding("path.occupied", {
          message: `${dir} stands where the held trash of ${journal.project.address} would go back, so it was left in ${folder}`,
          fix: `move ${shellWord(dir)} somewhere else, then run plainport recover ${shellWord(journal.project.address)} --restore-held --yes`,
          paths: [dir, folder],
        }),
      );
    if ((await kind(folder)) !== "dir")
      return fail(
        finding("journal.pending", {
          message: `the held trash ${folder} of ${journal.project.address} is not there, so nothing was put back; the journal stays`,
          fix: `look for the folder in ${shellWord(holder)}, then run plainport recover`,
          paths: [folder],
        }),
      );
    await io.fs.rename(folder, dir);
    // Only this project's stub goes; anything else at the stub's path is left alone.
    const stubPath = `${dir}${STUB_SUFFIX}`;
    const stub = await readStub(io, stubPath);
    if (stub.ok && stub.value.project === journal.project.id && stub.value.snapshot === journal.op)
      await io.fs.unlink(stubPath);
  } catch (error) {
    return writeFailed(error, `putting the held trash ${folder} back at ${dir}`, true, dir);
  }
  const based = await updateRegistry(io, paths, (registry) => {
    const entry = registry.projects[journal.project.id];
    if (entry === undefined) return ok(registry);
    const { base: _, onloadedAt: __, ...rest } = entry;
    return ok({
      ...registry,
      projects: {
        ...registry.projects,
        [journal.project.id]: { ...rest, ...(journal.base === undefined ? {} : { base: journal.base }) },
      },
    });
  });
  if (!based.ok) return based;
  if (forget !== undefined) {
    const dropped = await forget.mirror.delete(`${MIRROR_EVENTS_PREFIX}${forget.event}.json`);
    if (!dropped.ok) return dropped;
  }
  await rmdirIfEmpty(io, holder);
  await removeEmptyHolder(io, dirname(holder), TRASH_DIR);
  await removeJournal(io, paths, journal.op);
  ctx.log("warn", `the held trash of ${journal.project.address} was put back at ${dir}; offload it again`);
  return ok({ dir });
};
