// Crash-safe file writes. A replacement is written in full to a temporary file beside the target, flushed, then
// renamed over it, so a reader or a crash sees the old file or the new one, never half of either. A create-only
// write links the finished temporary file into place, which fails if the target already exists.

import { dirname } from "node:path";
import { type ConfigIo, errorCode } from "./io.ts";

/** The suffix of every temporary file these writes leave behind if the process dies mid-write. */
export const TEMP_SUFFIX = ".tmp";

const randomHex = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");

/** `<path>.<pid>.<random>.tmp`, in the target's folder so the rename never crosses a file system. */
export const tempPathFor = (path: string, io: ConfigIo): string =>
  `${path}.${io.pid}.${randomHex()}${TEMP_SUFFIX}`;

const unlinkQuietly = (io: ConfigIo, path: string): void => {
  try {
    io.unlink(path);
  } catch {
    // Already gone, or not ours to report: a leftover temporary file is harmless and cleaned up later.
  }
};

/** Replaces `path` with `text` atomically. Throws the I/O error if it fails; the old file is then intact. */
export const writeAtomic = (io: ConfigIo, path: string, text: string): void => {
  const temp = tempPathFor(path, io);
  try {
    io.writeTextDurable(temp, text);
    io.rename(temp, path);
  } catch (error) {
    unlinkQuietly(io, temp);
    throw error;
  }
  io.syncDir(dirname(path));
};

/** Creates `path` holding `text` only if nothing is there yet: true if this call created it, false if it existed. */
export const createExclusive = (io: ConfigIo, path: string, text: string): boolean => {
  const temp = tempPathFor(path, io);
  try {
    io.writeTextDurable(temp, text);
    io.link(temp, path);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    unlinkQuietly(io, temp);
  }
  io.syncDir(dirname(path));
  return true;
};
