// Restore's staging records (D60): `plainport restore` is not journaled, so before it makes its staging folder it
// writes `<state>/staging/<op>.json`, naming the folder and the project whose lock it holds while it runs, and removes
// the record once the folder is gone. A crash leaves the record behind; gc then removes the folder once nobody holds
// that project's lock, so no live restore owns it. An onload's staging needs no record: its journal owns it.

import { join } from "node:path";
import { z } from "zod";
import { writeAtomic } from "../atomic.ts";
import { errorCode, type LocalIo, systemErrorCode } from "../io.ts";
import type { PlainportPaths } from "../paths.ts";
import { isUlid, UlidSchema } from "../ulid.ts";

export const StagingRecordSchema = z.strictObject({
  v: z.literal(1),
  op: UlidSchema,
  /** The project whose lock the restore holds while it runs. */
  project: z.strictObject({ id: UlidSchema, address: z.string().min(1) }),
  /** `<parent>/.plainport-staging/<op>`. */
  staging: z.string().min(1),
});
export type StagingRecord = z.infer<typeof StagingRecordSchema>;

const recordsDir = (paths: PlainportPaths): string => join(paths.stateDir, "staging");
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
