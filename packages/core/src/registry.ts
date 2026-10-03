// The project registry (DESIGN.md "Local state per machine"): registry.json in the state folder maps each project's
// ULID to where it lives on this device (its root plus a relative path, or a one-off override), its base snapshot
// and its onload time. Roots are named by key for now; root ULIDs arrive with root-created events (run decision
// D22). Writers take registry.json.lock and replace the file atomically. A damaged file is reported, never
// overwritten: the ULIDs in it are the projects' identities.

import { fail, finding, ok, type Result } from "@plainport/contract";
import { z } from "zod";
import { describeIssues } from "./config/toml.ts";
import { errorCode, type LocalIo } from "./io.ts";
import type { LockHolder } from "./lock.ts";
import { updateLockedFile } from "./locked-file.ts";
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
    // The file may be fine: only reading it failed, so the fix is about access, never about moving it aside.
    return fail(
      finding("registry.unreadable", {
        message: `${path}, this device's project registry, could not be read: ${error instanceof Error ? error.message : String(error)}`,
        fix: `check that you own ${path} and can read and write it (chmod u+rw ${path}), then re-run`,
        paths: [path],
      }),
    );
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

/** Applies `update` to registry.json under its lock (updateLockedFile) and returns what was written. */
export const updateRegistry = async (
  io: LocalIo,
  paths: PlainportPaths,
  update: RegistryUpdate,
  options: { timeoutMs?: number } = {},
): Promise<Result<ProjectRegistry>> => {
  const lockFile = `${paths.registryFile}.lock`;
  return updateLockedFile<ProjectRegistry>(
    io,
    {
      file: paths.registryFile,
      lockFile,
      read: () => readRegistry(io, paths),
      check: (value) => {
        const next = ProjectRegistrySchema.safeParse(value);
        if (next.success) return ok(next.data);
        return fail(
          finding("contract.invalid", {
            message: `the change would make ${paths.registryFile} invalid: ${describeIssues(next.error)}; nothing was written`,
            fix: "this is a bug in the command that made the change; report it with the message above",
            paths: [paths.registryFile],
          }),
        );
      },
      encode: (value) => `${JSON.stringify(value, null, 2)}\n`,
      held: lockedFinding,
      takenOver: finding("registry.locked", {
        message: `${lockFile} was taken over while this change was being made; nothing was written`,
        fix: "re-run",
        paths: [lockFile],
      }),
      writeFailed: (path, error) =>
        fail(
          finding("config.write-failed", {
            message: `${path} could not be written: ${error instanceof Error ? error.message : String(error)}`,
            fix: `check that ${paths.stateDir} is writable and the disk has space, then re-run`,
            paths: [path],
          }),
        ),
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    },
    update,
  );
};
