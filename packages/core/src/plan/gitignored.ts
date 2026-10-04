// Which included files the project's own .gitignore files ignore. They travel all the same (AGENTS.md rule 2:
// gitignored does not mean disposable), and the plan names them so people and agents can see that `.env` files and
// local databases are in the snapshot. Only `.gitignore` files inside the project count, read with plainport's
// gitignore subset (patterns.ts), not global excludes or `.git/info/exclude`, so it works with or without a
// repository. Each applies below its own folder, a deeper one decides over a shallower one, and a file inside an
// ignored folder is ignored whatever a later negation says, as in git.

import { posix } from "node:path";
import { type LocalFs, systemErrorCode } from "../io.ts";
import { compilePatterns, type PatternSet } from "./patterns.ts";

const GITIGNORE = ".gitignore";

/** Whether `path` is inside `folder` ("" is the project), and its path relative to it. */
const below = (path: string, folder: string): string | undefined =>
  folder === "" ? path : path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : undefined;

/** The files of `files` (project-relative, included in the snapshot) that a .gitignore among them ignores, sorted. */
export const gitignoredFiles = async (
  fs: LocalFs,
  dir: string,
  files: readonly string[],
): Promise<string[]> => {
  const sets: { folder: string; set: PatternSet }[] = [];
  for (const path of files) {
    if (posix.basename(path) !== GITIGNORE) continue;
    let text: string;
    try {
      text = await fs.readText(posix.join(dir, path));
    } catch (error) {
      systemErrorCode(error);
      continue;
    }
    const folder = posix.dirname(path);
    sets.push({ folder: folder === "." ? "" : folder, set: compilePatterns(text.split("\n")) });
  }
  if (sets.length === 0) return [];
  // Outermost first, so a deeper .gitignore decides last.
  const depth = (folder: string) => (folder === "" ? 0 : folder.split("/").length);
  sets.sort((a, b) => depth(a.folder) - depth(b.folder));
  const ignored = (path: string): boolean => {
    const parts = path.split("/");
    // A folder some .gitignore ignores takes everything inside it along.
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      let decided: boolean | undefined;
      for (const { folder: at, set } of sets) {
        const rel = below(folder, at);
        if (rel !== undefined) decided = set.decide(rel, "dir") ?? decided;
      }
      if (decided === true) return true;
    }
    let decided: boolean | undefined;
    for (const { folder: at, set } of sets) {
      const rel = below(path, at);
      if (rel !== undefined) decided = set.decide(rel, "file") ?? decided;
    }
    return decided === true;
  };
  return files.filter((path) => posix.basename(path) !== GITIGNORE && ignored(path)).sort();
};
