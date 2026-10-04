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
      `${(loaded.finding.fix ?? `fix ${ctx.paths.configFile}`).replace(/, then re-run$/, "")}; nothing is deleted until it reads cleanly, ${AGAIN}`,
    );
  const kept = loaded.value.findings.find((f) => f.code === "config.kept-last-good");
  if (kept !== undefined)
    return refused(
      tree,
      `the configuration is only its last good copy (${kept.message})`,
      `${(kept.fix ?? `fix ${ctx.paths.configFile}`).replace(/; plainport picks it up on the next load$/, "")}; nothing is deleted until it reads cleanly, ${AGAIN}`,
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
      `${(folders.finding.fix ?? "make every registered project's folder readable").replace(/, then re-run$/, "")}, ${AGAIN}`,
    );
  const canon = await canonicalPath(ctx.io, tree, ctx.paths.home);
  if (!canon.ok)
    return refused(
      tree,
      `it cannot be resolved (${canon.finding.message})`,
      `make it readable (chmod u+rx), ${AGAIN}`,
    );
  for (const f of folders.value) {
    const related = await overlapByIdentity(ctx.io, canon.value, f.canon);
    if (!related.ok)
      return refused(
        tree,
        `whether it is ${f.address}'s folder cannot be told (${related.finding.message})`,
        `make ${shellWord(f.folder)} and the folders on the way to it readable, ${AGAIN}`,
      );
    const relation = related.value;
    if (relation === undefined || (relation === "inside" && options.insideProject === true)) continue;
    const how = relation === "same" ? "is" : relation === "inside" ? "lies inside" : "holds";
    return refused(
      tree,
      `it ${how} ${f.address}'s folder ${f.folder}, a registered working copy`,
      relation === "inside"
        ? `the folder is inside your working copy; remove it by hand if it is plainport's, ${AGAIN}`
        : `move your working copy out by hand: mv ${shellWord(f.folder)} <a folder outside ${shellWord(tree)}>, ${AGAIN}`,
    );
  }
  return ok(undefined);
};

/** What every refusal ends with: the way on once the person has acted (r3 #6). */
const AGAIN = "then run plainport gc (or re-run the command that refused)";

/** The way out of a refusal for a folder that is in the tree but should not go with it. */
const moveOut = (path: string, tree: string): string =>
  `move it out of the folder being deleted: mv ${shellWord(path)} <a folder outside ${shellWord(tree)}>, ${AGAIN}`;

const KEY_NAME = /^[0-9a-f]{64}$/;

/**
 * Whether `dir` (which holds a config file, keys/ and data/) is a restic repository: restic writes its keys as plain
 * JSON (`{"kdf":"scrypt","salt":…,"data":…}`, unchanged through 0.19, the pinned version), while its config is an
 * encrypted blob nothing can recognise. One key file that reads as a restic key is proof; a project's own
 * config + keys/ + data/ layout is not one (r3 #6). A key file that cannot be read cannot be told apart: unknown.
 */
const isResticRepository = async (io: LocalIo, dir: string): Promise<"yes" | "no" | "unknown"> => {
  let names: string[];
  try {
    names = (await io.fs.entries(join(dir, "keys"))).filter((e) => e.kind === "file").map((e) => e.name);
  } catch (error) {
    if (errorCode(error) === undefined) throw error;
    return "unknown";
  }
  for (const name of names.filter((n) => KEY_NAME.test(n)).slice(0, 3)) {
    let text: string;
    try {
      text = await io.fs.readText(join(dir, "keys", name));
    } catch (error) {
      if (errorCode(error) === undefined) throw error;
      return "unknown";
    }
    try {
      const key = JSON.parse(text) as Record<string, unknown>;
      if (typeof key.kdf === "string" && typeof key.salt === "string" && typeof key.data === "string")
        return "yes";
    } catch {
      // Not JSON: not a restic key.
    }
  }
  return "no";
};

/** Lets this user search and read a folder it owns (as the delete itself would), once: false when that fails. */
const openUp = async (io: LocalIo, dir: string): Promise<boolean> => {
  try {
    await io.fs.chmod(dir, (await io.fs.lstat(dir)).mode | 0o700);
    return true;
  } catch (error) {
    if (errorCode(error) === undefined) throw error;
    return false;
  }
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
    return refused(
      tree,
      `it cannot be looked at (${code})`,
      `make ${shellWord(tree)} readable (chmod u+rx), ${AGAIN}`,
    );
  }
  // A file or a link is removed, never followed: nothing below it is deleted.
  if (top.kind !== "dir") return ok(undefined);
  const unreadable = (dir: string, code: string) =>
    refused(
      tree,
      `${dir} cannot be read (${code}), even after making it readable for this user, so what it holds is unknown`,
      `make it readable (sudo chown -R "$USER" ${shellWord(dir)} if another user owns it), or ${moveOut(dir, tree)}`,
    );
  /** A folder's device, opening up its parent once when this user cannot search it. */
  const devOf = async (dir: string, parent?: string): Promise<Result<number>> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return ok((await io.fs.stat(dir)).dev);
      } catch (error) {
        const code = errorCode(error);
        if (code === undefined) throw error;
        if (
          attempt === 0 &&
          (code === "EACCES" || code === "EPERM") &&
          parent !== undefined &&
          (await openUp(io, parent))
        )
          continue;
        return unreadable(dir, code);
      }
    }
  };
  /** A folder's entries, opening it up once when this user cannot read it (a package's 0o111 folder, r3 #6). */
  const entriesOf = async (dir: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return ok(await io.fs.entries(dir));
      } catch (error) {
        const code = errorCode(error);
        if (code === undefined) throw error;
        if (code === "ENOENT") return ok([]);
        if (attempt === 0 && (code === "EACCES" || code === "EPERM") && (await openUp(io, dir))) continue;
        return unreadable(dir, code);
      }
    }
  };
  const rootDev = await devOf(tree);
  if (!rootDev.ok) return rootDev;
  const pending = [tree];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    const listed = await entriesOf(dir);
    if (!listed.ok) return listed;
    const entries = listed.value;
    const kinds = new Map(entries.map((e) => [e.name, e.kind]));
    if (kinds.get("config") === "file" && kinds.get("keys") === "dir" && kinds.get("data") === "dir") {
      const restic = await isResticRepository(io, dir);
      if (restic !== "no")
        return refused(
          tree,
          restic === "yes"
            ? `${dir} is a restic repository (its keys/ hold a restic key), which may hold the only copy of snapshots`
            : `${dir} looks like a restic repository (config, keys/ and data/) and its keys cannot be read to tell`,
          moveOut(dir, tree),
        );
    }
    if (kinds.get("meta") === "dir") {
      try {
        await io.fs.lstat(join(dir, "meta", "v1", "store.json"));
        return refused(
          tree,
          `${dir} is a store plainport made (meta/v1/store.json), which may hold the only copy of snapshots`,
          `${moveOut(dir, tree)}; point stores.<name>.path at its new place if it is a configured store`,
        );
      } catch (error) {
        const code = errorCode(error);
        if (code === undefined) throw error;
        if (code !== "ENOENT" && code !== "ENOTDIR") return unreadable(join(dir, "meta"), code);
      }
    }
    for (const entry of entries) {
      if (entry.kind !== "dir") continue;
      const child = join(dir, entry.name);
      const dev = await devOf(child, dir);
      if (!dev.ok) return dev;
      if (dev.value !== rootDev.value)
        return refused(
          tree,
          `${child} is a mount point (another device than the tree), whose contents may be anything, a store included`,
          `unmount it (diskutil unmount ${shellWord(child)}, or umount on Linux), ${AGAIN}`,
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
      `${(stores.finding.fix ?? "move the store elsewhere").replace(/, then re-run$/, "")}, ${AGAIN}`,
    );
  const projects = await noProject(ctx, tree, options);
  if (!projects.ok) return projects;
  return walk(ctx.io, tree);
};
