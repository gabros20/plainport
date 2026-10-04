// The shared holders in a root, `.plainport-staging` and `.plainport-trash` (D72): each operation puts its own folder
// in one, and removes the holder by rmdir once that leaves it empty. No lock serializes two projects' operations in one
// root, so an rmdir can land between another operation making the holder and making its folder in it; the creating
// side makes the holder again (makeInHolder), and the removing side never fails an operation (removeEmptyHolder).

import { basename, sep } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";
import { assertSystemError, type LocalIo, systemErrorCode } from "./io.ts";
import { canonicalPath } from "./roots/canonical.ts";

export type HolderName = ".plainport-staging" | ".plainport-trash";

const TRIES = 3;

/**
 * Makes `holder`, then runs `make`, which makes `target` in it. An ENOENT from `make` means another operation removed
 * the empty holder in between: the holder is made again and `make` retried, up to three tries, then fs.write-failed.
 * Any other error is thrown as it is, for the caller's own finding.
 */
export const makeInHolder = async <T>(
  io: LocalIo,
  holder: string,
  target: string,
  make: () => Promise<T>,
): Promise<Result<T>> => {
  for (let tries = 1; tries <= TRIES; tries++) {
    try {
      await io.fs.mkdirp(holder);
      return ok(await make());
    } catch (error) {
      if (systemErrorCode(error) !== "ENOENT") throw error;
    }
  }
  return fail(
    finding("fs.write-failed", {
      message: `${target} could not be made: another plainport operation in the same root removed ${holder} ${TRIES} times while it was made`,
      fix: "re-run once the other plainport operations in this root have finished",
      paths: [holder],
    }),
  );
};

/**
 * Removes `holder` when it is empty, by rmdir, and only when its name is `name`: anything else is left alone. It never
 * fails the operation: a holder still in use (ENOTEMPTY), already gone (ENOENT) or that cannot be removed stays, which
 * is harmless, and the creating side copes with one removed (makeInHolder).
 */
export const removeEmptyHolder = async (io: LocalIo, holder: string, name: HolderName): Promise<void> => {
  if (basename(holder) !== name) return;
  try {
    await io.fs.rmdir(holder);
  } catch (error) {
    assertSystemError(error);
  }
};

/** Removes an empty folder that is no holder (one an operation made and failed to fill); ENOTEMPTY and ENOENT leave it. */
export const rmdirIfEmpty = async (io: LocalIo, path: string): Promise<void> => {
  try {
    await io.fs.rmdir(path);
  } catch (error) {
    const code = systemErrorCode(error);
    if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw error;
  }
};

/** The reserved name a path goes through (a segment named .plainport-*, the holders and any later one), if any. */
const reservedSegment = (path: string): string | undefined =>
  path.split(sep).find((segment) => segment.startsWith(".plainport-"));

/**
 * usage.invalid when `path` is, or lies inside, a folder plainport reserves (.plainport-staging, .plainport-trash, any
 * .plainport-*), as given or by its real path: gc deletes what it finds there, so it is never a project's place or a
 * root (D84).
 */
export const notReserved = async (
  io: LocalIo,
  path: string,
  home: string,
  what: string,
): Promise<Result<void>> => {
  let segment = reservedSegment(path);
  if (segment === undefined) {
    const canon = await canonicalPath(io, path, home);
    if (!canon.ok) return canon;
    segment = reservedSegment(canon.value.real);
  }
  if (segment === undefined) return ok(undefined);
  return fail(
    finding("usage.invalid", {
      message: `${path} lies in ${segment}, a folder plainport reserves for its own staging and trash, which gc deletes; it cannot be ${what}`,
      fix: "choose a folder outside every .plainport-* folder, then re-run",
      paths: [path],
    }),
  );
};
