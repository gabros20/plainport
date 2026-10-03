// The scan's tree walk (DESIGN.md "Offload process" step 3): one pass over the project folder records the manifest,
// hashes the fingerprint, and notes what preflight and the plan report: sockets, FIFOs and device files (skipped
// and listed), unreadable entries (fs.unreadable), symlinks leading outside (fs.link-outside), totals and the ten
// largest files.
//
// The walk never follows a symlink and never opens a file: it lstats every entry and asks access(2) whether a file
// is readable, so a placeholder (dataless) file is not downloaded by the scan. Folders are walked depth first with
// names sorted, so the same tree always gives the same order, and the same fingerprint.
//
// The fingerprint hashes, for every entry in walk order, its path, type, size, mode, mtime and link target, as
// DESIGN says, plus its ctime: an edit that puts the mtime back (touch -r, some sync tools) still moves the ctime,
// which nothing can set back. It is meant for this device only, to tell whether the folder changed between the
// plan and the snapshot; it is not a content hash.

import { createHash } from "node:crypto";
import { isAbsolute, posix, resolve } from "node:path";
import { fail, finding, ok, type Result, shellWord } from "@plainport/contract";
import { errorCode, type LinkStat, type LocalFs } from "../io.ts";
import { type Manifest, ManifestBuilder } from "./manifest.ts";

export interface SizedPath {
  path: string;
  bytes: number;
}

export type SkippedKind = "socket" | "fifo" | "device";

export interface TreeScan {
  /** The folder scanned, as given. */
  dir: string;
  /** `sha256:<hex>`, stable while nothing in the folder changes. */
  fingerprint: string;
  manifest: Manifest;
  files: number;
  dirs: number;
  symlinks: number;
  /** The total size of the files. */
  bytes: number;
  /** The ten largest files, largest first. */
  largest: SizedPath[];
  /** Sockets, FIFOs and device files: never in the manifest, never snapshotted. Sorted by path. */
  skipped: { path: string; kind: SkippedKind }[];
  /** Files this process may not read, and folders it may not list (whose contents are then unknown). Sorted. */
  unreadable: string[];
  /** Symlinks whose target, resolved from where the link is, lies outside the folder. Sorted by path. */
  linksOutside: { path: string; target: string }[];
}

const LARGEST = 10;
/** Entries lstat'ed at once within one folder. */
const BATCH = 64;

const byPath = <T extends { path: string }>(a: T, b: T): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** Keeps the n largest files seen. */
const keepLargest = (largest: SizedPath[], candidate: SizedPath): void => {
  if (largest.length === LARGEST && (largest[LARGEST - 1] as SizedPath).bytes >= candidate.bytes) return;
  largest.push(candidate);
  largest.sort((a, b) => b.bytes - a.bytes || byPath(a, b));
  if (largest.length > LARGEST) largest.pop();
};

type Seen =
  | { name: string; stat: LinkStat; readable: boolean; target?: string }
  | { name: string; stat?: undefined; error: unknown };

const look = async (fs: LocalFs, path: string, name: string): Promise<Seen> => {
  try {
    const stat = await fs.lstat(path);
    if (stat.kind === "file") return { name, stat, readable: await fs.readable(path) };
    if (stat.kind === "symlink") return { name, stat, readable: true, target: await fs.readlink(path) };
    return { name, stat, readable: true };
  } catch (error) {
    return { name, error };
  }
};

/** Walks the project folder once. Fails only when the folder itself is missing or cannot be listed. */
export const scanTree = async (fs: LocalFs, dir: string): Promise<Result<TreeScan>> => {
  const top = resolve(dir);
  const notFound = () =>
    fail(
      finding("project.not-found", {
        message: `${dir} does not exist or is not a folder`,
        paths: [dir],
        fix: `check the path (ls -d ${shellWord(dir)}); if the project moved, run the command with its new path, or name it by address (root:path)`,
      }),
    );
  let real: string;
  try {
    real = await fs.realpath(top);
    if ((await fs.lstat(real)).kind !== "dir") return notFound();
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return notFound();
    return fail(
      finding("fs.unreadable", {
        message: `plainport cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}`,
        paths: [dir],
        fix: `chmod u+rx ${shellWord(dir)}`,
      }),
    );
  }

  const hash = createHash("sha256");
  const manifest = new ManifestBuilder();
  const scan = {
    files: 0,
    dirs: 0,
    symlinks: 0,
    bytes: 0,
    largest: [] as SizedPath[],
    skipped: [] as TreeScan["skipped"],
    unreadable: [] as string[],
    linksOutside: [] as TreeScan["linksOutside"],
  };
  // Whether a path (absolute, normalized) is the folder or inside it, under either spelling of the folder.
  const inside = (path: string): boolean =>
    [top, real].some((root) => path === root || path.startsWith(root === "/" ? root : `${root}/`));

  // Folders still to list, relative paths; "" is the project folder. Popped from the end: depth first.
  const stack: string[] = [""];
  while (stack.length > 0) {
    const folder = stack.pop() as string;
    const absolute = folder === "" ? real : `${real}/${folder}`;
    let names: string[];
    try {
      names = await fs.readdir(absolute);
    } catch (error) {
      if (folder === "") {
        return fail(
          finding("fs.unreadable", {
            message: `plainport cannot list ${dir}: ${error instanceof Error ? error.message : String(error)}`,
            paths: [dir],
            fix: `chmod u+rx ${shellWord(dir)}`,
          }),
        );
      }
      // Listed as unreadable by the parent already when it was not readable; anything else (it vanished) shows
      // as a change in the fingerprint.
      if (errorCode(error) !== "ENOENT" && !scan.unreadable.includes(folder)) scan.unreadable.push(folder);
      hash.update(`!${folder}\0`);
      continue;
    }
    names.sort();
    const subfolders: string[] = [];
    for (let start = 0; start < names.length; start += BATCH) {
      const batch = names.slice(start, start + BATCH);
      const seen = await Promise.all(batch.map((name) => look(fs, `${absolute}/${name}`, name)));
      for (const item of seen) {
        const path = folder === "" ? item.name : `${folder}/${item.name}`;
        if (item.stat === undefined) {
          // Vanished since the folder was listed: the folder's mtime already tells the fingerprint.
          if (errorCode(item.error) === "ENOENT") continue;
          scan.unreadable.push(path);
          hash.update(`!${path}\0`);
          continue;
        }
        const { stat } = item;
        if (stat.kind === "socket" || stat.kind === "fifo" || stat.kind === "device") {
          scan.skipped.push({ path, kind: stat.kind });
          continue;
        }
        const target = stat.kind === "symlink" ? item.target : undefined;
        hash.update(
          `${stat.kind}\0${path}\0${stat.size}\0${stat.mode}\0${stat.mtimeNs}\0${stat.ctimeNs}\0${target ?? ""}\n`,
        );
        manifest.add({
          path,
          type: stat.kind,
          size: stat.kind === "file" ? stat.size : 0,
          mode: stat.mode,
          mtimeNs: stat.mtimeNs,
          ...(target === undefined ? {} : { linkTarget: target }),
        });
        if (stat.kind === "file") {
          scan.files++;
          scan.bytes += stat.size;
          keepLargest(scan.largest, { path, bytes: stat.size });
          if (!item.readable) scan.unreadable.push(path);
        } else if (stat.kind === "dir") {
          scan.dirs++;
          subfolders.push(path);
        } else if (target !== undefined) {
          scan.symlinks++;
          const lands = isAbsolute(target)
            ? posix.normalize(target)
            : posix.resolve(posix.dirname(`${real}/${path}`), target);
          if (!inside(lands)) scan.linksOutside.push({ path, target });
        }
      }
    }
    // Reversed, so the first subfolder is listed next.
    for (let i = subfolders.length - 1; i >= 0; i--) stack.push(subfolders[i] as string);
  }

  return ok({
    dir,
    fingerprint: `sha256:${hash.digest("hex")}`,
    manifest: manifest.finish(),
    files: scan.files,
    dirs: scan.dirs,
    symlinks: scan.symlinks,
    bytes: scan.bytes,
    largest: scan.largest,
    skipped: scan.skipped.sort(byPath),
    unreadable: scan.unreadable.sort(),
    linksOutside: scan.linksOutside.sort(byPath),
  });
};
