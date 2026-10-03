// The journal (ADR-0008, DESIGN.md "Local state per machine": `journal/<op>.json`): one small JSON file per running or
// interrupted operation, rewritten atomically at every phase boundary of its saga. It says how far the saga got and
// what it made on the way (snapshots, events, the trash folder), so `plainport recover` can finish an operation that
// passed its commit and roll back one that did not, and so a second run of the same project can see that one is
// still open. A saga removes its journal when it ends cleanly; only a crash, a kill or a lost store leaves one.
//
// Durability (run decision D24): writes are fsync'd and renamed into place, but a power loss can still drop the
// last one, so a journal says what was about to happen as well as what happened: a step that names a write (the
// offloaded event's id before it is appended, the trash path before the rename) lets recovery check the world
// instead of trusting the journal's last word.

import { join } from "node:path";
import { z } from "zod";
import { writeAtomic } from "../atomic.ts";
import { errorCode, type LocalIo, systemErrorCode } from "../io.ts";
import type { PlainportPaths } from "../paths.ts";
import { RelativePathSchema, RootKeySchema } from "../registry.ts";
import { isUlid, UlidSchema } from "../ulid.ts";

/** A step name, as faultAt takes it: dotted lower-case words (offload.release.moved). */
const StepSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/, "a dotted step name");
const ResticIdSchema = z.string().regex(/^[0-9a-f]{64}$/, "a full 64-character restic snapshot id");

export const OffloadJournalSchema = z
  .strictObject({
    v: z.literal(1),
    op: UlidSchema,
    kind: z.literal("offload"),
    /** The last step reached, one of the saga's OFFLOAD_STEPS. */
    step: StepSchema,
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    /** The process that wrote it. */
    pid: z.int().positive(),
    host: z.string().min(1),
    project: z.strictObject({
      id: UlidSchema,
      address: z.string().min(1),
      root: RootKeySchema,
      rootId: UlidSchema,
      path: RelativePathSchema,
      /** The project folder, absolute. */
      dir: z.string().min(1),
    }),
    /** The store by its name in config and the id in its meta/v1/store.json. */
    store: z.strictObject({ name: z.string().min(1), id: UlidSchema }),
    /** The snapshot this working copy came from; none on a first offload. */
    base: UlidSchema.optional(),
    /** The root-created event this operation wrote, when the root had no ULID yet. */
    rootCreated: UlidSchema.optional(),
    /**
     * The plan of the attempt that was verified: its included fingerprint, that fingerprint's kind (D53; absent, an
     * older kind recovery never compares) and the strip set it leaves out, so a re-check needs nothing else.
     */
    plan: z
      .strictObject({
        id: UlidSchema,
        fingerprint: z.string().min(1),
        fp: z.literal(2).optional(),
        excluded: z.array(RelativePathSchema).optional(),
      })
      .optional(),
    /** How release goes, decided with the plan, so recovery repeats it whatever the config says by then. */
    release: z.strictObject({ keepLocalFor: z.string(), stub: z.boolean() }).optional(),
    /** The head moved under this copy: the event (`event`) keeps the snapshot as a fork, and nothing is released. */
    diverged: z.literal(true).optional(),
    /** Every snapshot restic wrote for this operation, in order: a retry after an edit makes a second. */
    attempts: z.array(ResticIdSchema),
    /** The snapshot restic wrote although it failed (exit 3, D28), and the snapshot-discarded event naming it. */
    discarded: z.strictObject({ snapshot: ResticIdSchema, event: UlidSchema }).optional(),
    /** The snapshot that passed verification. */
    verified: ResticIdSchema.optional(),
    /** The offloaded event's id, journaled before it is appended: recovery looks for it on the store. */
    event: UlidSchema.optional(),
    /** `<root>/.plainport-trash/<op>`, journaled before the folder is renamed into it. */
    trash: z.string().min(1).optional(),
    /** The stub written where the folder was. */
    stub: z.string().min(1).optional(),
    /** keepLocalFor: the trash is kept until then, and deleted by gc or recover afterwards. */
    keepUntil: z.iso.datetime().optional(),
    history: z.array(z.strictObject({ step: StepSchema, at: z.iso.datetime() })),
  })
  .meta({ title: "OffloadJournal", description: "journal/<op>.json: an offload's progress, for recover" });
export type OffloadJournal = z.infer<typeof OffloadJournalSchema>;

export const OnloadJournalSchema = z
  .strictObject({
    v: z.literal(1),
    op: UlidSchema,
    kind: z.literal("onload"),
    /** The last step reached, one of the saga's ONLOAD_STEPS. */
    step: StepSchema,
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    pid: z.int().positive(),
    host: z.string().min(1),
    project: z.strictObject({
      id: UlidSchema,
      address: z.string().min(1),
      root: RootKeySchema,
      rootId: UlidSchema,
      path: RelativePathSchema,
      /** The landing folder, absolute: the root's folder plus the path, or --to's. */
      dir: z.string().min(1),
    }),
    store: z.strictObject({ name: z.string().min(1), id: UlidSchema }),
    /** The plainport snapshot restored, and this store's restic id for it. */
    snapshot: UlidSchema,
    stored: ResticIdSchema,
    /** The catalog's head when the onload began (D43): the onloaded event's `over`, and the copy's next base. */
    over: UlidSchema,
    /** `<root>/.plainport-staging/<op>`: where the snapshot is restored and verified before the swap. */
    staging: z.string().min(1).optional(),
    /**
     * The same head's folder still waits in an offload's trash (keepLocalFor): it is renamed back instead of restored.
     * `op` is that offload, whose journal is removed once the folder is back; `folder` is where it waits.
     */
    reuse: z.strictObject({ op: UlidSchema, folder: z.string().min(1) }).optional(),
    /** --to: the landing folder is not the root's place for the project (registry.json records it as override). */
    override: z.literal(true).optional(),
    /** The project's stub, removed after the swap when it is this project's. */
    stub: z.string().min(1).optional(),
    /** The onloaded event's id, journaled before it is appended: recovery looks for it on the store. */
    event: UlidSchema.optional(),
    history: z.array(z.strictObject({ step: StepSchema, at: z.iso.datetime() })),
  })
  .meta({ title: "OnloadJournal", description: "journal/<op>.json: an onload's progress, for recover" });
export type OnloadJournal = z.infer<typeof OnloadJournalSchema>;

export const JournalSchema = z
  .discriminatedUnion("kind", [OffloadJournalSchema, OnloadJournalSchema])
  .meta({ title: "Journal", description: "journal/<op>.json: a running or interrupted operation" });
export type Journal = z.infer<typeof JournalSchema>;

export const journalFile = (paths: PlainportPaths, op: string): string =>
  join(paths.journalDir, `${op}.json`);

/** Writes the journal atomically: a crash leaves the previous version or this one. */
export const writeJournal = async (io: LocalIo, paths: PlainportPaths, journal: Journal): Promise<void> => {
  await io.fs.mkdirp(paths.journalDir);
  await writeAtomic(io, journalFile(paths, journal.op), `${JSON.stringify(journal, null, 2)}\n`);
};

/** Removes the journal; one already gone is fine. */
export const removeJournal = async (io: LocalIo, paths: PlainportPaths, op: string): Promise<void> => {
  try {
    await io.fs.unlink(journalFile(paths, op));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
};

export interface JournalsRead {
  journals: Journal[];
  /** Files named `<ulid>.json` that are not a journal this version reads: never touched, reported by recover. */
  unreadable: string[];
}

/** Every journal on this device, oldest operation first. */
export const readJournals = async (io: LocalIo, paths: PlainportPaths): Promise<JournalsRead> => {
  let names: string[];
  try {
    names = await io.fs.readdir(paths.journalDir);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return { journals: [], unreadable: [] };
    throw error;
  }
  const journals: Journal[] = [];
  const unreadable: string[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || !isUlid(name.slice(0, -".json".length))) continue;
    const path = join(paths.journalDir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await io.fs.readText(path));
    } catch (error) {
      if (error instanceof SyntaxError) parsed = undefined;
      else if (systemErrorCode(error) === "ENOENT") continue;
      else throw error;
    }
    const checked = JournalSchema.safeParse(parsed);
    if (checked.success && checked.data.op === name.slice(0, -".json".length)) journals.push(checked.data);
    else unreadable.push(path);
  }
  return { journals, unreadable };
};

/** JSON Schemas for the journal, published in schemas/ by `bun run contract`. */
export const journalJsonSchemas = (): Record<"journal", Record<string, unknown>> => ({
  journal: z.toJSONSchema(JournalSchema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>,
});
