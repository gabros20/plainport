// This machine's mirror of a store's catalog events (DESIGN.md "Local state per machine": ~/.cache/plainport/<store
// id>/events/, keyed by the store's identity, D45), so `plainport ls` works offline. The mirror is a blob-fs store on plainport's own cache folder, which is
// created here when missing; every read and write goes through the io given, so the host port's guard sees it.

import { fail, finding, ok, type Result } from "@plainport/contract";
import {
  type BlobStore,
  eventMirrorDir,
  type LocalIo,
  type PlainportPaths,
  systemErrorCode,
} from "@plainport/core";
import { fsBlobStore } from "./fs-store.ts";

/** The event mirror for the store with this id (its meta/v1/store.json), its folder made if needed. Pass it to loadCatalog. */
export const openEventMirror = async (
  io: LocalIo,
  paths: PlainportPaths,
  storeId: string,
): Promise<Result<BlobStore>> => {
  const dir = eventMirrorDir(paths, storeId);
  try {
    await io.fs.mkdirp(dir);
  } catch (error) {
    systemErrorCode(error); // a guard's refusal or any other bug is thrown again
    return fail(
      finding("store.failed", {
        message: `the event mirror folder ${dir} could not be made: ${(error as Error).message}`,
        fix: `check that ${paths.cacheDir} is a folder you can write to (it is only a cache: it may be deleted), then re-run`,
        paths: [dir],
      }),
    );
  }
  return ok(fsBlobStore(io, dir));
};
