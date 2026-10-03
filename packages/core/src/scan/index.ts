// The scan (DESIGN.md "Offload process" step 3): one walk of the project folder for the manifest and the
// fingerprint, plus the repository's git facts.

import { fail, finding, ok, type Result } from "@plainport/contract";
import type { HostPorts } from "../ports/host.ts";
import type { PreflightReport } from "../preflight/index.ts";
import { type GitContext, type GitFacts, gitFacts } from "./git.ts";
import { scanTree, type TreeScan } from "./walk.ts";

export * from "./git.ts";
export * from "./manifest.ts";
export * from "./walk.ts";

export interface ProjectScan {
  tree: TreeScan;
  /** Absent when the folder has no .git of its own. */
  git?: GitFacts;
}

/**
 * Scans a project folder: git facts first (they only read), then the walk. The git facts open files in .git, which
 * would download a placeholder, so the scan takes preflight's word that the folder is safe to read and refuses
 * without it.
 */
export const scanProject = async (
  host: HostPorts,
  dir: string,
  ctx: GitContext,
  cleared: Pick<PreflightReport, "safeToRead">,
): Promise<Result<ProjectScan>> => {
  if (!cleared.safeToRead) {
    return fail(
      finding("fs.dataless", {
        message: `${dir} was not scanned: preflight's placeholder check must pass before anything in it is read`,
        paths: [dir],
        fix: "run preflight and fix what it reports, then re-run",
      }),
    );
  }
  const git = await gitFacts(host, dir, ctx);
  if (!git.ok) return git;
  const tree = await scanTree(host.fs, dir);
  if (!tree.ok) return tree;
  return ok({ tree: tree.value, ...(git.value === undefined ? {} : { git: git.value }) });
};
