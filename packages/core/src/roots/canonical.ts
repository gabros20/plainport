// Real paths for comparing roots (DESIGN.md "Roots", landing rule 5): symlinks are resolved, and on a
// case-insensitive volume two spellings that differ only by case (or by Unicode normalization) are one folder.
// A path that does not exist yet resolves through its nearest existing ancestor. Whether the volume ignores case
// is probed read-only: an existing name is looked up with its case swapped and compared by device and inode.

import { basename, dirname, join, resolve, sep } from "node:path";
import { errorCode, type LocalIo } from "../io.ts";

export interface CanonicalPath {
  /** The absolute path as given, normalized. */
  path: string;
  /** Symlinks resolved, as the volume spells it, plus any part that does not exist yet. */
  real: string;
  /** Whether the volume holding the nearest existing ancestor ignores case. */
  caseInsensitive: boolean;
}

const swapCase = (name: string): string =>
  [...name].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");

const sameFile = async (io: LocalIo, a: string, b: string): Promise<boolean> => {
  try {
    const [x, y] = await Promise.all([io.fs.stat(a), io.fs.stat(b)]);
    return x.dev === y.dev && x.ino === y.ino;
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return false;
    throw error;
  }
};

/** Probes the volume at an existing real path: the first name up the tree that has letters, looked up case-swapped. */
const ignoresCase = async (io: LocalIo, real: string): Promise<boolean> => {
  for (let current = real; current !== dirname(current); current = dirname(current)) {
    const name = basename(current);
    const swapped = swapCase(name);
    if (swapped === name) continue;
    return sameFile(io, current, join(dirname(current), swapped));
  }
  return false;
};

export const canonicalPath = async (io: LocalIo, path: string): Promise<CanonicalPath> => {
  const absolute = resolve(path);
  const missing: string[] = [];
  let existing = absolute;
  for (;;) {
    try {
      const real = await io.fs.realpath(existing);
      return {
        path: absolute,
        real: missing.length === 0 ? real : join(real, ...missing.reverse()),
        caseInsensitive: await ignoresCase(io, real),
      };
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      if (existing === dirname(existing)) return { path: absolute, real: absolute, caseInsensitive: false };
      missing.push(basename(existing));
      existing = dirname(existing);
    }
  }
};

/** The comparison key: folded when either side ignores case, since then the two may name one folder. */
const keyOf = (path: CanonicalPath, fold: boolean): string =>
  fold ? path.real.normalize("NFC").toLowerCase() : path.real;

const within = (inner: string, outer: string): boolean =>
  inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);

/** How `a` sits relative to `b`: the same folder, inside it, containing it, or apart (undefined). */
export const overlapOf = (a: CanonicalPath, b: CanonicalPath): "same" | "inside" | "contains" | undefined => {
  const fold = a.caseInsensitive || b.caseInsensitive;
  const x = keyOf(a, fold);
  const y = keyOf(b, fold);
  if (x === y) return "same";
  if (within(x, y)) return "inside";
  if (within(y, x)) return "contains";
  return undefined;
};
