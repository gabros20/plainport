// Catalog events (DESIGN.md "Catalog and data model", ADR-0009): small immutable JSON files, one per event, named
// by the event's ULID under `meta/v1/events/` on each store. They are persisted public data, so each carries `v` and
// the schemas are strict (run decision D16): a newer writer bumps `v` rather than adding a field an older reader
// would refuse. These are the types M1 writes; the rest of DESIGN's list (renamed, resolved, lease-broken, …) arrives
// with the milestones that write them, and until then a reader skips them (catalog.event-skipped).
//
// `snapshot-discarded` (run decision D28) names a snapshot restic wrote although the offload failed (exit 3): it
// stays in an append-only repository, so the catalog records that it is never a head.

import { z } from "zod";
import { RelativePathSchema, RootKeySchema } from "../registry.ts";
import { UlidSchema } from "../ulid.ts";

/** A full restic snapshot id, as each store's repository names its copy of a snapshot. */
const ResticIdSchema = z.string().regex(/^[0-9a-f]{64}$/, "a full 64-character restic snapshot id");

const common = {
  v: z.literal(1),
  /** The event's ULID; the file is `<id>.json`. */
  id: UlidSchema,
  /** The device that wrote the event. */
  device: UlidSchema,
  /** When, by the writer's clock: for display only, the fold never orders by it. */
  at: z.iso.datetime(),
  /** The operation that wrote it. */
  op: UlidSchema,
};

const project = {
  project: UlidSchema,
  root: UlidSchema,
  path: RelativePathSchema,
};

/** Each store's own restic id for the snapshot (`restic copy` gives it a new one in every repository). */
const stored = z.record(z.string().min(1), ResticIdSchema);
/** A snapshot an event says was made is stored somewhere: at least one entry (D41). */
const storedSomewhere = stored
  .refine((map) => Object.keys(map).length > 0, "names at least one store")
  .meta({ minProperties: 1 });

const snapshotFields = {
  /** The snapshot this one was made from: the working copy's onloaded or checkpointed snapshot. None on a first offload. */
  base: UlidSchema.optional(),
  /** The plainport snapshot id: the ULID of the operation that made it. */
  snapshot: UlidSchema,
  stored: storedSomewhere,
  stats: z.strictObject({
    files: z.int().nonnegative(),
    bytes: z.int().nonnegative(),
    strippedBytes: z.int().nonnegative(),
    ecosystems: z.array(z.string().min(1)),
  }),
};

export const RegisteredEventSchema = z.strictObject({ ...common, type: z.literal("registered"), ...project });

export const OffloadedEventSchema = z.strictObject({
  ...common,
  type: z.literal("offloaded"),
  ...project,
  ...snapshotFields,
  /** A move: the device the project goes to, whose onloaded event follows. */
  move: z.strictObject({ to: UlidSchema }).optional(),
});

export const OnloadedEventSchema = z.strictObject({
  ...common,
  type: z.literal("onloaded"),
  ...project,
  /** The snapshot restored. The event opens this device's lease. */
  base: UlidSchema,
  /**
   * The catalog's head when the event was written (D43). The fold places the onload after it, so onloading an older
   * snapshot (onload --snapshot) holds the lease like any onload, and the copy's next offload is made from it.
   * Optional to read; appendEvent requires it on every new onloaded event.
   */
  over: UlidSchema.optional(),
});

export const CheckpointedEventSchema = z.strictObject({
  ...common,
  type: z.literal("checkpointed"),
  ...project,
  ...snapshotFields,
});

export const SnapshotDiscardedEventSchema = z.strictObject({
  ...common,
  type: z.literal("snapshot-discarded"),
  ...project,
  snapshot: UlidSchema,
  stored,
});

export const RootCreatedEventSchema = z.strictObject({
  ...common,
  type: z.literal("root-created"),
  root: UlidSchema,
  key: RootKeySchema,
  label: z.string().min(1).optional(),
});

export const RootBoundEventSchema = z.strictObject({
  ...common,
  type: z.literal("root-bound"),
  root: UlidSchema,
  /** The root's folder on the writing device, as its config spells it (`~/work`). */
  path: z.string().min(1),
});

export const CatalogEventSchema = z
  .discriminatedUnion("type", [
    RegisteredEventSchema,
    OffloadedEventSchema,
    OnloadedEventSchema,
    CheckpointedEventSchema,
    SnapshotDiscardedEventSchema,
    RootCreatedEventSchema,
    RootBoundEventSchema,
  ])
  .meta({ title: "CatalogEvent", description: "One catalog event: meta/v1/events/<id>.json on a store" });
export type CatalogEvent = z.infer<typeof CatalogEventSchema>;
export type CatalogEventType = CatalogEvent["type"];

export const CATALOG_EVENT_TYPES: readonly CatalogEventType[] = Object.freeze([
  "registered",
  "offloaded",
  "onloaded",
  "checkpointed",
  "snapshot-discarded",
  "root-created",
  "root-bound",
]);

export type ProjectEvent = Extract<CatalogEvent, { project: string }>;
export type RootEvent = Exclude<CatalogEvent, ProjectEvent>;
