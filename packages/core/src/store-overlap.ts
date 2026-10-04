// No overlap between a project and a local store (D83, AGENTS.md rule 1): release renames the project folder into
// the trash and a detached delete removes it, so a store inside it (say under stripped output, `.next/archive`, which
// no fingerprint watches) would go with its snapshots, the verified one included. A project inside a store is
// refused too. Folders are compared by real path (symlinks resolved, the volume's case rule; roots/canonical.ts),
// against every local store the configuration names. Setup, the offload plan, the step right before release's rename
// and recover (through release) all ask; the refusal store.inside-project is never allowable.

import { fail, finding, ok, type Result, shellWord } from "@plainport/contract";
import type { ResolvedConfig } from "./config/schema.ts";
import type { LocalIo } from "./io.ts";
import { expandHome } from "./paths.ts";
import { canonicalPath, overlapOf } from "./roots/canonical.ts";

/** A local store's folder: what no project may hold or lie inside. */
export interface ProtectedStore {
  name: string;
  root: string;
}

/** Every local store the configuration names, with its folder made absolute. */
export const localStores = (config: ResolvedConfig, home: string): ProtectedStore[] =>
  Object.entries(config.stores).flatMap(([name, store]) =>
    store.kind === "local" ? [{ name, root: expandHome(store.path, home, home) }] : [],
  );

/**
 * store.inside-project when `folder` holds, is, or lies inside one of `stores`; a path that cannot be resolved (a
 * loop, no permission) cannot be shown apart, so it refuses too (fail closed).
 */
export const storeOverlap = async (
  io: LocalIo,
  home: string,
  folder: string,
  stores: readonly ProtectedStore[],
): Promise<Result<void>> => {
  if (stores.length === 0) return ok(undefined);
  const project = await canonicalPath(io, folder, home);
  if (!project.ok) return project;
  for (const store of stores) {
    const canon = await canonicalPath(io, store.root, home);
    if (!canon.ok) return canon;
    const relation = overlapOf(canon.value, project.value);
    if (relation === undefined) continue;
    const how =
      relation === "same"
        ? `store ${store.name} is the folder ${folder} itself`
        : relation === "inside"
          ? `store ${store.name} (${store.root}) lies inside ${folder}`
          : `${folder} lies inside store ${store.name} (${store.root})`;
    return fail(
      finding("store.inside-project", {
        message: `${how}: offloading it would move the store, and its snapshots, into the trash with the folder; nothing was changed`,
        fix: `move the store outside every project folder (stores.${store.name}.path in config.toml, or init a new store elsewhere) or move ${shellWord(folder)} out of the store, then re-run`,
        paths: [folder, store.root],
      }),
    );
  }
  return ok(undefined);
};
