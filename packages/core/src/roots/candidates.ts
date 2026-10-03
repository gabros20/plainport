// The folders `plainport init` offers as roots (DESIGN.md "Roots" → Setting roots up): the likely places for code
// that exist in the home folder and hold at least one project, each with its project count and a proposed key.

import { join } from "node:path";
import type { LocalIo } from "../io.ts";
import { findProjects } from "./boundary.ts";

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

export const rootCandidates = async (io: LocalIo, home: string): Promise<RootCandidate[]> => {
  const candidates: RootCandidate[] = [];
  for (const name of LIKELY_ROOTS) {
    const path = join(home, name);
    const projects = (await findProjects(io, path)).length;
    if (projects > 0) candidates.push({ path, key: rootKeyFrom(name), projects });
  }
  return candidates;
};
