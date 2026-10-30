// `plainport store list` (DESIGN.md "Core API" stores.list, Q13: read): every configured store with where it is, which
// file defines it, the id this device pinned for it (D85), the roots that send snapshots there, and the last `store
// test` this device recorded for it, when that measurement still holds for how the store is reached now (Q4). It only
// reads; with a probe it also asks each store whether it answers, still writing nothing.

import { type Finding, ok, type Result } from "@plainport/contract";
import { ConfigLoader } from "../config/load.ts";
import { type ConfigLayer, ConfigLayerSchema, type Store } from "../config/schema.ts";
import { readTomlFile } from "../config/toml.ts";
import type { LocalIo } from "../io.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import { readRegistry } from "../registry.ts";
import { readStoreState, type StoreTest } from "../stores-state.ts";
import { storeFacts, storeLocation, type ToolVersions } from "./location.ts";
import type { Probe } from "./reach.ts";

export type StoreListing = {
  name: string;
  kind: Store["kind"];
  /** Where the store is, never a secret. */
  location: string;
  /** Which file defines it. */
  source: "config" | "managed" | "both";
  /** The default store: roots that name none send their snapshots here. */
  default: boolean;
  /** The id this device pinned for the name (D85); absent before this device set the store up. */
  id?: string;
  /** The roots whose snapshots go here. */
  roots: string[];
  /** The last `store test` here, when its measurement holds for how the store is reached now. */
  lastTest?: StoreTest;
  /** --probe: whether it answered, and what it says it is. */
  probe?:
    | { reachable: true; format?: 1 | 2; id?: string; pinned: boolean }
    | { reachable: false; finding: Finding };
};

/** The two files' tables as written; a file that is missing or broken reads as empty here (the loader reports it). */
export const configLayers = async (
  io: LocalIo,
  paths: PlainportPaths,
): Promise<{ user: ConfigLayer; managed: ConfigLayer }> => {
  const read = async (path: string): Promise<ConfigLayer> => {
    const result = await readTomlFile(io, path, ConfigLayerSchema);
    return result.kind === "ok" ? result.value : {};
  };
  return { user: await read(paths.configFile), managed: await read(paths.managedFile) };
};

export interface ListStoresOptions {
  paths: PlainportPaths;
  env: Env;
  tools: ToolVersions;
  /** Probes one store (probeStore); without it nothing is reached. */
  probe?: (name: string, store: Store) => Promise<Probe>;
}

export const listStores = async (
  io: LocalIo,
  options: ListStoresOptions,
): Promise<Result<{ stores: StoreListing[]; findings: Finding[] }>> => {
  const { paths } = options;
  const loaded = await new ConfigLoader(io, paths).load({ env: options.env });
  if (!loaded.ok) return loaded;
  const { config, findings } = loaded.value;
  const registry = await readRegistry(io, paths);
  if (!registry.ok) return registry;
  const { user, managed } = await configLayers(io, paths);
  const stores: StoreListing[] = [];
  for (const [name, store] of Object.entries(config.stores).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const inUser = user.stores?.[name] !== undefined;
    const inManaged = managed.stores?.[name] !== undefined;
    const id = registry.value.stores?.[name];
    const roots = Object.entries(config.roots)
      .filter(([, root]) => (root.store ?? config.defaultStore) === name)
      .map(([key]) => key);
    let lastTest: StoreTest | undefined;
    if (id !== undefined) {
      const state = await readStoreState(io, paths, id, storeFacts(store, paths.home, options.tools));
      if (!state.ok) findings.push(state.finding);
      else lastTest = state.value.measured?.test;
    }
    let probe: StoreListing["probe"];
    if (options.probe !== undefined) {
      const found = await options.probe(name, store);
      probe = found.reachable
        ? {
            reachable: true,
            ...(found.descriptor !== null && { format: found.descriptor.format, id: found.descriptor.id }),
            pinned: id !== undefined && found.descriptor?.id === id,
          }
        : { reachable: false, finding: found.finding };
    }
    stores.push({
      name,
      kind: store.kind,
      location: storeLocation(store, paths.home),
      source: inUser && inManaged ? "both" : inUser ? "config" : "managed",
      default: config.defaultStore === name,
      ...(id !== undefined && { id }),
      roots,
      ...(lastTest !== undefined && { lastTest }),
      ...(probe !== undefined && { probe }),
    });
  }
  return ok({ stores, findings: [...findings] });
};
