// The one guard every recursive delete plainport makes goes through (D87, AGENTS.md rule 1): the detached trash
// delete (in its own process, right before it deletes), gc, housekeeping, recover's delete-trash, staging cleanup,
// the leftovers of a renamed-back trash and dehydrate. It runs immediately before the delete and asks the tree itself,
// whatever config or a path's spelling say:
//
//   (a) no mounts: the tree is walked with lstat, never through a link, and a folder on another device than the
//       tree's root (a mount point, a disk image, a FUSE bind mount) refuses;
//   (b) no stores: a store plainport made marker (meta/v1/store.json) or a restic repository (a config file beside keys/
//       and data/) anywhere in the tree refuses, stripped or excluded folders included;
//   (c) no projects: a tree that is, holds or lies inside a registered project's effective folder refuses, and a
//       registered folder that cannot be resolved refuses rather than drops out (registeredFolders strict);
//   (d) a clean config: the configuration is read fresh, and one that does not read cleanly (config.kept-last-good
//       included) refuses; a configured local store the tree holds or lies inside refuses too (D83, by path).
//
// A refusal is delete.guard-refused, naming the reason and the fix; the caller leaves its journal pending. The
// path-based checks before it (D83 store.inside-project, D84 path.reserved and project.nested) stay as the early,
// friendly refusals; this one is the last word.

import { join } from "node:path";
import { type Failure, fail, finding, ok, type Result, shellWord } from "@plainport/contract";
import { ConfigLoader } from "./config/load.ts";
import { errorCode, type LocalIo } from "./io.ts";
import type { Env, PlainportPaths } from "./paths.ts";
import { canonicalPath, overlapByIdentity } from "./roots/canonical.ts";
import { registeredFolders } from "./saga/project-gate.ts";
import { localStores, storeOverlap } from "./store-overlap.ts";

export interface DeleteGuardContext {
  io: LocalIo;
  paths: PlainportPaths;
  env: Env;
}

export interface DeleteGuardOptions {
  /**
   * The tree lies inside its own project by design (dehydrate's dependency folders): lying inside a registered folder
   * is allowed; being one or holding one still refuses.
   */
  insideProject?: boolean;
}

const refused = (tree: string, reason: string, fix: string): Failure =>
  fail(
    finding("delete.guard-refused", {
      message: `${tree} was not deleted: ${reason}`,
      fix,
      paths: [tree],
    }),
  );

/** (d) The configuration, read fresh: a refusal unless it reads cleanly. */
const cleanConfig = async (ctx: DeleteGuardContext, tree: string) => {
  const loaded = await new ConfigLoader(ctx.io, ctx.paths).load({ env: ctx.env });
  if (!loaded.ok)
    return refused(
      tree,
      `the configuration cannot be read cleanly, so the stores it names cannot be checked (${loaded.finding.message})`,
      `${loaded.finding.fix ?? `fix ${ctx.paths.configFile}`}; nothing is deleted until it reads cleanly`,
    );
  const kept = loaded.value.findings.find((f) => f.code === "config.kept-last-good");
  if (kept !== undefined)
    return refused(
      tree,
      `the configuration is only its last good copy (${kept.message})`,
      `${kept.fix ?? `fix ${ctx.paths.configFile}`}; nothing is deleted until it reads cleanly`,
    );
  return ok(loaded.value.config);
};

/** (c) No registered project's folder is the tree, in it, or around it. */
const noProject = async (ctx: DeleteGuardContext, tree: string, options: DeleteGuardOptions) => {
  const folders = await registeredFolders(ctx.io, ctx.paths, ctx.env, { strict: true });
  if (!folders.ok)
    return refused(
      tree,
      `the registered projects' folders cannot all be checked (${folders.finding.message})`,
      `${folders.finding.fix ?? "make every registered project's folder readable"}, then re-run`,
    );
  const canon = await canonicalPath(ctx.io, tree, ctx.paths.home);
  if (!canon.ok)
    return refused(tree, `it cannot be resolved (${canon.finding.message})`, "make it readable, then re-run");
  for (const f of folders.value) {
    const related = await overlapByIdentity(ctx.io, canon.value, f.canon);
    if (!related.ok)
      return refused(
        tree,
        `whether it is ${f.address}'s folder cannot be told (${related.finding.message})`,
        `make ${f.folder} and the folders on the way to it readable, then re-run`,
      );
    const relation = related.value;
    if (relation === undefined || (relation === "inside" && options.insideProject === true)) continue;
    const how = relation === "same" ? "is" : relation === "inside" ? "lies inside" : "holds";
    return refused(
      tree,
      `it ${how} ${f.address}'s folder ${f.folder}, a registered working copy`,
      `move ${shellWord(f.folder)} out of ${shellWord(tree)} by hand (it is your working copy, not plainport's), then re-run`,
    );
  }
  return ok(undefined);
};

/** (a) and (b): the tree itself, walked with lstat and never through a link. */
const walk = async (io: LocalIo, tree: string): Promise<Result<void>> => {
  let top: Awaited<ReturnType<LocalIo["fs"]["lstat"]>>;
  try {
    top = await io.fs.lstat(tree);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return ok(undefined);
    if (code === undefined) throw error;
    return refused(tree, `it cannot be looked at (${code})`, `make ${shellWord(tree)} readable, then re-run`);
  }
  // A file or a link is removed, never followed: nothing below it is deleted.
  if (top.kind !== "dir") return ok(undefined);
  const devOf = async (dir: string): Promise<Result<number>> => {
    try {
      return ok((await io.fs.stat(dir)).dev);
    } catch (error) {
      const code = errorCode(error);
      if (code === undefined) throw error;
      return refused(
        tree,
        `${dir} cannot be looked at (${code})`,
        `make ${shellWord(dir)} readable, then re-run`,
      );
    }
  };
  const rootDev = await devOf(tree);
  if (!rootDev.ok) return rootDev;
  const pending = [tree];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    let entries: Awaited<ReturnType<LocalIo["fs"]["entries"]>>;
    try {
      entries = await io.fs.entries(dir);
    } catch (error) {
      const code = errorCode(error);
      if (code === undefined) throw error;
      if (code === "ENOENT") continue;
      return refused(
        tree,
        `${dir} cannot be read (${code}), so what it holds is unknown`,
        `make ${shellWord(dir)} readable (chmod u+rx), then re-run`,
      );
    }
    const kinds = new Map(entries.map((e) => [e.name, e.kind]));
    if (kinds.get("config") === "file" && kinds.get("keys") === "dir" && kinds.get("data") === "dir")
      return refused(
        tree,
        `${dir} is a restic repository (config, keys/ and data/), which may hold the only copy of snapshots`,
        `move the repository out of ${shellWord(tree)}, then re-run`,
      );
    if (kinds.get("meta") === "dir") {
      try {
        await io.fs.lstat(join(dir, "meta", "v1", "store.json"));
        return refused(
          tree,
          `${dir} is a store plainport made (meta/v1/store.json), which may hold the only copy of snapshots`,
          `move the store out of ${shellWord(tree)} (and stores.<name>.path with it), then re-run`,
        );
      } catch (error) {
        const code = errorCode(error);
        if (code === undefined) throw error;
        if (code !== "ENOENT" && code !== "ENOTDIR")
          return refused(
            tree,
            `${dir}/meta cannot be read (${code})`,
            `make ${shellWord(dir)} readable, then re-run`,
          );
      }
    }
    for (const entry of entries) {
      if (entry.kind !== "dir") continue;
      const child = join(dir, entry.name);
      const dev = await devOf(child);
      if (!dev.ok) return dev;
      if (dev.value !== rootDev.value)
        return refused(
          tree,
          `${child} is a mount point (another device than the tree), whose contents may be anything, a store included`,
          `unmount ${shellWord(child)}, then re-run`,
        );
      pending.push(child);
    }
  }
  return ok(undefined);
};

/**
 * Whether `tree` may be deleted now: ok, or delete.guard-refused naming why (see the file comment). Run immediately
 * before the delete; it reads the configuration and the registry fresh and walks the whole tree.
 */
export const deleteGuard = async (
  ctx: DeleteGuardContext,
  tree: string,
  options: DeleteGuardOptions = {},
): Promise<Result<void>> => {
  const config = await cleanConfig(ctx, tree);
  if (!config.ok) return config;
  const stores = await storeOverlap(ctx.io, ctx.paths.home, tree, localStores(config.value, ctx.paths.home));
  if (!stores.ok)
    return refused(
      tree,
      stores.finding.message.replace(/; nothing was changed$/, ""),
      stores.finding.fix ?? "move the store elsewhere, then re-run",
    );
  const projects = await noProject(ctx, tree, options);
  if (!projects.ok) return projects;
  return walk(ctx.io, tree);
};
