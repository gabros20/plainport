// Which included files git ignores. They travel all the same (AGENTS.md rule 2: gitignored does not mean
// disposable), and the plan names them so people and agents can see that `.env` files and local databases are in the
// snapshot. git decides, by its own rules (every .gitignore, .git/info/exclude, the user's core.excludesFile), in the
// innermost repository holding each file; a folder that is no repository has no list. The list only informs, so a
// git call that fails does not fail the plan: the list is marked incomplete instead (more may travel).

import { join } from "node:path";
import type { HostPorts } from "../ports/host.ts";
import { type GitContext, gitIgnored } from "../scan/git.ts";

/** The files of `files` (project-relative, included in the snapshot) git ignores, sorted; incomplete when git failed. */
export const gitignoredFiles = async (
  host: HostPorts,
  dir: string,
  ctx: GitContext,
  repos: readonly string[],
  files: readonly string[],
): Promise<{ paths: string[]; incomplete?: true }> => {
  // Innermost first, so each file goes to the repository nearest to it.
  const byDepth = [...repos].sort((a, b) => b.length - a.length);
  const asked = new Map<string, string[]>();
  for (const file of files) {
    const repo = byDepth.find((r) => r === "" || file.startsWith(`${r}/`));
    if (repo === undefined) continue;
    const list = asked.get(repo) ?? [];
    list.push(repo === "" ? file : file.slice(repo.length + 1));
    asked.set(repo, list);
  }
  const ignored: string[] = [];
  let incomplete = false;
  for (const [repo, paths] of asked) {
    const answer = await gitIgnored(host, repo === "" ? dir : join(dir, repo), ctx, paths);
    if (!answer.ok) {
      incomplete = true;
      continue;
    }
    for (const path of paths)
      if (answer.value.has(path)) ignored.push(repo === "" ? path : `${repo}/${path}`);
  }
  return { paths: ignored.sort(), ...(incomplete ? { incomplete: true as const } : {}) };
};
