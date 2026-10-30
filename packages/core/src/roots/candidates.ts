// The folders `plainport init` offers as roots (DESIGN.md "Roots" → Setting roots up): the likely places for code
// that exist in the home folder and hold at least one project, each with its project count, its size (D70: dependency
// folders left out, two seconds at most per candidate, shown as "≥ size" when cut off) and a proposed key.

import { join } from "node:path";
import type { LocalIo } from "../io.ts";
import { findProjects } from "./boundary.ts";
import { probeKind } from "./canonical.ts";

/** Where people usually keep code, in the order init offers them. */
export const LIKELY_ROOTS = ["work", "Developer", "Projects", "code"] as const;

export interface RootCandidate {
  path: string;
  /** A proposed root key: the folder's name as a lower-case word. */
  key: string;
  projects: number;
  /** Bytes under it, dependency folders left out (D70); a lower bound when `complete` is false. */
  bytes: number;
  /** The size walk finished within its budget; false shows the size as "≥". */
  complete: boolean;
}

/** Folders a size walk skips (D70): what dependency installs make, which offloads strip. */
export const SIZE_SKIPPED: ReadonlySet<string> = new Set([
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".gradle",
  ".next",
  ".turbo",
  ".cache",
]);

/** How long the size walk of one candidate may take (D70); a walk cut off shows its size as "≥". */
export const SIZE_BUDGET_MS = 2_000;

/**
 * The bytes under `path`, dependency folders (SIZE_SKIPPED) left out and symlinks never followed, within `budgetMs`:
 * `complete` is false when the budget ran out first, and `bytes` is then what was counted so far. An entry that cannot
 * be read is skipped; sizes never block init.
 */
export const folderSize = async (
  io: LocalIo,
  path: string,
  options: { budgetMs?: number; now?: () => number } = {},
): Promise<{ bytes: number; complete: boolean }> => {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? SIZE_BUDGET_MS);
  let bytes = 0;
  const pending = [path];
  while (pending.length > 0) {
    if (now() > deadline) return { bytes, complete: false };
    const dir = pending.pop() as string;
    let entries: Awaited<ReturnType<LocalIo["fs"]["entries"]>>;
    try {
      entries = await io.fs.entries(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.kind === "dir") {
        if (!SIZE_SKIPPED.has(entry.name)) pending.push(full);
      } else if (entry.kind === "file") {
        try {
          bytes += (await io.fs.lstat(full)).size;
        } catch {
          // Gone or unreadable since the listing: left out.
        }
      }
      if (now() > deadline) return { bytes, complete: false };
    }
  }
  return { bytes, complete: true };
};

/** A root key made from a folder name: `Developer` → `developer`, `My Code` → `my-code`. */
export const rootKeyFrom = (name: string): string => {
  const key = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "");
  return key === "" ? "root" : key;
};

/** A likely folder that exists but cannot be offered, and why. */
export interface SkippedCandidate {
  path: string;
  reason: string;
}

/** The likely folders that hold projects; one that is a file, a symlink loop or unreadable is skipped with a note. */
export const rootCandidates = async (
  io: LocalIo,
  home: string,
  options: { budgetMs?: number; now?: () => number } = {},
): Promise<{ candidates: RootCandidate[]; notes: SkippedCandidate[] }> => {
  const candidates: RootCandidate[] = [];
  const notes: SkippedCandidate[] = [];
  for (const name of LIKELY_ROOTS) {
    const path = join(home, name);
    const kind = await probeKind(io, path);
    if (!kind.ok) {
      notes.push({ path, reason: kind.finding.message });
      continue;
    }
    if (kind.value === undefined) continue;
    if (kind.value !== "dir") {
      notes.push({ path, reason: "it is not a folder" });
      continue;
    }
    const projects = (await findProjects(io, path)).length;
    if (projects > 0)
      candidates.push({ path, key: rootKeyFrom(name), projects, ...(await folderSize(io, path, options)) });
  }
  return { candidates, notes };
};
