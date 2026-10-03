// Manifest verification (DESIGN.md "Offload process" step 7, "Verification levels → manifest"): the snapshot's
// listing must hold exactly the entries the scan found outside the excluded paths, with the same types, sizes, modes
// and link targets. Content is restic's to authenticate; what this catches is a missing, extra or changed entry.
// Every symlink's target is also read again from the folder itself, so a target the listing could only guess
// (restic's ls output, Task 8) never passes on the listing's word alone.
//
// verifySnapshot is the whole of step 7's check: re-stat the folder, compare the listing, then re-stat once more, so an
// edit made while the listing was read is caught too.

import { join } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";
import { type LocalFs, systemErrorCode } from "../io.ts";
import type { Engine, EntryMeta, RunContext } from "../ports/engine.ts";
import type { Manifest, ManifestEntry } from "../scan/manifest.ts";
import { scanTree } from "../scan/walk.ts";

/** At most this many differences are named in the finding. */
const SHOWN = 10;

export interface VerifiedTotals {
  /** Files and bytes the snapshot holds. */
  files: number;
  bytes: number;
}

/** Whether `path` is one of `excluded` or lies inside one. */
export const isExcluded = (excluded: ReadonlySet<string>, path: string): boolean => {
  if (excluded.has(path)) return true;
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    if (excluded.has(path.slice(0, slash))) return true;
  }
  return false;
};

const differs = (expected: ManifestEntry, listed: EntryMeta): string | undefined => {
  if (listed.type !== expected.type) return `is a ${listed.type} in the snapshot, a ${expected.type} here`;
  if (expected.type === "file" && listed.size !== expected.size)
    return `has ${listed.size} bytes in the snapshot, ${expected.size} here`;
  if (listed.mode !== expected.mode)
    return `has mode ${listed.mode.toString(8)} in the snapshot, ${expected.mode.toString(8)} here`;
  if (expected.type === "symlink" && listed.linkTarget !== expected.linkTarget)
    return `points to ${JSON.stringify(listed.linkTarget)} in the snapshot, ${JSON.stringify(expected.linkTarget)} here`;
  return undefined;
};

/** Compares the snapshot's listing with the manifest; verify.mismatch (exit 7) names what differs. */
export const verifyListing = async (options: {
  engine: Engine;
  fs: LocalFs;
  snapshot: string;
  dir: string;
  manifest: Manifest;
  excluded: ReadonlySet<string>;
  ctx: RunContext;
}): Promise<Result<VerifiedTotals>> => {
  const { manifest, excluded } = options;
  // Only the first SHOWN are named; the rest are counted, so a listing of the wrong tree stays cheap.
  const problems: string[] = [];
  let differences = 0;
  const problem = (text: string) => {
    differences++;
    if (problems.length <= SHOWN) problems.push(text);
  };
  const seen = new Set<string>();
  const links: { path: string; target: string | undefined }[] = [];
  const listed = await options.engine.entries(
    options.snapshot,
    (entry) => {
      seen.add(entry.path);
      const expected = isExcluded(excluded, entry.path) ? undefined : manifest.get(entry.path);
      if (expected === undefined) {
        problem(`${entry.path} is in the snapshot but not in the folder's scan`);
        return;
      }
      const difference = differs(expected, entry);
      if (difference !== undefined) problem(`${entry.path} ${difference}`);
      else if (entry.type === "symlink") links.push({ path: entry.path, target: entry.linkTarget });
    },
    options.ctx,
  );
  if (!listed.ok) return listed;

  let files = 0;
  let bytes = 0;
  for (const entry of manifest) {
    if (isExcluded(excluded, entry.path)) continue;
    if (!seen.has(entry.path)) problem(`${entry.path} is in the folder but not in the snapshot`);
    else if (entry.type === "file") {
      files++;
      bytes += entry.size ?? 0;
    }
  }
  for (const link of links) {
    let target: string;
    try {
      target = await options.fs.readlink(join(options.dir, link.path));
    } catch (error) {
      problem(`${link.path} could not be read back as a link (${systemErrorCode(error)})`);
      continue;
    }
    if (target !== link.target)
      problem(`${link.path} points to ${JSON.stringify(target)} here, not to what the snapshot holds`);
  }
  if (differences === 0) return ok({ files, bytes });
  return fail(
    finding("verify.mismatch", {
      message: `snapshot ${options.snapshot.slice(0, 8)} does not match the folder (${differences} difference${
        differences === 1 ? "" : "s"
      }): ${problems.slice(0, SHOWN).join("; ")}${differences > SHOWN ? "; …" : ""}`,
      fix: "nothing was deleted; re-run the offload, and if it fails again run restic check on the store",
      paths: [options.dir],
    }),
  );
};

/** Whether `dir` still has the fingerprint a scan gave it; a walk that fails ends the run. */
export const unchanged = async (fs: LocalFs, dir: string, fingerprint: string): Promise<Result<boolean>> => {
  const now = await scanTree(fs, dir);
  if (!now.ok) return now;
  return ok(now.value.fingerprint === fingerprint);
};

export type SnapshotCheck = { changed: true } | { changed: false; totals: VerifiedTotals };

/**
 * Verifies a snapshot against the scan it was made from: the folder unchanged, the listing the same as the manifest,
 * the folder still unchanged. `changed` says the folder moved under it (plan and snapshot again); verify.mismatch, a
 * listing that differs from an unchanged folder, is a failure.
 */
export const verifySnapshot = async (options: {
  engine: Engine;
  fs: LocalFs;
  dir: string;
  snapshot: string;
  /** The scan the snapshot was made from. */
  tree: { fingerprint: string; manifest: Manifest };
  excluded: ReadonlySet<string>;
  ctx: RunContext;
}): Promise<Result<SnapshotCheck>> => {
  const { fs, dir, tree } = options;
  const before = await unchanged(fs, dir, tree.fingerprint);
  if (!before.ok) return before;
  if (!before.value) return ok({ changed: true });
  const checked = await verifyListing({
    engine: options.engine,
    fs,
    snapshot: options.snapshot,
    dir,
    manifest: tree.manifest,
    excluded: options.excluded,
    ctx: options.ctx,
  });
  if (!checked.ok) return checked;
  const after = await unchanged(fs, dir, tree.fingerprint);
  if (!after.ok) return after;
  return ok(after.value ? { changed: false, totals: checked.value } : { changed: true });
};
