// This device's identity (DESIGN.md "Local state per machine"): device.json in the state folder holds its ULID,
// role and creation time; public keys join it with the secrets envelope (M3). It is created once, create-only, so
// two processes starting at once agree on one id, and it is never rewritten or replaced: a damaged file is
// reported, because a new id would make this machine a stranger to its own catalog events.

import { dirname } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";
import { z } from "zod";
import { createExclusive } from "./atomic.ts";
import { type Role, RoleSchema } from "./config/schema.ts";
import { describeIssues } from "./config/toml.ts";
import { errorCode, type LocalIo } from "./io.ts";
import type { PlainportPaths } from "./paths.ts";
import { UlidSchema, ulid } from "./ulid.ts";

export const DeviceSchema = z
  .strictObject({
    v: z.literal(1),
    id: UlidSchema,
    role: RoleSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({ title: "Device", description: "device.json: this device's identity" });
export type Device = z.infer<typeof DeviceSchema>;

const invalid = (path: string, reason: string): Result<never> =>
  fail(
    finding("device.invalid", {
      message: `${path}, this device's identity, is not valid: ${reason}`,
      fix: `restore ${path} from a backup; plainport never replaces it, since a new id would orphan this device's history`,
      paths: [path],
    }),
  );

/** This device's identity, or undefined before `plainport init` has created it. */
export const readDevice = async (io: LocalIo, paths: PlainportPaths): Promise<Result<Device | undefined>> => {
  const path = paths.deviceFile;
  let text: string;
  try {
    text = await io.fs.readText(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return ok(undefined);
    return invalid(path, `it could not be read (${error instanceof Error ? error.message : String(error)})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return invalid(path, `it is not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const checked = DeviceSchema.safeParse(data);
  return checked.success ? ok(checked.data) : invalid(path, describeIssues(checked.error));
};

export interface EnsureDeviceOptions {
  /** The role a new identity gets; an existing identity keeps its own (`plainport device role` changes it). */
  role: Role;
  clock?: { now(): Date };
}

/** Returns this device's identity, creating device.json first if there is none. */
export const ensureDevice = async (
  io: LocalIo,
  paths: PlainportPaths,
  options: EnsureDeviceOptions,
): Promise<Result<{ device: Device; created: boolean }>> => {
  const existing = await readDevice(io, paths);
  if (!existing.ok) return existing;
  if (existing.value !== undefined) return ok({ device: existing.value, created: false });

  const now = options.clock?.now() ?? new Date();
  const device: Device = { v: 1, id: ulid(now.getTime()), role: options.role, createdAt: now.toISOString() };
  let created: boolean;
  try {
    await io.fs.mkdirp(dirname(paths.deviceFile));
    created = await createExclusive(io, paths.deviceFile, `${JSON.stringify(device, null, 2)}\n`);
  } catch (error) {
    return fail(
      finding("config.write-failed", {
        message: `${paths.deviceFile} could not be written: ${error instanceof Error ? error.message : String(error)}`,
        fix: `check that ${dirname(paths.deviceFile)} is writable and the disk has space, then re-run`,
        paths: [paths.deviceFile],
      }),
    );
  }
  if (created) return ok({ device, created: true });
  // Another process created it first: theirs is the identity.
  const winner = await readDevice(io, paths);
  if (!winner.ok) return winner;
  return winner.value === undefined
    ? invalid(paths.deviceFile, "it vanished right after another process created it")
    : ok({ device: winner.value, created: false });
};
