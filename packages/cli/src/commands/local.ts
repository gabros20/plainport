// What commands that work on this device's roots share: its paths and its identity.

import { type Finding, FindingSchema, fail, finding, ok, type Result } from "@plainport/contract";
import { type Device, type PlainportPaths, readDevice } from "@plainport/core";
import { z } from "zod";
import type { CommandContext } from "../registry.ts";

/** This device's paths and identity; device.none before `plainport init` has created it. */
export const thisDevice = async (
  ctx: CommandContext,
): Promise<Result<{ paths: PlainportPaths; device: Device }>> => {
  const paths = ctx.paths();
  if (!paths.ok) return paths;
  const device = await readDevice(ctx.io, paths.value);
  if (!device.ok) return device;
  if (device.value === undefined) {
    return fail(
      finding("device.none", {
        message: "this device has no plainport identity yet, so it has no folder for any root",
        fix: "run plainport init first; plainport help init shows its flags",
      }),
    );
  }
  return ok({ paths: paths.value, device: device.value });
};

export const FindingsSchema = z.array(FindingSchema);

/** Warnings and their fixes, one per line, for human output. */
export const findingLines = (findings: readonly Finding[]): string[] =>
  findings.flatMap((f) => [
    `${f.severity}  ${f.code}  ${f.message}`,
    ...(f.fix === undefined ? [] : [`  fix: ${f.fix}`]),
  ]);
