// Restore's staging records (D60): `plainport restore` is not journaled, so before it makes its staging folder it
// writes `<state>/staging/<op>.json`, naming the folder and the project whose lock it holds while it runs, and removes
// the record once the folder is gone. A crash leaves the record behind; gc then removes the folder once nobody holds
// that project's lock, so no live restore owns it. An onload's staging needs no record: its journal owns it.
//
// An `onload --to`'s staging holder (`<parent>/.plainport-staging`) is noted in `<state>/staging/holders/` before the
// holder is made: if the onload's journal write is lost (D24) before the registry has an override for that landing,
// nothing else says where its staging folder is. gc looks in every noted holder as in the roots' own. A note only says
// where to look, so it is never removed.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { writeAtomic } from "../atomic.ts";
import { errorCode, type LocalIo, systemErrorCode } from "../io.ts";
import type { PlainportPaths } from "../paths.ts";
import { isUlid, UlidSchema } from "../ulid.ts";

export const StagingRecordSchema = z
  .strictObject({
    v: z.literal(1),
    op: UlidSchema,
    /** The project whose lock the restore holds while it runs. */
    project: z.strictObject({ id: UlidSchema, address: z.string().min(1) }),
    /** `<parent>/.plainport-staging/<op>`. */
    staging: z.string().min(1),
  })
  .meta({
    title: "StagingRecord",
    description: "staging/<op>.json in plainport's state: a restore's staging folder, for gc (D60)",
  });
export type StagingRecord = z.infer<typeof StagingRecordSchema>;

export const StagingHolderSchema = z
  .strictObject({
    v: z.literal(1),
    /** `<parent>/.plainport-staging`, absolute. */
    holder: z.string().min(1),
  })
  .meta({
    title: "StagingHolder",
    description:
      "staging/holders/<sha256>.json in plainport's state: an onload --to's staging holder, for gc",
  });

const recordsDir = (paths: PlainportPaths): string => join(paths.stateDir, "staging");
const holdersDir = (paths: PlainportPaths): string => join(recordsDir(paths), "holders");

/** Notes a staging holder durably, before it is made; the same holder always has the same file. */
export const noteStagingHolder = async (
  io: LocalIo,
  paths: PlainportPaths,
  holder: string,
): Promise<void> => {
  await io.fs.mkdirp(holdersDir(paths));
  const name = `${createHash("sha256").update(holder).digest("hex")}.json`;
  await writeAtomic(io, join(holdersDir(paths), name), `${JSON.stringify({ v: 1, holder })}\n`);
};

/** Every noted holder; a file that is not a note is left alone. */
export const notedStagingHolders = async (io: LocalIo, paths: PlainportPaths): Promise<string[]> => {
  let names: string[];
  try {
    names = await io.fs.readdir(holdersDir(paths));
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return [];
    throw error;
  }
  const holders: string[] = [];
  for (const name of names.sort()) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    try {
      const parsed = StagingHolderSchema.safeParse(
        JSON.parse(await io.fs.readText(join(holdersDir(paths), name))),
      );
      if (parsed.success) holders.push(parsed.data.holder);
    } catch (error) {
      if (!(error instanceof SyntaxError)) systemErrorCode(error);
    }
  }
  return holders;
};
export const stagingRecordFile = (paths: PlainportPaths, op: string): string =>
  join(recordsDir(paths), `${op}.json`);

/** Writes the record durably, before the staging folder exists. */
export const writeStagingRecord = async (
  io: LocalIo,
  paths: PlainportPaths,
  record: StagingRecord,
): Promise<void> => {
  await io.fs.mkdirp(recordsDir(paths));
  await writeAtomic(io, stagingRecordFile(paths, record.op), `${JSON.stringify(record)}\n`);
};

export const removeStagingRecord = async (io: LocalIo, paths: PlainportPaths, op: string): Promise<void> => {
  try {
    await io.fs.unlink(stagingRecordFile(paths, op));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
};

/** Every readable record; a file that is not one is left alone. */
export const readStagingRecords = async (io: LocalIo, paths: PlainportPaths): Promise<StagingRecord[]> => {
  let names: string[];
  try {
    names = await io.fs.readdir(recordsDir(paths));
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return [];
    throw error;
  }
  const records: StagingRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || !isUlid(name.slice(0, -".json".length))) continue;
    try {
      const parsed = StagingRecordSchema.safeParse(
        JSON.parse(await io.fs.readText(join(recordsDir(paths), name))),
      );
      if (parsed.success) records.push(parsed.data);
    } catch (error) {
      if (!(error instanceof SyntaxError)) systemErrorCode(error);
    }
  }
  return records;
};

/**
 * Removes a shared holder (`.plainport-staging`) only when it is empty, by rmdir, which leaves it in place as soon as
 * another operation has put its own folder there.
 */
export const removeHolderIfEmpty = async (io: LocalIo, holder: string): Promise<void> => {
  try {
    await io.fs.rmdir(holder);
  } catch (error) {
    const code = systemErrorCode(error);
    if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw error;
  }
};

/** The JSON Schemas of the staging record and holder note, published in schemas/ by `bun run contract`. */
export const stagingJsonSchemas = (): Record<
  "staging-record" | "staging-holder",
  Record<string, unknown>
> => ({
  "staging-record": z.toJSONSchema(StagingRecordSchema, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >,
  "staging-holder": z.toJSONSchema(StagingHolderSchema, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >,
});
