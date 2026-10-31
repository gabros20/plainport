// `plainport store remove <name>` (Q13: confirm, local only): forgets a store on this device. It removes the store's
// table from managed.toml and the name's pin from registry.json (D85), under their locks. It never reaches the store and
// never touches its contents, its repository or this device's record of it (stores/<id>.json, which other names for
// the same store share).
//
// It refuses with store.in-use while anything on this device still uses the store: a root that names it, or takes it as
// the default store; an open journal (an offload, an onload), setup attempt or unsettled upgrade that names it. A
// store config.toml defines is the user's to remove there: plainport never writes config.toml.

import { fail, finding, ok, type Result } from "@plainport/contract";
import { ConfigLoader } from "../config/load.ts";
import { updateManaged } from "../config/managed.ts";
import type { LocalIo } from "../io.ts";
import { readBootstrapJournals, readJournals } from "../journal/index.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import { updateRegistry } from "../registry.ts";
import { configLayers } from "./list.ts";
import { notConfigured } from "./reach.ts";
import { readUpgradeJournals } from "./upgrade.ts";

export type StoreRemoved = {
  name: string;
  /** The id the name was pinned to here, now forgotten; absent when this device never set it up. */
  id?: string;
  /** managed.toml no longer defines it. */
  removed: boolean;
};

/** What on this device still uses the store `name`, one phrase each; empty when nothing does. */
export const storeUsers = async (
  io: LocalIo,
  paths: PlainportPaths,
  env: Env,
  name: string,
): Promise<Result<string[]>> => {
  const loaded = await new ConfigLoader(io, paths).load({ env });
  if (!loaded.ok) return loaded;
  const { config } = loaded.value;
  const users: string[] = [];
  for (const [key, root] of Object.entries(config.roots)) {
    if (root.store === name) users.push(`root ${key} sends its snapshots to it`);
    else if (root.store === undefined && config.defaultStore === name)
      users.push(`root ${key} names no store, so it takes the default store, ${name}`);
  }
  let journals: Awaited<ReturnType<typeof readJournals>>;
  let attempts: Awaited<ReturnType<typeof readBootstrapJournals>>;
  let upgrades: Awaited<ReturnType<typeof readUpgradeJournals>>;
  try {
    journals = await readJournals(io, paths);
    attempts = await readBootstrapJournals(io, paths);
    upgrades = await readUpgradeJournals(io, paths);
  } catch (error) {
    return fail(
      finding("fs.unreadable", {
        message: `the journals in ${paths.journalDir} could not be read (${error instanceof Error ? error.message : String(error)}), so whether the store is in use is not known; nothing was changed`,
        fix: `check that ${paths.journalDir} is readable, then re-run`,
        paths: [paths.journalDir],
      }),
    );
  }
  for (const journal of journals.journals)
    if (journal.store.name === name)
      users.push(
        `the ${journal.kind} ${journal.op} of ${journal.project.address} is open (plainport recover settles it)`,
      );
  for (const path of journals.unreadable)
    users.push(`the journal ${path} cannot be read by this version and may name it`);
  for (const attempt of attempts.journals)
    if (attempt.store.name === name)
      users.push(
        `its setup attempt ${attempt.op} is open (plainport recover, or plainport store add ${name}, settles it)`,
      );
  // An upgrade a crash left: recover opens its store by this name to clear the marker every device refuses under.
  for (const upgrade of upgrades.journals)
    if (upgrade.store.name === name)
      users.push(`its upgrade ${upgrade.op} is unsettled (plainport recover settles it)`);
  for (const path of upgrades.unreadable)
    users.push(`the upgrade journal ${path} cannot be read by this version and may name it`);
  return ok(users);
};

export const removeStore = async (
  io: LocalIo,
  options: { paths: PlainportPaths; env: Env; name: string },
): Promise<Result<StoreRemoved>> => {
  const { paths, env, name } = options;
  const loaded = await new ConfigLoader(io, paths).load({ env });
  if (!loaded.ok) return loaded;
  const { user, managed } = await configLayers(io, paths);
  if (loaded.value.config.stores[name] === undefined && managed.stores?.[name] === undefined)
    return notConfigured(name, Object.keys(loaded.value.config.stores));
  if (user.stores?.[name] !== undefined)
    return fail(
      finding("usage.invalid", {
        message: `store ${name} is defined in ${paths.configFile}, which is yours: plainport never writes it; nothing was changed`,
        fix: `remove [stores.${name}] from ${paths.configFile} by hand${managed.stores?.[name] === undefined ? "" : `, then re-run plainport store remove ${name} --yes for its managed.toml table`}`,
        paths: [paths.configFile],
      }),
    );
  const users = await storeUsers(io, paths, env, name);
  if (!users.ok) return users;
  if (users.value.length > 0)
    return fail(
      finding("store.in-use", {
        message: `store ${name} is still in use on this device: ${users.value.join("; ")}; nothing was changed`,
        fix: `point each root at another store first (plainport root add … --store <other>, or edit roots.<key>.store), and let open operations finish (plainport recover), then re-run plainport store remove ${name} --yes`,
      }),
    );

  let removed = false;
  const written = await updateManaged(io, paths, (current) => {
    if (current.stores?.[name] === undefined) return ok(current);
    removed = true;
    const { [name]: _gone, ...stores } = current.stores;
    const { stores: _all, defaultStore, ...rest } = current;
    return ok({
      ...rest,
      ...(Object.keys(stores).length > 0 && { stores }),
      ...(defaultStore !== undefined && defaultStore !== name && { defaultStore }),
    });
  });
  if (!written.ok) return written;

  let id: string | undefined;
  const unpinned = await updateRegistry(io, paths, (registry) => {
    id = registry.stores?.[name];
    if (id === undefined) return ok(registry);
    const { [name]: _gone, ...stores } = registry.stores ?? {};
    const { stores: _all, ...rest } = registry;
    return ok(Object.keys(stores).length > 0 ? { ...rest, stores } : rest);
  });
  if (!unpinned.ok) return unpinned;
  return ok({ name, ...(id !== undefined && { id }), removed });
};
