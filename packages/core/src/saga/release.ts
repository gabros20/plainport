// An offload's release (DESIGN.md "Offload process" step 8), the only step that touches the project folder: rename
// it into `<root>/.plainport-trash/<op>/`, write the `.plainport` stub where it stood, record the new base in
// registry.json, then hand the trash to a detached delete (or keep it until keepLocalFor has passed). Everything it
// reads comes from the journal and the committed event, so the live saga and `plainport recover` (Task 14) run the
// same function.
//
// Right before the rename the catalog is read again (Q16, the fork table's F2 in DESIGN.md "Conflict at step 7"): a fork
// that names the committed snapshot, or a resolution that rejected it, keeps the folder where it is with no stub, makes
// the snapshot the copy's base, closes the journal and ends the run with catalog.head-moved (exit 8, kind fork, detail
// after-commit). A store that does not answer moves nothing: the journal stays for recover, which reads it again.
// Once the folder has moved (F3) the rename is never undone and nothing is read again. Then the folder's fingerprint is
// compared with the verified one (plan.fingerprint): an edit made after verification, in the live run's commit window
// or in the hours before recover runs, is never deleted. Such a folder is kept, no stub is written, its base becomes
// the committed snapshot, and the run ends with offload.diverged-after-commit (exit 8, D51, D52). The lock is read
// before that scan, so the rename follows the scan at once. A fingerprint of another kind than this build's (D53) is
// never compared: the folder is kept.
//
// The trash is held (Q16, M2 Task 24; recover/held.ts) when the store's conflict grace is above 0 (a remote store's
// default) or its semantics profile does not admit release without Q21's post-grace proof (DESIGN.md "Remote stores:
// consistency and publication": durability acked-unsynced, or unknown): the journal parks at offload.release.held with
// keepUntil, the grace's deadline from the commit, and no delete starts. Only the checked read (checkHeld) moves it on
// to release.delete. A profile that cannot release at all (durability unknown) holds it too, and the run says why
// (`refused`, store.semantics-unknown); the checked delete keeps refusing until the profile admits release.
//
// Each stage checks whether it is done before doing it (the folder at its place or already in the trash, the stub
// placed or ours already, the registry, the detached delete), and a journal step already reached is not written
// again, so recover can call it from any journal step from commit.start on (m1). Each effect is followed by a crash
// seam (saga.after), so the crash matrix reaches the states a lost journal write leaves.

import { basename, dirname, join } from "node:path";
import { type Finding, fail, failWith, finding, ok, type Result, shellWord } from "@plainport/contract";
import { contested } from "../catalog/fold.ts";
import { type CatalogRead, headUncertain } from "../catalog/head.ts";
import { DEFAULT_CONFLICT_GRACE, type ResolvedConfig } from "../config/schema.ts";
import { readDevice } from "../device.ts";
import { makeInHolder } from "../holder.ts";
import { systemErrorCode } from "../io.ts";
import { journalFile, type OffloadJournal } from "../journal/index.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import { canRelease, describeProperty, type StoreSemantics } from "../ports/blob-store.ts";
import type { HostPorts } from "../ports/host.ts";
import { updateRegistry } from "../registry.ts";
import { FINGERPRINT_VERSION } from "../scan/walk.ts";
import { type ProtectedStore, storeOverlap } from "../store-overlap.ts";
import { placeStub, STUB_SUFFIX, type Stub, type StubPlacement, StubSchema } from "../stub.ts";
import { recordHeldClock } from "./held-clock.ts";
import { type Saga, withFix, writeFailed } from "./journaled.ts";
import { unchanged } from "./verify.ts";

export const TRASH_DIR = ".plainport-trash";

/** "0", or a whole number with a unit (DurationSchema), in milliseconds. */
export const durationMs = (duration: string): number => {
  const match = /^(\d+)([smhdw])?$/.exec(duration);
  if (match === null) throw new RangeError(`not a duration: ${duration}`);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] ?? "s"] ?? 1_000;
  return Number(match[1]) * unit;
};

/**
 * offload.conflictGrace for a store, in milliseconds (Q16): the configured one, or the store kind's default (15 minutes
 * on a remote store, none on a local one).
 */
export const conflictGraceOf = (config: ResolvedConfig, store: string): number =>
  durationMs(
    config.offload.conflictGrace ??
      (config.stores[store]?.kind === "local" || config.stores[store] === undefined
        ? DEFAULT_CONFLICT_GRACE.local
        : DEFAULT_CONFLICT_GRACE.remote),
  );

/**
 * The grace a store that needs Q21's proof gets at least (D115): the proof is taken no earlier than this after the
 * commit, whatever offload.conflictGrace says, since a store that is not durable may lose a write it acknowledged
 * shortly after acknowledging it.
 */
export const PROOF_GRACE_FLOOR_MS = durationMs(DEFAULT_CONFLICT_GRACE.remote);

/** Whether a store's profile admits release only with Q21's post-grace proof (or not at all). */
export const needsProof = (semantics: StoreSemantics | undefined): boolean =>
  semantics !== undefined && !canRelease(semantics).eligible;

/**
 * The grace a held trash waits for (D115): offload.conflictGrace, raised to PROOF_GRACE_FLOOR_MS for a store whose
 * profile needs Q21's proof; `raised` says so when it was lower.
 */
export const heldGrace = (
  grace: number,
  store: { name: string; semantics: StoreSemantics } | undefined,
): { ms: number; raised?: Finding } => {
  if (store === undefined || !needsProof(store.semantics) || grace >= PROOF_GRACE_FLOOR_MS)
    return { ms: grace };
  return {
    ms: PROOF_GRACE_FLOOR_MS,
    raised: finding("offload.grace-raised", {
      message: `offload.conflictGrace is ${grace === 0 ? "0" : `${Math.round(grace / 1000)}s`}, below the ${PROOF_GRACE_FLOOR_MS / 60_000} minutes a store that is not durable needs before Q21's proof, so the trash on ${store.name} is held for ${PROOF_GRACE_FLOOR_MS / 60_000} minutes (D115)`,
      fix: `nothing to do: the floor applies to ${store.name} whatever offload.conflictGrace says; set it to 15m or more to stop this warning`,
    }),
  };
};

/** Where the project's root holds its trash: the root's folder, or the folder's parent for a one-off location. */
export const rootFolderOf = (path: string, dir: string): string =>
  dir.endsWith(`/${path}`) ? dir.slice(0, -(path.length + 1)) : dirname(dir);

/** `<root>/.plainport-trash/<op>`: where release moves the folder, derived from the journal alone (D50). */
export const offloadTrashOf = (journal: Pick<OffloadJournal, "op" | "project">): string =>
  join(rootFolderOf(journal.project.path, journal.project.dir), TRASH_DIR, journal.op);

export interface ReleaseContext {
  host: HostPorts;
  /** Re-checks the project's lock right before the rename (lock.ts's known limit); absent, it is not re-checked. */
  stillHeld?(): Promise<boolean>;
  paths: PlainportPaths;
  /** The caller's environment: the detached delete's guard (D87) reads the configuration and roots with it. */
  env: Env;
  /**
   * Every local store's folder (store-overlap.ts), read from the configuration when asked, right before the rename:
   * the folder, or its copy in the trash, is never moved or deleted while it holds one or lies inside one (D83). A store
   * configured by hand after the plan is caught (F2); a configuration that cannot be read moves nothing.
   */
  stores(): Promise<Result<readonly ProtectedStore[]>>;
  /** The offload's saga, committed: its journal says what to release and how. */
  saga: Saga<OffloadJournal>;
  /**
   * The store's catalog, read fresh right before the rename (F2): a fork naming the snapshot, or a resolution that
   * rejected it, keeps the folder; a failure (a store that does not answer) moves nothing. Absent, nothing is read.
   */
  reread?(): Promise<Result<CatalogRead>>;
  /**
   * The store's semantics profile, and its name in config: a profile that does not admit release without Q21's proof
   * holds the trash. Absent, the profile does not hold it (callers that release past the rename).
   */
  store?: { name: string; semantics: StoreSemantics };
  /** offload.conflictGrace for the journal's store, in milliseconds (conflictGraceOf): above 0, the trash is held. */
  grace?: number;
  clock(): Date;
  log(level: "warn", message: string): void;
}

/**
 * Records the offload's snapshot as the project's base on this device: the next offload builds on it. A released copy
 * takes it, and so does a folder kept as a fork (F1, F2) or with edits after the commit (D51).
 */
export const recordBase = (rc: Pick<ReleaseContext, "host" | "paths">, journal: OffloadJournal) =>
  updateRegistry(rc.host, rc.paths, (registry) => {
    const entry = registry.projects[journal.project.id];
    if (entry === undefined) return ok(registry);
    const { onloadedAt: _, ...rest } = entry;
    return ok({
      ...registry,
      projects: { ...registry.projects, [journal.project.id]: { ...rest, base: journal.op } },
    });
  });

/**
 * The error data of exit 8 (D14). `fork`: the head moved during the upload, so the snapshot is kept as a fork and
 * the folder stays; with `detail: "after-commit"` (Q6) the fork was seen after the commit, before the rename (F2).
 * `diverged-after-commit`: the snapshot is committed and is the head, but the folder changed after the commit, so it
 * stays here with its edits and the next offload builds on the snapshot (D52).
 */
export interface OffloadConflict {
  op: string;
  exitCode: 8;
  kind: "fork" | "diverged-after-commit";
  /** kind fork only: seen after the commit (F2), not at the commit's head check (F1). */
  detail?: "after-commit";
  project: string;
  /** The plainport snapshot id, and this store's restic id for it. */
  snapshot: string;
  store: string;
  stored: string;
}

/** The release steps in order: a journal at one of them has done everything before it. */
const RELEASE_ORDER = [
  "offload.commit.start",
  "offload.committed",
  "offload.release.trash",
  "offload.release.moved",
  "offload.release.stub",
  "offload.release.held",
  "offload.release.delete",
] as const;
type ReleaseStep = (typeof RELEASE_ORDER)[number];

/**
 * What a catalog read after the commit says of the offload's snapshot (F2): `forked` when a fork names it, `rejected`
 * when a resolution rejected it, undefined when neither. The snapshot's own event may be missing from a store whose
 * listings lag: then a kept snapshot made from the same base is the fork. A read that left out an event that may be
 * this project's cannot tell, so it is a failure (catalog.head-uncertain) and nothing moves.
 */
export const forkAfterCommit = (
  read: CatalogRead,
  journal: OffloadJournal,
): Result<"forked" | "rejected" | undefined> => {
  const { project, op } = journal;
  const doubt = headUncertain(read, project.id, [op], project.address, {
    what: "the folder was kept and nothing was moved",
    instead: () => "plainport recover reads the catalog again and finishes the offload once it reads whole",
  });
  if (doubt !== undefined) return fail(doubt.finding);
  const state = read.projects[project.id];
  if (state === undefined) return ok(undefined);
  if (state.rejected.includes(op)) return ok("rejected");
  if (state.conflicts.some((fork) => fork.includes(op)) || contested(state, op)) return ok("forked");
  if (state.snapshots[op] === undefined) {
    const sibling = Object.entries(state.snapshots).some(
      ([snapshot, made]) =>
        snapshot !== op && made.base === journal.base && !state.discarded.includes(snapshot),
    );
    if (sibling) return ok("forked");
  }
  return ok(undefined);
};

/** Whether the release has reached its rename: from there on the folder has moved, and no gate applies (I2). */
export const releaseMoved = (journal: OffloadJournal): boolean =>
  RELEASE_ORDER.indexOf(journal.step as ReleaseStep) >= RELEASE_ORDER.indexOf("offload.release.trash");

const exists = async (rc: ReleaseContext, path: string): Promise<boolean> => {
  try {
    await rc.host.fs.lstat(path);
    return true;
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return false;
    throw error;
  }
};

export interface Released {
  trash: string;
  stub?: string;
  /** keepLocalFor: the trash is kept until then; held, the conflict grace's deadline. */
  keepUntil?: string;
  /** The detached delete has started. */
  freed: boolean;
  /** The trash is held at offload.release.held (Q16): only the checked read deletes it. */
  held?: true;
  /** Held because the store's profile cannot release a folder (durability unknown): why, until it admits release. */
  refused?: Finding;
  /** offload.conflictGrace was below the floor a store that needs Q21's proof gets, so it was raised (D115). */
  graceRaised?: Finding;
}

/**
 * The deadline of the conflict grace: `grace` after the commit (the journal's offload.committed, else now). The checked
 * read is taken no earlier (Q16, Q21).
 */
export const graceDeadline = (journal: OffloadJournal, grace: number, now: Date): string => {
  const committed = journal.history.findLast((h) => h.step === "offload.committed")?.at;
  const from = committed === undefined ? now.getTime() : Math.min(Date.parse(committed), now.getTime());
  return new Date(from + grace).toISOString();
};

/**
 * keepLocalFor's deadline for a trash leaving the hold: `keepLocalFor` after the folder was moved, or none once that
 * has passed (the trash is deleted now).
 */
export const keepLocalUntil = (journal: OffloadJournal, now: Date): string | undefined => {
  const keepMs = durationMs(journal.release?.keepLocalFor ?? "0");
  if (keepMs === 0) return undefined;
  const moved = journal.history.findLast((h) => h.step === "offload.release.moved")?.at;
  const until = (moved === undefined ? now.getTime() : Date.parse(moved)) + keepMs;
  return until > now.getTime() ? new Date(until).toISOString() : undefined;
};

/** store.semantics-unknown for a held trash whose store cannot release a folder: what it lacks, and the way out. */
export const releaseRefused = (
  name: string,
  semantics: StoreSemantics,
  project: string,
  trash: string,
): Finding | undefined => {
  const verdict = canRelease(semantics, { postGraceProof: true });
  if (verdict.eligible) return undefined;
  const lacks = verdict.missing.map((p) => describeProperty(semantics, p)).join("; ");
  // Only what the measurement leaves unknown is the owner's to assert (D111); a measured value stands.
  const assertable = verdict.missing.filter((p) => {
    const held = semantics[p];
    return held === "unknown" || held.value === "unknown";
  });
  const assertion =
    assertable.length === 0
      ? ""
      : `If the store does keep what it acknowledged, assert it in config.toml (${assertable.map((p) => (p === "durability" ? `stores.${name}.semantics.durability = "durable"` : `stores.${name}.semantics.${p}`)).join(", ")}); plainport gc then checks the catalog and deletes it. `;
  return finding("store.semantics-unknown", {
    message: `the trash ${trash} of ${project} is kept: the store ${name} cannot release a folder after an offload (its ${lacks})`,
    fix: `nothing is lost: the snapshot is on the store, and plainport onload ${shellWord(project)} renames the folder back. ${assertion}Otherwise the trash stays held`,
    paths: [trash],
  });
};

/**
 * F2: a fork naming the committed snapshot, or a resolution that rejected it, was seen before the rename. The folder
 * stays where it is with no stub, the snapshot becomes the copy's base, the journal is closed, and the run ends with
 * catalog.head-moved (exit 8, kind fork, detail after-commit).
 */
const keptAsFork = async (rc: ReleaseContext, why: "forked" | "rejected"): Promise<Result<never>> => {
  const { saga } = rc;
  const { project, op } = saga.journal;
  const folder = project.dir;
  // The registry's base must name the fork, or resolve --keep refuses this copy: a write that fails keeps the journal at
  // release.trash with the folder in place, and recover reads the catalog again and writes it.
  const based = await recordBase(rc, saga.journal);
  if (!based.ok) return based;
  await saga.close();
  const data: OffloadConflict = {
    op,
    exitCode: 8,
    kind: "fork",
    detail: "after-commit",
    project: project.address,
    snapshot: op,
    store: saga.journal.store.name,
    stored: saga.journal.verified ?? "",
  };
  return failWith(
    finding("catalog.head-moved", {
      message:
        why === "forked"
          ? `${project.address} forked after its offload was committed as snapshot ${op}: another copy was offloaded from the same snapshot, so ${folder} was kept with no stub; both snapshots are in the store`
          : `another device's resolution of ${project.address} rejected snapshot ${op} after it was committed, so ${folder} was kept with no stub; the snapshot stays in the store`,
      fix:
        why === "forked"
          ? `keep this folder; it is on snapshot ${op}, one side of the fork. plainport status ${shellWord(project.address)} shows both sides, and plainport restore ${shellWord(project.address)} --snapshot <id> --to <path> reads the other side by side`
          : `keep this folder; it is on snapshot ${op}, which the resolution rejected. The next offload (plainport offload ${shellWord(project.address)} --yes) uploads it as live work, which conflicts again`,
      paths: [folder],
    }),
    data,
    8,
  );
};

/**
 * Releases a committed offload, from wherever its journal stands (see above); `event` is its offloaded event (when
 * it was written, the bytes it holds).
 */
export const releaseOffload = async (
  rc: ReleaseContext,
  event: { at: string; bytes: number },
): Promise<Result<Released>> => {
  const { host: io, paths, saga } = rc;
  const journal = saga.journal;
  // Only a committed offload is ever released: the live saga commits after its append, and recover after it found
  // the event on the store or the journal past the commit (Task 12 quality r3).
  if (!saga.committed) throw new Error(`releaseOffload: the offload ${journal.op} is not committed`);
  const { project, op } = journal;
  const policy = journal.release as NonNullable<OffloadJournal["release"]>;
  const folder = project.dir;
  const trash = offloadTrashOf(journal);
  const moved = join(trash, basename(folder));
  const reached = (step: ReleaseStep): boolean =>
    RELEASE_ORDER.indexOf(journal.step as ReleaseStep) >= RELEASE_ORDER.indexOf(step);
  const lockLost = async (): Promise<boolean> => rc.stillHeld !== undefined && !(await rc.stillHeld());
  const locked = () =>
    fail(
      finding("project.locked", {
        message: `the lock on ${project.address} was taken over by another run before ${folder} was moved; the snapshot is committed and the folder is untouched`,
        fix: "wait for the other plainport run to finish, then run plainport recover to finish this offload",
        paths: [folder],
      }),
    );
  /** Journals the step unless the journal is there already. */
  const advance = (step: ReleaseStep, change: Partial<OffloadJournal> = {}): Promise<Result<void>> =>
    reached(step) ? Promise.resolve(ok(undefined)) : saga.step(step, change);

  // Stage 1, the rename: done when the folder is in the trash; when the journal says moved, it was.
  let inTrash: boolean;
  let atDir: boolean;
  try {
    const seenInTrash = await exists(rc, moved);
    inTrash = reached("offload.release.moved") || seenInTrash;
    atDir = await exists(rc, folder);
  } catch (error) {
    return writeFailed(error, `looking for ${folder} and ${moved}`, true, folder);
  }
  // A store inside the folder (or the folder inside a store) would be renamed and deleted with it (D83): nothing
  // moves and no delete starts; the journal stays, and recover asks again once the store is moved.
  if (atDir || inTrash) {
    const stores = await rc.stores();
    if (!stores.ok) return stores;
    const overlap = await storeOverlap(io, rc.paths.home, atDir ? folder : moved, stores.value);
    if (!overlap.ok)
      return fail({
        ...overlap.finding,
        message: `${overlap.finding.message}; the snapshot ${op} is committed and nothing was moved or deleted`,
        fix: `${overlap.finding.fix?.replace(/, then re-run$/, "") ?? "move the store"}, then run plainport recover`,
      });
  }
  // A folder at the project's place after it was moved aside is something else: never released, never stubbed over.
  if (inTrash && atDir) {
    return fail(
      finding("path.occupied", {
        message: `${folder} stands where ${project.address} was, but its offload ${op} already moved the project folder into ${trash}; the snapshot is committed, and neither folder was touched or stubbed`,
        fix: `move ${shellWord(folder)} aside (it is not the offloaded copy), then run plainport recover`,
        paths: [folder, trash],
      }),
    );
  }
  if (!inTrash && !atDir) {
    return fail(
      finding("fs.write-failed", {
        message: `${folder} is neither where it was nor in ${trash}; the snapshot ${op} is committed and nothing is lost`,
        fix: "if you moved the folder, put it back where it was, then run plainport recover",
        paths: [folder, trash],
      }),
    );
  }
  if (atDir) {
    const toTrash = await advance("offload.release.trash", { trash });
    if (!toTrash.ok) return toTrash;
    if (journal.plan?.fp !== FINGERPRINT_VERSION) {
      return fail(
        finding("journal.pending", {
          message: `the journal of ${op} holds a folder fingerprint of another kind than this plainport's, so whether ${folder} changed since it was verified cannot be told; it was kept`,
          fix: "finish it with the plainport that wrote the journal (plainport recover), then re-run",
          paths: [folder],
        }),
      );
    }
    // F2: the catalog read again, right before the rename (Q16). A store that does not answer moves nothing.
    if (rc.reread !== undefined) {
      const read = await rc.reread();
      if (!read.ok)
        return withFix(
          read,
          `nothing was moved: the snapshot ${op} is committed and ${folder} is as it was; plainport recover reads the catalog again and finishes the offload once the store answers`,
        );
      const seen = forkAfterCommit(read.value, journal);
      if (!seen.ok) return seen;
      // The journal is closed only under the lock (lock.ts's known limit), as the folder is moved only under it.
      if (seen.value !== undefined) return (await lockLost()) ? locked() : keptAsFork(rc, seen.value);
    }
    rc.host.faultAt("offload.release.reread");
    if (await lockLost()) return locked();
    // The D51 guard, right before the rename: only the folder as it was verified is ever moved aside.
    const same = await unchanged(
      io.fs,
      folder,
      journal.plan.fingerprint,
      new Set(journal.plan.excluded ?? []),
    );
    if (!same.ok) return same;
    if (!same.value) {
      const based = await recordBase(rc, journal);
      if (!based.ok) rc.log("warn", `registry.json was not updated: ${based.finding.message}`);
      await saga.close();
      const data: OffloadConflict = {
        op,
        exitCode: 8,
        kind: "diverged-after-commit",
        project: project.address,
        snapshot: op,
        store: journal.store.name,
        stored: journal.verified ?? "",
      };
      return failWith(
        finding("offload.diverged-after-commit", {
          message: `${folder} changed after its offload was committed as snapshot ${op}, now the project's head; the folder was kept with its edits and no stub was written`,
          fix: `keep working in the folder; the next offload (plainport offload ${shellWord(project.address)} --yes) builds on snapshot ${op} and takes the edits`,
          paths: [folder],
        }),
        data,
        8,
      );
    }
    try {
      // The holder another operation may remove once it is empty (D72): makeInHolder makes it again.
      const made = await makeInHolder(io, dirname(trash), trash, () => io.fs.mkdirp(trash));
      if (!made.ok)
        return withFix(
          made,
          "plainport recover finishes the release once the other plainport operations in this root have finished",
        );
      // The new folders' own entries, so a power loss cannot orphan the trash (D24).
      await io.fs.syncDir(dirname(trash));
      await io.fs.syncDir(dirname(dirname(trash)));
      await io.fs.rename(folder, moved);
      await io.fs.syncDir(trash);
      await io.fs.syncDir(dirname(folder));
    } catch (error) {
      if (systemErrorCode(error) === "EXDEV") {
        return fail(
          finding("fs.cross-volume", {
            message: `${folder} could not be renamed into ${trash}: it is on another volume; the snapshot is committed`,
            fix: "plainport recover finishes the offload once the folder can be moved",
            paths: [folder],
          }),
        );
      }
      return writeFailed(error, `moving ${folder} into ${trash}`, true, folder);
    }
    saga.after("offload.release.renamed");
  } else if (!reached("offload.release.trash")) {
    // Renamed, but the release.trash write was lost (D24): the journal catches up.
    const toTrash = await saga.step("offload.release.trash", { trash });
    if (!toTrash.ok) return toTrash;
  }
  const movedStep = await advance("offload.release.moved");
  if (!movedStep.ok) return movedStep;

  // Stage 2, the stub: placeStub creates it, or replaces this project's own; a stub step reached means it is there.
  let stubPath: string | undefined;
  if (policy.stub) {
    stubPath = `${folder}${STUB_SUFFIX}`;
    if (!reached("offload.release.stub")) {
      const stub: Stub = StubSchema.parse({
        plainport: 1,
        project: project.id,
        root: project.root,
        rootId: project.rootId,
        path: project.path,
        store: journal.store.name,
        snapshot: op,
        offloadedAt: event.at,
        bytes: event.bytes,
        restore: `plainport onload ${shellWord(project.address)}`,
      });
      let placed: StubPlacement;
      try {
        placed = await placeStub(io, stubPath, stub, op);
      } catch (error) {
        return writeFailed(error, `writing the stub ${stubPath}`, true, stubPath);
      }
      // D47, D48: something else is there, put there after preflight; it is left alone, and recover writes the stub
      // once it is moved.
      if (!placed.placed) {
        return fail(
          finding("path.stub-occupied", {
            message: `${stubPath} appeared during the offload and is not this project's stub${
              placed.aside === undefined ? "" : ` (it waits at ${placed.aside})`
            }; the snapshot is committed and the folder is in ${trash}`,
            fix: `move ${shellWord(stubPath)} somewhere else, then run plainport recover`,
            paths: [stubPath, ...(placed.aside === undefined ? [] : [placed.aside])],
          }),
        );
      }
      saga.after("offload.release.stub-placed");
    }
  }

  // Stage 3, the registry: setting the base again is harmless.
  const updated = await recordBase(rc, journal);
  if (!updated.ok) rc.log("warn", `registry.json was not updated: ${updated.finding.message}`);
  else saga.after("offload.release.registry-updated");
  const stubbed = await advance("offload.release.stub", stubPath === undefined ? {} : { stub: stubPath });
  if (!stubbed.ok) return stubbed;

  // Stage 4, the hold (Q16): with a conflict grace, or a profile that cannot release without Q21's proof, the trash
  // waits at offload.release.held for the checked read (recover/held.ts), and no delete starts here.
  // A journal already at release.delete has left the hold (or never needed it): the delete goes on below.
  // A store that needs Q21's proof is held for at least PROOF_GRACE_FLOOR_MS (D115).
  const { ms: grace, raised } = heldGrace(rc.grace ?? 0, rc.store);
  const atHeld = journal.step === "offload.release.held";
  const proofNeeded = needsProof(rc.store?.semantics);
  if (atHeld || (!reached("offload.release.delete") && (grace > 0 || proofNeeded))) {
    const keepUntil = atHeld ? journal.keepUntil : graceDeadline(journal, grace, rc.clock());
    if (!atHeld) {
      const held = await saga.step("offload.release.held", keepUntil === undefined ? {} : { keepUntil });
      if (!held.ok) return held;
      // The deadline on this boot's uptime too, so a forward step of the clock does not bring it forward (r2 M2).
      if (keepUntil !== undefined)
        await recordHeldClock(io, paths, op, await rc.host.bootSession(), keepUntil, rc.clock());
    }
    const refused =
      rc.store === undefined
        ? undefined
        : releaseRefused(rc.store.name, rc.store.semantics, project.address, trash);
    return ok({
      trash,
      ...(stubPath === undefined ? {} : { stub: stubPath }),
      ...(keepUntil === undefined ? {} : { keepUntil }),
      freed: false,
      held: true,
      ...(refused === undefined ? {} : { refused }),
      ...(raised === undefined || atHeld ? {} : { graceRaised: raised }),
    });
  }

  // Stage 5, the delete: the deadline the journal holds, or one set now; a detached delete started twice is harmless.
  const keepMs = durationMs(policy.keepLocalFor);
  const keepUntil =
    journal.keepUntil ?? (keepMs > 0 ? new Date(rc.clock().getTime() + keepMs).toISOString() : undefined);
  const released = await advance("offload.release.delete", keepUntil === undefined ? {} : { keepUntil });
  if (!released.ok) return released;
  let freed = false;
  if (keepUntil === undefined) {
    // Deletes the trash, then the journal, after this command has returned (D47); recover repeats it if it never runs.
    // The claim it writes first names this device (D64).
    const self = await readDevice(io, paths);
    const started =
      self.ok && self.value !== undefined
        ? await io.deleteTrashDetached(trash, journalFile(paths, op), self.value.id, { paths, env: rc.env })
        : fail(
            finding("device.none", {
              message: "this device's identity could not be read, so its trash cannot be claimed",
              fix: "plainport gc",
            }),
          );
    if (started.ok) {
      freed = true;
      saga.after("offload.release.detached");
    } else
      rc.log(
        "warn",
        `the trash ${trash} is not being deleted yet (${started.finding.message}); plainport recover deletes it`,
      );
  }
  return ok({
    trash,
    ...(stubPath === undefined ? {} : { stub: stubPath }),
    ...(keepUntil === undefined ? {} : { keepUntil }),
    freed,
  });
};
