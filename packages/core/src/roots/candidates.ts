// The folders `plainport init` offers as roots (DESIGN.md "Roots" → Setting roots up): the likely places for code
// that exist in the home folder and hold at least one project, each with its project count and a proposed key.

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
}

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
    if (projects > 0) candidates.push({ path, key: rootKeyFrom(name), projects });
  }
  return { candidates, notes };
};
