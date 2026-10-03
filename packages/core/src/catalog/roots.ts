// Which root ULID a root key means (run decision D22, Task 11). Config and registry.json name roots by key; catalog
// events, stubs and snapshot tags name them by ULID, which a root-created event fixes once for every device. This
// device records the ULID it uses for each key in registry.json (`roots`), so its events keep naming the same root
// even if another device created a root under the same key at the same moment; otherwise the catalog's first
// root-created event for the key decides. A key with neither gets a new ULID and a root-created event from the
// command that first needs one.

import type { ProjectRegistry } from "../registry.ts";
import { type CatalogState, rootIdsForKey } from "./fold.ts";

export const resolveRootId = (
  registry: ProjectRegistry,
  state: CatalogState,
  key: string,
): { id: string; source: "registry" | "catalog" } | undefined => {
  const recorded = registry.roots?.[key];
  if (recorded !== undefined) return { id: recorded, source: "registry" };
  const [first] = rootIdsForKey(state, key);
  return first === undefined ? undefined : { id: first, source: "catalog" };
};
