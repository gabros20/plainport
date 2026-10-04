// An offload's release (DESIGN.md "Offload process" step 8), the only step that touches the project folder: rename
// it into `<root>/.plainport-trash/<op>/`, write the `.plainport` stub where it stood, record the new base in
// registry.json, then hand the trash to a detached delete (or keep it until keepLocalFor has passed). Everything it
// reads comes from the journal and the committed event, so the live saga and `plainport recover` (Task 14) run the
// same function.
//
// Right before the rename the folder's fingerprint is compared with the verified one (plan.fingerprint): an edit made
// after verification, in the live run's commit window or in the hours before recover runs, is never deleted. Such a
// folder is kept, no stub is written, its base becomes the committed snapshot, and the run ends with
// offload.diverged-after-commit (exit 8, D51, D52). The lock is read before that scan, so the rename follows the
// scan at once. A fingerprint of another kind than this build's (D53) is never compared: the folder is kept.
//
// Each stage checks whether it is done before doing it (the folder at its place or already in the trash, the stub
// placed or ours already, the registry, the detached delete), and a journal step already reached is not written
// again, so recover can call it from any journal step from commit.start on (m1). Each effect is followed by a crash
// seam (saga.after), so the crash matrix reaches the states a lost journal write leaves.

import { basename, dirname, join } from "node:path";
import { fail, failWith, finding, ok, type Result, shellWord } from "@plainport/contract";
import { readDevice } from "../device.ts";
import { type LocalIo, makeInHolder, systemErrorCode } from "../io.ts";
import { journalFile, type OffloadJournal } from "../journal/index.ts";
import type { PlainportPaths } from "../paths.ts";
import type { HostPorts } from "../ports/host.ts";
import { updateRegistry } from "../registry.ts";
import { FINGERPRINT_VERSION } from "../scan/walk.ts";
import { placeStub, STUB_SUFFIX, type Stub, type StubPlacement, StubSchema } from "../stub.ts";
import { type Saga, writeFailed } from "./journaled.ts";
import { unchanged } from "./verify.ts";

export const TRASH_DIR = ".plainport-trash";

/**
 * Removes `<root>/.plainport-trash` once removing the trash folder `trash` left it empty: by rmdir, so it stays as soon
 * as another offload has put its own trash there (offload makes it again). Only plainport's own holder, and it never
 * fails: an empty holder left behind is harmless.
 */
export const removeEmptyTrashHolder = async (io: LocalIo, trash: string): Promise<void> => {
  const holder = dirname(trash);
  if (basename(holder) !== TRASH_DIR) return;
  try {
    await io.fs.rmdir(holder);
  } catch (error) {
    systemErrorCode(error);
  }
};

/** "0", or a whole number with a unit (DurationSchema), in milliseconds. */
export const durationMs = (duration: string): number => {
  const match = /^(\d+)([smhdw])?$/.exec(duration);
  if (match === null) throw new RangeError(`not a duration: ${duration}`);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] ?? "s"] ?? 1_000;
  return Number(match[1]) * unit;
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
  /** The offload's saga, committed: its journal says what to release and how. */
  saga: Saga<OffloadJournal>;
  clock(): Date;
  log(level: "warn", message: string): void;
}

/** Records the released copy's snapshot as the project's base on this device: the next offload builds on it. */
const recordBase = (rc: ReleaseContext, journal: OffloadJournal) =>
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
 * the folder stays. `diverged-after-commit`: the snapshot is committed and is the head, but the folder changed after
 * the commit, so it stays here with its edits and the next offload builds on the snapshot (D52).
 */
export interface OffloadConflict {
  op: string;
  exitCode: 8;
  kind: "fork" | "diverged-after-commit";
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
  "offload.release.delete",
] as const;
type ReleaseStep = (typeof RELEASE_ORDER)[number];

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
  /** keepLocalFor: the trash is kept until then. */
  keepUntil?: string;
  /** The detached delete has started. */
  freed: boolean;
}

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
    if (rc.stillHeld !== undefined && !(await rc.stillHeld())) {
      return fail(
        finding("project.locked", {
          message: `the lock on ${project.address} was taken over by another run before ${folder} was moved; the snapshot is committed and the folder is untouched`,
          fix: "wait for the other plainport run to finish, then run plainport recover to finish this offload",
          paths: [folder],
        }),
      );
    }
    if (journal.plan?.fp !== FINGERPRINT_VERSION) {
      return fail(
        finding("journal.pending", {
          message: `the journal of ${op} holds a folder fingerprint of another kind than this plainport's, so whether ${folder} changed since it was verified cannot be told; it was kept`,
          fix: "finish it with the plainport that wrote the journal (plainport recover), then re-run",
          paths: [folder],
        }),
      );
    }
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
      // The holder another operation may remove once it is empty (removeEmptyTrashHolder): makeInHolder.
      await makeInHolder(io, dirname(trash), () => io.fs.mkdirp(trash));
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

  // Stage 4, the delete: the deadline the journal holds, or one set now; a detached delete started twice is harmless.
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
        ? await io.deleteTrashDetached(trash, journalFile(paths, op), self.value.id)
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
