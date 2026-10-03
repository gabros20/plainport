// Real paths for comparing roots (DESIGN.md "Roots", landing rule 5): symlinks are resolved, and on a
// case-insensitive volume two spellings that differ only by case (or by Unicode normalization) are one folder.
// A path that does not exist yet resolves through its nearest existing ancestor. Whether the volume ignores case
// is probed read-only: an existing name is looked up with its case swapped and compared by device and inode.

import { basename, dirname, join, resolve, sep } from "node:path";
import { type Failure, fail, finding, ok, type Result } from "@plainport/contract";
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
    // Not there, or not readable: either way not provably the same file, so the volume counts as case-sensitive.
    if (errorCode(error) !== undefined) return false;
    throw error;
  }
};

const ABSENT = new Set(["ENOENT", "ENOTDIR"]);

/**
 * The finding for a path the file system refuses to resolve, as a user-caused failure (AGENTS.md rule 7): a
 * permission problem is root.not-writable, anything else (a symlink loop, a name too long) root.path-missing.
 */
export const unresolvable = (path: string, error: unknown): Failure => {
  const code = errorCode(error) ?? "error";
  const reason = error instanceof Error ? error.message : String(error);
  return code === "EACCES" || code === "EPERM"
    ? fail(
        finding("root.not-writable", {
          message: `plainport cannot read ${path} (${reason})`,
          fix: `make the folders on the way to ${path} readable (chmod u+rx), or choose another folder`,
          paths: [path],
        }),
      )
    : fail(
        finding("root.path-missing", {
          message: `${path} cannot be resolved (${reason})`,
          fix: `fix the folder or symlink at ${path}, or choose another folder`,
          paths: [path],
        }),
      );
};

/** What is at the path (following symlinks), undefined when nothing is; a refusal for a path that cannot be read. */
export const probeKind = async (
  io: LocalIo,
  path: string,
): Promise<Result<"dir" | "file" | "other" | undefined>> => {
  try {
    return ok((await io.fs.stat(path)).kind);
  } catch (error) {
    const code = errorCode(error);
    if (code !== undefined && ABSENT.has(code)) return ok(undefined);
    if (code !== undefined) return unresolvable(path, error);
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

/** The path's canonical form; a refusal (unresolvable) when the file system cannot resolve it. */
export const canonicalPath = async (io: LocalIo, path: string): Promise<Result<CanonicalPath>> => {
  const absolute = resolve(path);
  const missing: string[] = [];
  let existing = absolute;
  for (;;) {
    try {
      const real = await io.fs.realpath(existing);
      return ok({
        path: absolute,
        real: missing.length === 0 ? real : join(real, ...missing.reverse()),
        caseInsensitive: await ignoresCase(io, real),
      });
    } catch (error) {
      const code = errorCode(error);
      if (code === undefined) throw error;
      if (!ABSENT.has(code)) return unresolvable(absolute, error);
      if (existing === dirname(existing))
        return ok({ path: absolute, real: absolute, caseInsensitive: false });
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
