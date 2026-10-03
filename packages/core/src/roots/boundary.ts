// Project boundaries (DESIGN.md "Roots" → Project boundaries): a project is the outermost folder below a root with a
// `.git` directory or a project marker. Folders above it, such as `clients/acme`, are grouping folders: just path
// segments of the address. Nested repositories and workspace packages belong to the outer project. The walk never
// follows symlinks and skips hidden folders (plainport's own `.plainport-*` among them) and node_modules.

import { join } from "node:path";
import { errorCode, type LocalIo } from "../io.ts";

/** Marker files, in the order they name a project's marker when several are present. */
export const PROJECT_MARKERS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"] as const;

export type ProjectMarker = ".git" | (typeof PROJECT_MARKERS)[number];

export interface FoundProject {
  /** Relative to the root, with `/` separators. */
  path: string;
  marker: ProjectMarker;
}

export interface FindOptions {
  /** How many folders below the root a project may sit; DEFAULT_SCAN_DEPTH when absent. */
  depth?: number;
  /** Glob patterns, relative to the root, of folders to skip (a root's `scan.ignore`). */
  ignore?: readonly string[];
}

/** Deep enough for `clients/acme/web/app`; a root's `scan.depth` changes it. */
export const DEFAULT_SCAN_DEPTH = 4;

const SKIPPED = new Set(["node_modules"]);

/** The folder's marker, if it is a project folder; an unreadable folder has none. */
export const markerOf = async (io: LocalIo, dir: string): Promise<ProjectMarker | undefined> => {
  let entries: Awaited<ReturnType<LocalIo["fs"]["entries"]>>;
  try {
    entries = await io.fs.entries(dir);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") return undefined;
    throw error;
  }
  if (entries.some((e) => e.name === ".git" && e.kind === "dir")) return ".git";
  return PROJECT_MARKERS.find((marker) => entries.some((e) => e.name === marker && e.kind === "file"));
};

const ignored = (globs: readonly Bun.Glob[], path: string): boolean =>
  globs.some((glob) => glob.match(path) || glob.match(`${path}/`) || glob.match(`${path}/-`));

/** Every project under the root folder, in no particular order. Unreadable folders are skipped. */
export const findProjects = async (
  io: LocalIo,
  rootDir: string,
  options: FindOptions = {},
): Promise<FoundProject[]> => {
  const depth = options.depth ?? DEFAULT_SCAN_DEPTH;
  const globs = (options.ignore ?? []).map((pattern) => new Bun.Glob(pattern));
  const found: FoundProject[] = [];
  const visit = async (dir: string, path: string, level: number): Promise<void> => {
    if (level > 0) {
      const marker = await markerOf(io, dir);
      if (marker !== undefined) {
        found.push({ path, marker });
        return;
      }
    }
    if (level >= depth) return;
    let entries: Awaited<ReturnType<LocalIo["fs"]["entries"]>>;
    try {
      entries = await io.fs.entries(dir);
    } catch (error) {
      const code = errorCode(error);
      if (code === "EACCES" || code === "EPERM" || code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.kind !== "dir" || entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue;
      const child = path === "" ? entry.name : `${path}/${entry.name}`;
      if (ignored(globs, child)) continue;
      await visit(join(dir, entry.name), child, level + 1);
    }
  };
  await visit(rootDir, "", 0);
  return found;
};

/** The project that a path below the root belongs to: the outermost marked folder along it, if any. */
export const projectAt = async (
  io: LocalIo,
  rootDir: string,
  relative: string,
): Promise<FoundProject | undefined> => {
  const segments = relative.split("/").filter((s) => s !== "");
  for (let i = 1; i <= segments.length; i++) {
    const path = segments.slice(0, i).join("/");
    const marker = await markerOf(io, join(rootDir, ...segments.slice(0, i)));
    if (marker !== undefined) return { path, marker };
  }
  return undefined;
};
