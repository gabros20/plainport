// Restoring a snapshot into a staging folder and checking it (DESIGN.md "Onload process" steps 2 to 4): the parts
// onload's saga and `plainport restore` (D58) share. checkSnapshot reads the snapshot's listing once, before anything
// is written, for its totals, for names a case-insensitive volume would fold together (fs.case-collision) and for the
// space the restore needs (fs.no-space); restoreVerified restores into the staging folder and compares the staged tree
// with the listing (verify.mismatch). Neither swaps anything into place: the caller renames the staging folder.

import { join } from "node:path";
import { type Failure, fail, finding, ok, type Phase, type Result, shellWord } from "@plainport/contract";
import { CatalogEventSchema } from "../catalog/events.ts";
import { STORE_EVENTS_PREFIX } from "../catalog/log.ts";
import { assertSystemError, type LocalIo, systemErrorCode } from "../io.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { Engine, RunContext } from "../ports/engine.ts";
import { scanTree } from "../scan/walk.ts";
import { writeFailed } from "./journaled.ts";
import { verifyListing } from "./verify.ts";

/** What is at the path itself: its kind, or undefined when nothing is. */
export const kindAt = async (io: LocalIo, path: string): Promise<string | undefined> => {
  try {
    return (await io.fs.lstat(path)).kind;
  } catch (error) {
    const code = systemErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
};

export const unreadable = (path: string, error: unknown, what: string): Failure =>
  fail(
    finding("fs.unreadable", {
      message: `${path} cannot be inspected (${systemErrorCode(error)}), so ${what}`,
      fix: `check that you can read ${shellWord(path)} and the folder that holds it, then re-run`,
      paths: [path],
    }),
  );

/** The event that made a snapshot (offloaded or checkpointed), read from the store; undefined when unreadable. */
export const producedBy = async (store: BlobStore, event: string) => {
  const got = await store.get(`${STORE_EVENTS_PREFIX}${event}.json`);
  if (!got.ok || got.value === null) return undefined;
  try {
    const parsed = CatalogEventSchema.safeParse(JSON.parse(new TextDecoder().decode(got.value)));
    // Unreadable here, as the fold would skip it: nothing is counted.
    return parsed.success && (parsed.data.type === "offloaded" || parsed.data.type === "checkpointed")
      ? parsed.data
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether the volume holding `folder` ignores case: a probe file made there is looked up with its name upper-cased.
 * The folder is plainport's own staging holder, so a probe a crash leaves behind is in a folder recover owns.
 * (roots/canonical.ts probes a path's own name in its parent, which at a mount point is the volume around it.)
 */
const ignoresCase = async (io: LocalIo, folder: string, op: string): Promise<Result<boolean>> => {
  const probe = join(folder, `.plainport-case-${op.toLowerCase()}`);
  try {
    await io.fs.writeBytesDurable(probe, new Uint8Array(), { exclusive: true });
  } catch (error) {
    return unreadable(folder, error, "whether its volume ignores case is unknown; nothing was restored");
  }
  try {
    return ok((await kindAt(io, join(folder, `.PLAINPORT-CASE-${op.toUpperCase()}`))) !== undefined);
  } catch (error) {
    return unreadable(folder, error, "whether its volume ignores case is unknown; nothing was restored");
  } finally {
    try {
      await io.fs.unlink(probe);
    } catch (error) {
      assertSystemError(error);
    }
  }
};

/**
 * Folds a name as a case-insensitive volume compares it (APFS, HFS+): letter case and Unicode normalization (NFC/NFD)
 * both, so two names that differ in either one would land on one file there.
 */
const foldCaseAndForm = (path: string): string => path.normalize("NFC").toLowerCase();

export interface SnapshotTotals {
  files: number;
  bytes: number;
  /** The project folder's own mode, from the offloaded event (D55). */
  rootMode?: number;
}

/**
 * Reads the snapshot's listing once before anything is written: its totals, names that differ only by case
 * (fs.case-collision on a case-insensitive volume, probed in `holder`) and the space the restore needs on the volume
 * of `nearest` (fs.no-space). `elsewhere` is the command that lands it on another volume, for the fixes.
 */
export const checkSnapshot = async (options: {
  io: LocalIo;
  engine: Engine;
  store: BlobStore;
  /** This store's restic id for the snapshot, and the event that made it. */
  stored: string;
  event: string;
  ctx: RunContext;
  op: string;
  nearest: string;
  holder: string;
  /** A restore taken over: part of it is already in staging, so the space is not checked again. */
  resuming: boolean;
  address: string;
  elsewhere: string;
}): Promise<Result<SnapshotTotals>> => {
  const { io, nearest, address } = options;
  let files = 0;
  let bytes = 0;
  // The first name of each folded key, and every group that has more than one.
  const firstOf = new Map<string, string>();
  const groups = new Map<string, string[]>();
  const listed = await options.engine.entries(
    options.stored,
    (entry) => {
      if (entry.type === "file") {
        files++;
        bytes += entry.size ?? 0;
      }
      const key = foldCaseAndForm(entry.path);
      const first = firstOf.get(key);
      if (first === undefined) firstOf.set(key, entry.path);
      else groups.set(key, [...(groups.get(key) ?? [first]), entry.path]);
    },
    options.ctx,
  );
  if (!listed.ok) return listed;
  const collisions = [...groups.values()];
  if (collisions.length > 0) {
    const insensitive = await ignoresCase(io, options.holder, options.op);
    if (!insensitive.ok) return insensitive;
    if (insensitive.value) {
      const names = collisions.flat().sort();
      return fail(
        finding("fs.case-collision", {
          message: `the snapshot holds names that differ only by case or Unicode form (${collisions
            .slice(0, 5)
            .map((c) => c.sort().join(" and "))
            .join(
              "; ",
            )}${collisions.length > 5 ? "; …" : ""}), and ${nearest} is on a case-insensitive volume, where one would overwrite the other; nothing was restored`,
          fix: `land it on a case-sensitive volume: ${options.elsewhere}`,
          paths: names.slice(0, 100),
        }),
      );
    }
  }
  // The dependencies the install puts back, as the offload recorded them (DESIGN step 2), and the folder's mode.
  const made = await producedBy(options.store, options.event);
  const stripped = made?.stats.strippedBytes ?? 0;
  const rootMode = made?.type === "offloaded" ? made.rootMode : undefined;
  // Logical sizes, plus half a 4 KiB block per file for what the volume rounds up, plus 10%. A resumed restore
  // already holds part of it in staging, and verification still catches a short one, so it is not counted again.
  const needed = Math.ceil((bytes + stripped + files * 2048) * 1.1);
  let free: number;
  try {
    free = await io.fs.freeBytes(nearest);
  } catch (error) {
    return unreadable(nearest, error, "its free space is unknown; nothing was restored");
  }
  if (!options.resuming && free < needed) {
    return fail(
      finding("fs.no-space", {
        message: `${address} needs about ${needed} bytes on the volume of ${nearest} (the snapshot's ${bytes}, ${stripped} of dependencies and a 10% margin), and ${free} are free; nothing was restored`,
        fix: `free some space (plainport offload another project, or empty the trash), or land it on another volume: ${options.elsewhere}`,
        paths: [nearest],
      }),
    );
  }
  return ok({ files, bytes, ...(rootMode === undefined ? {} : { rootMode }) });
};

/**
 * Restores the snapshot into `staging` (made here, not by restic: a snapshot holds the folder's contents, not the
 * folder's own mode, and restic makes a target it creates private, 0700), then compares the staged tree with the
 * listing. `step` journals onload's steps (restore.start before restic runs, restored, verified); `stopped` says
 * whether Ctrl-C landed, so a failure it caused reads as `cancelled`.
 */
export const restoreVerified = async (options: {
  io: LocalIo;
  engine: Engine;
  stored: string;
  staging: string;
  ctx: RunContext;
  /** if-changed: a restore taken over, whose files already written are skipped. */
  overwrite?: "if-changed";
  phase(name: Phase, status: "start" | "end"): void;
  step(name: "restore.start" | "restored" | "verified"): Promise<Result<void>>;
  stopped(): boolean;
  cancelled(): Failure;
  /** The fix verify.mismatch names. */
  fix: string;
}): Promise<Result<void>> => {
  const { io, staging, ctx } = options;
  options.phase("restore", "start");
  try {
    await io.fs.mkdirp(staging);
  } catch (error) {
    return writeFailed(error, `making ${staging}`, false, staging);
  }
  const starting = await options.step("restore.start");
  if (!starting.ok) return starting;
  const restored = await options.engine.restore(
    options.stored,
    staging,
    ctx,
    options.overwrite === undefined ? {} : { overwrite: options.overwrite },
  );
  if (!restored.ok) return options.stopped() ? options.cancelled() : restored;
  const done = await options.step("restored");
  if (!done.ok) return done;
  options.phase("restore", "end");
  if (options.stopped()) return options.cancelled();

  options.phase("verify", "start");
  const scanned = await scanTree(io.fs, staging);
  if (!scanned.ok) return scanned;
  const checked = await verifyListing({
    engine: options.engine,
    fs: io.fs,
    snapshot: options.stored,
    dir: staging,
    manifest: scanned.value.manifest,
    excluded: new Set(),
    ctx,
    subject: "the restored folder",
    fix: options.fix,
  });
  if (!checked.ok) return options.stopped() ? options.cancelled() : checked;
  const verified = await options.step("verified");
  if (!verified.ok) return verified;
  options.phase("verify", "end");
  return ok(undefined);
};
