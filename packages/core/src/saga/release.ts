// An offload's release (DESIGN.md "Offload process" step 8), the only step that touches the project folder: rename
// it into `<root>/.plainport-trash/<op>/`, write the `.plainport` stub where it stood, record the new base in
// registry.json, then hand the trash to a detached delete (or keep it until keepLocalFor has passed). Everything it
// reads comes from the journal and the committed event, so the live saga and `plainport recover` (Task 14) run the
// same function.

import { basename, dirname, join } from "node:path";
import { fail, finding, ok, type Result, shellWord } from "@plainport/contract";
import { systemErrorCode } from "../io.ts";
import { journalFile, type OffloadJournal } from "../journal/index.ts";
import type { PlainportPaths } from "../paths.ts";
import type { HostPorts } from "../ports/host.ts";
import { updateRegistry } from "../registry.ts";
import { placeStub, STUB_SUFFIX, type Stub, type StubPlacement, StubSchema } from "../stub.ts";
import { type Saga, writeFailed } from "./journaled.ts";

export const TRASH_DIR = ".plainport-trash";

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
  paths: PlainportPaths;
  /** The offload's saga, committed: its journal says what to release and how. */
  saga: Saga<OffloadJournal>;
  clock(): Date;
  log(level: "warn", message: string): void;
}

export interface Released {
  trash: string;
  stub?: string;
  /** keepLocalFor: the trash is kept until then. */
  keepUntil?: string;
  /** The detached delete has started. */
  freed: boolean;
}

/** Releases a committed offload; `event` is its offloaded event (when it was written, the bytes it holds). */
export const releaseOffload = async (
  rc: ReleaseContext,
  event: { at: string; bytes: number },
): Promise<Result<Released>> => {
  const { host: io, paths, saga } = rc;
  const journal = saga.journal;
  const { project, op } = journal;
  const policy = journal.release as NonNullable<OffloadJournal["release"]>;
  const folder = project.dir;
  const trash = offloadTrashOf(journal);

  const toTrash = await saga.step("offload.release.trash", { trash });
  if (!toTrash.ok) return toTrash;
  try {
    await io.fs.mkdirp(trash);
    await io.fs.rename(folder, join(trash, basename(folder)));
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
  const moved = await saga.step("offload.release.moved");
  if (!moved.ok) return moved;

  let stubPath: string | undefined;
  if (policy.stub) {
    stubPath = `${folder}${STUB_SUFFIX}`;
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
  }
  const updated = await updateRegistry(io, paths, (registry) => {
    const entry = registry.projects[project.id];
    if (entry === undefined) return ok(registry);
    const { onloadedAt: _, ...rest } = entry;
    return ok({ ...registry, projects: { ...registry.projects, [project.id]: { ...rest, base: op } } });
  });
  if (!updated.ok) rc.log("warn", `registry.json was not updated: ${updated.finding.message}`);
  const stubbed = await saga.step("offload.release.stub", stubPath === undefined ? {} : { stub: stubPath });
  if (!stubbed.ok) return stubbed;

  const keepMs = durationMs(policy.keepLocalFor);
  const keepUntil = keepMs > 0 ? new Date(rc.clock().getTime() + keepMs).toISOString() : undefined;
  const released = await saga.step("offload.release.delete", keepUntil === undefined ? {} : { keepUntil });
  if (!released.ok) return released;
  let freed = false;
  if (keepUntil === undefined) {
    // Deletes the trash, then the journal, after this command has returned (D47); recover repeats it if it never runs.
    const started = await io.deleteTrashDetached(trash, journalFile(paths, op));
    if (started.ok) freed = true;
    else
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
