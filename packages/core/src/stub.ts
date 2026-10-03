// The stub (DESIGN.md "Catalog and data model" → The stub): a small JSON file, `<name>.plainport`, left where an
// offloaded project was, so a person or an agent finds the exact restore command. Address resolution reads it here;
// the offload saga writes it.

import { fail, finding, ok, type Result } from "@plainport/contract";
import { z } from "zod";
import { describeIssues } from "./config/toml.ts";
import type { LocalIo } from "./io.ts";
import { RelativePathSchema, RootKeySchema } from "./registry.ts";
import { UlidSchema } from "./ulid.ts";

export const STUB_SUFFIX = ".plainport";

export const StubSchema = z
  .strictObject({
    plainport: z.literal(1),
    project: UlidSchema,
    root: RootKeySchema,
    rootId: UlidSchema,
    path: RelativePathSchema,
    store: z.string().min(1),
    snapshot: UlidSchema,
    offloadedAt: z.iso.datetime(),
    bytes: z.number().int().nonnegative(),
    restore: z.string().min(1),
  })
  .meta({ title: "Stub", description: "A .plainport stub left where an offloaded project was" });
export type Stub = z.infer<typeof StubSchema>;

export const readStub = async (io: LocalIo, path: string): Promise<Result<Stub>> => {
  const invalid = (reason: string): Result<never> =>
    fail(
      finding("stub.invalid", {
        message: `${path} is not a valid plainport stub: ${reason}`,
        fix: "name the project by its address instead, e.g. plainport onload work:clients/acme/web",
        paths: [path],
      }),
    );
  let data: unknown;
  try {
    data = JSON.parse(await io.fs.readText(path));
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
  const checked = StubSchema.safeParse(data);
  return checked.success ? ok(checked.data) : invalid(describeIssues(checked.error));
};
