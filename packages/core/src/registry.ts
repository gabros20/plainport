// The project registry (DESIGN.md "Local state per machine"): registry.json in the state folder maps each project's
// ULID to where it lives on this device (its root plus a relative path, or a one-off override), its base snapshot
// and its onload time. Roots are named by key for now; root ULIDs arrive with root-created events (run decision
// D22). Writers take registry.json.lock and replace the file atomically. A damaged file is reported, never
// overwritten: the ULIDs in it are the projects' identities.

import { fail, finding, ok, type Result } from "@plainport/contract";
import { z } from "zod";
import { writeAtomic } from "./atomic.ts";
import { describeIssues } from "./config/toml.ts";
import { errorCode, type LocalIo } from "./io.ts";
import { acquireLock, type LockHolder } from "./lock.ts";
import type { PlainportPaths } from "./paths.ts";
import { UlidSchema } from "./ulid.ts";

/** A root's key, as config tables and addresses spell it: a lower-case word. */
export const RootKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "a lower-case word of letters, digits and hyphens, starting with a letter");

/** A project's path inside its root: relative, `/`-separated, no empty, `.` or `..` segments. */
export const RelativePathSchema = z
  .string()
  .regex(
    /^(?!\.\.?(?:\/|$))[^/]+(?:\/(?!\.\.?(?:\/|$))[^/]+)*$/,
    "a relative path such as clients/acme/web, without empty, . or .. segments",
  );

export const RegistryEntrySchema = z.strictObject({
  root: RootKeySchema,
  path: RelativePathSchema,
  /** A one-off local folder (`onload --to`), used instead of the root's binding plus path. */
  override: z.string().min(1).optional(),
  base: UlidSchema.optional(),
  onloadedAt: z.iso.datetime().optional(),
  registeredAt: z.iso.datetime(),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

export const ProjectRegistrySchema = z
  .strictObject({
    v: z.literal(1),
    projects: z.record(UlidSchema, RegistryEntrySchema),
  })
  .meta({ title: "ProjectRegistry", description: "registry.json: this device's projects by ULID" });
export type ProjectRegistry = z.infer<typeof ProjectRegistrySchema>;

const invalid = (path: string, reason: string): Result<never> =>
  fail(
    finding("registry.invalid", {
      message: `${path}, this device's project registry, is not valid: ${reason}`,
      fix: `restore ${path} from a backup, or move it aside and run plainport root scan <root> for each root`,
      paths: [path],
    }),
  );

/** The registry; an empty one before the first scan. */
export const readRegistry = async (io: LocalIo, paths: PlainportPaths): Promise<Result<ProjectRegistry>> => {
  const path = paths.registryFile;
  let text: string;
  try {
    text = await io.fs.readText(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return ok({ v: 1, projects: {} });
    return invalid(path, `it could not be read (${error instanceof Error ? error.message : String(error)})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return invalid(path, `it is not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const checked = ProjectRegistrySchema.safeParse(data);
  return checked.success ? ok(checked.data) : invalid(path, describeIssues(checked.error));
};

const lockedFinding = (holder: LockHolder | undefined, path: string, ours: boolean) =>
  finding("registry.locked", {
    message: ours
      ? "this process already holds registry.json.lock: an update is still running"
      : `registry.json is locked by ${
          holder === undefined ? "an unreadable lock file" : `process ${holder.pid} on ${holder.host}`
        }`,
    fix:
      ours || holder !== undefined
        ? "wait for the running plainport to finish, then re-run"
        : `delete ${path} if no plainport is running, then re-run`,
    paths: [path],
  });

export type RegistryUpdate = (
  registry: ProjectRegistry,
) => Result<ProjectRegistry> | Promise<Result<ProjectRegistry>>;

/** Applies `update` to registry.json under its lock and returns what was written; a refusal writes nothing. */
export const updateRegistry = async (
  io: LocalIo,
  paths: PlainportPaths,
  update: RegistryUpdate,
  options: { timeoutMs?: number } = {},
): Promise<Result<ProjectRegistry>> => {
  const lockPath = `${paths.registryFile}.lock`;
  const writeFailed = (error: unknown): Result<never> =>
    fail(
      finding("config.write-failed", {
        message: `${paths.registryFile} could not be written: ${error instanceof Error ? error.message : String(error)}`,
        fix: `check that ${paths.stateDir} is writable and the disk has space, then re-run`,
        paths: [paths.registryFile],
      }),
    );
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(io, lockPath, { timeoutMs: options.timeoutMs ?? 10_000, held: lockedFinding });
  } catch (error) {
    return writeFailed(error);
  }
  if (!lock.ok) return lock;
  const held = lock.value;
  try {
    const current = await readRegistry(io, paths);
    if (!current.ok) return current;
    const updated = await update(structuredClone(current.value));
    if (!updated.ok) return updated;
    const next = ProjectRegistrySchema.safeParse(updated.value);
    if (!next.success) {
      return fail(
        finding("contract.invalid", {
          message: `the change would make ${paths.registryFile} invalid: ${describeIssues(next.error)}; nothing was written`,
          fix: "this is a bug in the command that made the change; report it with the message above",
          paths: [paths.registryFile],
        }),
      );
    }
    if (!(await held.stillHeld())) {
      return fail(
        finding("registry.locked", {
          message: `${lockPath} was taken over while this change was being made; nothing was written`,
          fix: "re-run",
          paths: [lockPath],
        }),
      );
    }
    try {
      await writeAtomic(io, paths.registryFile, `${JSON.stringify(next.data, null, 2)}\n`);
    } catch (error) {
      return writeFailed(error);
    }
    return ok(next.data);
  } finally {
    await held.release();
  }
};
