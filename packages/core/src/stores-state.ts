// What this device keeps about each store it uses (Q4): `~/.local/state/plainport/stores/<store id>.json`, a sidecar
// keyed by the store's id (D45), never by this device's name for it, so two names for one store share it. v0.1 never
// reads it, which keeps registry.json at v1 and `scripts/install --rollback` working.
//
// It holds the catalog's seal policy as this device first saw it (the pin, Q10), and what was measured of the store:
// its semantics profile with each property's evidence (Q8) and the last `store test`, together with the facts they
// were measured against (the endpoint, how the store is reached, the restic and rclone versions). A measurement holds
// only for those facts: reading with facts that differ in any way leaves `measured` out, and the next record replaces
// it. The pin is a fact about the store, not about how it is reached, so no change of facts drops it.
//
// Every change is a locked read-change-write with an atomic replace (locked-file.ts). A file that cannot be read or is
// not valid is store.state-invalid and is never overwritten, since it may hold the pin.

import { join } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";
import { z } from "zod";
import { type SealPolicy, SealPolicySchema } from "./catalog/identity.ts";
import { describeIssues } from "./config/toml.ts";
import { errorCode, type LocalIo } from "./io.ts";
import { updateLockedFile } from "./locked-file.ts";
import type { PlainportPaths } from "./paths.ts";
import { type StoreSemantics, StoreSemanticsSchema } from "./ports/blob-store.ts";
import { isUlid, UlidSchema } from "./ulid.ts";

/** What a measurement of a store holds for: any change invalidates it. */
export const StoreFactsSchema = z.strictObject({
  /** Where the store is reached: a local path, an sftp host and path, an s3 endpoint, bucket and prefix. */
  endpoint: z.string().min(1),
  /** How this device reaches it: the store's kind in config (local, sftp, s3). */
  access: z.string().min(1),
  /** The restic version measured with. */
  restic: z.string().min(1),
  /** The rclone version measured with, for a store reached through rclone. */
  rclone: z.string().min(1).optional(),
});
export type StoreFacts = z.infer<typeof StoreFactsSchema>;

export const StoreTestSchema = z.strictObject({
  at: z.iso.datetime(),
  ok: z.boolean(),
  /** Whether the probe key could be deleted (Q13); denied is never read as append-only. */
  delete: z.enum(["denied", "allowed", "unreachable"]).optional(),
});
export type StoreTest = z.infer<typeof StoreTestSchema>;

export const StoreStateSchema = z
  .strictObject({
    v: z.literal(1),
    /** The store's id (its meta/v1/store.json); the file is stores/<id>.json. */
    store: UlidSchema,
    /** The catalog's seal policy as this device first saw it (Q10); a store that later shows another is refused. */
    seal: z.strictObject({ policy: SealPolicySchema, at: z.iso.datetime() }).optional(),
    /** What was measured, with the facts it holds for. */
    measured: z
      .strictObject({
        facts: StoreFactsSchema,
        semantics: StoreSemanticsSchema.optional(),
        test: StoreTestSchema.optional(),
      })
      .optional(),
  })
  .meta({
    title: "StoreState",
    description:
      "stores/<store id>.json under plainport's state folder: this device's seal pin, measured semantics and last test for one store (Q4)",
  });
export type StoreState = z.infer<typeof StoreStateSchema>;

/** The sidecar's JSON Schema, published in schemas/ by `bun run contract`. */
export const storeStateJsonSchemas = (): Record<"store-state", Record<string, unknown>> => ({
  "store-state": z.toJSONSchema(StoreStateSchema, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >,
});

/** `<state>/stores/<store id>.json`. Passing anything but a ULID is a bug. */
export const storeStateFile = (paths: PlainportPaths, storeId: string): string => {
  if (!isUlid(storeId))
    throw new RangeError(`storeStateFile: ${JSON.stringify(storeId)} is not a store id (a ULID)`);
  return join(paths.stateDir, "stores", `${storeId}.json`);
};

const sameFacts = (a: StoreFacts, b: StoreFacts): boolean =>
  a.endpoint === b.endpoint && a.access === b.access && a.restic === b.restic && a.rclone === b.rclone;

const invalid = (path: string, reason: string) =>
  fail(
    finding("store.state-invalid", {
      message: `${path}, this device's record of a store, ${reason}; it was left as it is`,
      fix: `restore ${path} from a backup, or move it aside: the store's seal policy is then pinned again at the next contact and its semantics measured again`,
      paths: [path],
    }),
  );

const readFile = async (io: LocalIo, path: string, storeId: string): Promise<Result<StoreState>> => {
  let text: string;
  try {
    text = await io.fs.readText(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return ok({ v: 1, store: storeId });
    return invalid(path, `could not be read (${error instanceof Error ? error.message : String(error)})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return invalid(path, `is not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const checked = StoreStateSchema.safeParse(data);
  if (!checked.success) return invalid(path, `is not valid: ${describeIssues(checked.error)}`);
  if (checked.data.store !== storeId)
    return invalid(path, `names store ${checked.data.store}, not ${storeId}`);
  return ok(checked.data);
};

/**
 * What this device keeps about the store (an empty record when nothing yet). Given the facts the caller reaches the
 * store with now, a measurement made under other facts is left out: it no longer holds.
 */
export const readStoreState = async (
  io: LocalIo,
  paths: PlainportPaths,
  storeId: string,
  facts?: StoreFacts,
): Promise<Result<StoreState>> => {
  const read = await readFile(io, storeStateFile(paths, storeId), storeId);
  if (!read.ok || facts === undefined || read.value.measured === undefined) return read;
  if (sameFacts(read.value.measured.facts, facts)) return read;
  const { measured: _stale, ...rest } = read.value;
  return ok(rest);
};

/** Applies `change` to the store's record under its lock, atomically; returns what was written. */
export const updateStoreState = async (
  io: LocalIo,
  paths: PlainportPaths,
  storeId: string,
  change: (current: StoreState) => Result<StoreState>,
  options: { timeoutMs?: number } = {},
): Promise<Result<StoreState>> => {
  const file = storeStateFile(paths, storeId);
  const lockFile = `${file}.lock`;
  const writeFailed = (path: string, error: unknown) =>
    fail(
      finding("config.write-failed", {
        message: `${path} could not be written: ${error instanceof Error ? error.message : String(error)}`,
        fix: `check that ${paths.stateDir} is writable and the disk has space, then re-run`,
        paths: [path],
      }),
    );
  try {
    await io.fs.mkdirp(join(paths.stateDir, "stores"));
  } catch (error) {
    return writeFailed(join(paths.stateDir, "stores"), error);
  }
  const locked = (message: string, fix: string) =>
    finding("store.locked", { message, fix, paths: [lockFile] });
  return updateLockedFile<StoreState>(
    io,
    {
      file,
      lockFile,
      read: () => readFile(io, file, storeId),
      check: (value) => {
        const next = StoreStateSchema.safeParse(value);
        if (next.success && next.data.store === storeId) return ok(next.data);
        return fail(
          finding("contract.invalid", {
            message: `the change would make ${file} invalid: ${next.success ? `it names store ${next.data.store}` : describeIssues(next.error)}; nothing was written`,
            fix: "this is a bug in the command that made the change; report it with the message above",
            paths: [file],
          }),
        );
      },
      encode: (value) => `${JSON.stringify(value, null, 2)}\n`,
      held: (holder, path, ours) =>
        locked(
          ours
            ? `this process already holds ${path}: an update of store ${storeId}'s record is still running`
            : `store ${storeId}'s record is locked by ${holder === undefined ? "an unreadable lock file" : `process ${holder.pid} on ${holder.host}`}`,
          ours || holder !== undefined
            ? "wait for the running plainport to finish, then re-run"
            : `delete ${path} if no plainport is running, then re-run`,
        ),
      takenOver: locked(
        `${lockFile} was taken over while this change was being made; nothing was written`,
        "re-run",
      ),
      writeFailed,
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    },
    change,
  );
};

/**
 * Records a measurement made under `facts`: merged into the one held when the facts are the same, else replacing it
 * (an older measurement no longer holds).
 */
export const recordMeasured = (
  io: LocalIo,
  paths: PlainportPaths,
  storeId: string,
  facts: StoreFacts,
  found: { semantics?: StoreSemantics; test?: StoreTest },
): Promise<Result<StoreState>> =>
  updateStoreState(io, paths, storeId, (current) => {
    const held =
      current.measured !== undefined && sameFacts(current.measured.facts, facts)
        ? current.measured
        : undefined;
    return ok({ ...current, measured: { ...held, facts, ...found } });
  });

/** The seal policy pinned for the store: the one already pinned, else `policy`, pinned now at `at`. */
export const pinSeal = async (
  io: LocalIo,
  paths: PlainportPaths,
  storeId: string,
  policy: SealPolicy,
  at: string,
): Promise<Result<{ policy: SealPolicy; at: string }>> => {
  const written = await updateStoreState(io, paths, storeId, (current) =>
    ok(current.seal === undefined ? { ...current, seal: { policy, at } } : current),
  );
  return written.ok ? ok(written.value.seal ?? { policy, at }) : written;
};
