import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { CATALOG_EVENT_TYPES, CatalogEventSchema, catalogJsonSchemas } from "./index.ts";

const ID = "01J9Z6M8Q4X7E2T5K3B1N0HVWD";
const PROJECT = "01J8A2C4E6G8J0K2M4P6R8T0VW";
const ROOT = "01J6RT7W2K9M4N6P8Q0S2V4X6Z";
const DEVICE = "01J7Q1W3E5R7T9Y1M3N5P7Q9AS";
const OP = "01J9Z6K2B8D4F6H8K0M2P4R6T8";
const BASE = "01J9A1B2C3D4E5F6G7H8J9K0MN";
const RESTIC = "e5f6a7b8".repeat(8);

const common = { v: 1, id: ID, device: DEVICE, at: "2026-09-29T14:02:11Z", op: OP };
const project = { project: PROJECT, root: ROOT, path: "clients/acme/web" };
const stats = { files: 18422, bytes: 1934000000, strippedBytes: 812000000, ecosystems: ["node"] };

/** DESIGN.md "Catalog and data model" → One event, with full restic ids as in practice. */
const designExample = {
  ...common,
  type: "offloaded",
  ...project,
  base: BASE,
  snapshot: OP,
  stored: { mini: RESTIC, b2: "7a746a07".repeat(8) },
  move: { to: "01J7V2P4S6X8Z0B2D4F6H8K0MQ" },
  stats,
};

const valid = {
  registered: { ...common, type: "registered", ...project },
  offloaded: designExample,
  onloaded: { ...common, type: "onloaded", ...project, base: BASE, over: OP },
  checkpointed: {
    ...common,
    type: "checkpointed",
    ...project,
    base: BASE,
    snapshot: OP,
    stored: { ssd: RESTIC },
    stats,
  },
  "snapshot-discarded": {
    ...common,
    type: "snapshot-discarded",
    ...project,
    snapshot: OP,
    stored: { ssd: RESTIC },
  },
  "root-created": { ...common, type: "root-created", root: ROOT, key: "work", label: "Work" },
  "root-bound": { ...common, type: "root-bound", root: ROOT, path: "~/work" },
} as const;

describe("catalog: event schemas", () => {
  test("DESIGN's example offloaded event is valid", () => {
    expect(CatalogEventSchema.safeParse(designExample).success).toBe(true);
  });

  test("every event type in scope has a valid example, and the list of types is exactly those", () => {
    expect([...CATALOG_EVENT_TYPES].sort() as string[]).toEqual(Object.keys(valid).sort());
    for (const [type, event] of Object.entries(valid)) {
      const parsed = CatalogEventSchema.safeParse(event);
      expect({ type, ok: parsed.success }).toEqual({ type, ok: true });
    }
  });

  test("a first offload has no base; an onload always names the snapshot it restored", () => {
    const { base: _, ...first } = designExample;
    expect(CatalogEventSchema.safeParse(first).success).toBe(true);
    const { base: __, ...onload } = valid.onloaded;
    expect(CatalogEventSchema.safeParse(onload).success).toBe(false);
    // D43: `over` (the head the onload was written over) is optional to read, for events written before it.
    const { over: ___, ...older } = valid.onloaded;
    expect(CatalogEventSchema.safeParse(older).success).toBe(true);
  });

  test("events are strict persisted documents: unknown fields, wrong v, bad ids and bad paths are refused", () => {
    const bad = [
      { ...designExample, extra: 1 },
      { ...designExample, v: 2 },
      { ...designExample, id: "not-a-ulid" },
      { ...designExample, snapshot: RESTIC },
      { ...designExample, path: "/abs/path" },
      { ...designExample, path: "a/../b" },
      { ...designExample, stored: { ssd: "abc" } },
      { ...designExample, at: "yesterday" },
      { ...designExample, type: "teleported" },
      { ...designExample, stored: {} },
      { ...valid.checkpointed, stored: {} },
      { ...valid["root-created"], key: "Work Stuff" },
      { ...valid["root-bound"], path: "" },
    ];
    for (const event of bad) expect(CatalogEventSchema.safeParse(event).success).toBe(false);
  });

  test("the published JSON Schemas cover every event type and the state.json cache", () => {
    const schemas = catalogJsonSchemas();
    expect(Object.keys(schemas).sort()).toEqual([
      "catalog-event",
      "catalog-state",
      "event-mirror",
      "store-identity",
    ]);
    const text = JSON.stringify(schemas["catalog-event"]);
    for (const type of CATALOG_EVENT_TYPES) expect(text).toContain(`"${type}"`);
    // D41: a non-empty stored map is published too, not only checked in TypeScript.
    expect(text).toContain('"minProperties":1');
    // Round trip: the JSON Schema is the zod schema's own export.
    expect(schemas["catalog-event"]).toEqual(
      z.toJSONSchema(CatalogEventSchema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>,
    );
  });
});
