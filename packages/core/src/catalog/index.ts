// The catalog (DESIGN.md "Catalog and data model", ADR-0009): event schemas, the pure fold, and events on a store.

import { z } from "zod";
import { CatalogEventSchema } from "./events.ts";
import { StateCacheSchema } from "./log.ts";

export * from "./events.ts";
export * from "./fold.ts";
export * from "./log.ts";
export * from "./roots.ts";

/** JSON Schemas for the catalog's persisted files, published in schemas/ by `bun run contract`. */
export const catalogJsonSchemas = (): Record<"catalog-event" | "catalog-state", Record<string, unknown>> => {
  const schema = (s: z.ZodType) =>
    z.toJSONSchema(s, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
  return { "catalog-event": schema(CatalogEventSchema), "catalog-state": schema(StateCacheSchema) };
};
