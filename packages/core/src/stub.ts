// The stub (DESIGN.md "Catalog and data model" → The stub): a small JSON file, `<name>.plainport`, left where an
// offloaded project was, so a person or an agent finds the exact restore command. Address resolution reads it here;
// the offload saga writes it.

import { fail, finding, ok, type Result } from "@plainport/contract";
import { z } from "zod";
import { createExclusive } from "./atomic.ts";
import { describeIssues } from "./config/toml.ts";
import { type LocalIo, systemErrorCode } from "./io.ts";
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

/** Where an exclusive create cannot link (exFAT, FAT), an O_EXCL open does the same. */
const NO_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/** Creates `path` with `text` only if nothing is there: true if it did. Rejects with other I/O errors. */
const createOnly = async (io: LocalIo, path: string, text: string): Promise<boolean> => {
  try {
    return await createExclusive(io, path, text);
  } catch (error) {
    if (!NO_LINKS.has(systemErrorCode(error))) throw error;
  }
  try {
    await io.fs.writeBytesDurable(path, new TextEncoder().encode(text), { exclusive: true });
    return true;
  } catch (error) {
    if (systemErrorCode(error) === "EEXIST") return false;
    throw error;
  }
};

export type StubPlacement =
  | { placed: true }
  /** Something else is at the path and was left as it is; `aside` names where it waits if it could not go back. */
  | { placed: false; aside?: string };

/**
 * Writes the stub at `path` (D47, D48): created exclusively when nothing is there; where this project's own stub
 * stands, that one is moved aside, compared, and replaced. Anything else, of any kind and whenever it appears, is
 * never overwritten: a foreign file moved aside for the comparison goes back by a link that cannot replace what may
 * have appeared meanwhile. Rejects only with an I/O error (systemErrorCode rethrows a bug).
 */
export const placeStub = async (
  io: LocalIo,
  path: string,
  stub: Stub,
  op: string,
): Promise<StubPlacement> => {
  const text = `${JSON.stringify(stub, null, 2)}\n`;
  if (await createOnly(io, path, text)) return { placed: true };
  let kind: string;
  try {
    kind = (await io.fs.lstat(path)).kind;
  } catch (error) {
    if (systemErrorCode(error) !== "ENOENT") throw error;
    return { placed: await createOnly(io, path, text) };
  }
  // Only a regular file can be a stub; a FIFO, a socket or a folder is never opened or moved.
  if (kind !== "file") return { placed: false };
  const aside = `${path}.${op}.aside`;
  try {
    await io.fs.rename(path, aside);
  } catch (error) {
    if (systemErrorCode(error) !== "ENOENT") throw error;
    return { placed: await createOnly(io, path, text) };
  }
  const old = await readStub(io, aside);
  if (old.ok && old.value.project === stub.project) {
    const placed = await createOnly(io, path, text);
    await io.fs.unlink(aside);
    return { placed };
  }
  try {
    await io.fs.link(aside, path);
  } catch (error) {
    const code = systemErrorCode(error);
    if (code === "EEXIST") return { placed: false, aside };
    if (!NO_LINKS.has(code)) throw error;
    // No hard links here: put it back by rename only while the path is still free.
    try {
      await io.fs.lstat(path);
      return { placed: false, aside };
    } catch (missing) {
      if (systemErrorCode(missing) !== "ENOENT") throw missing;
      await io.fs.rename(aside, path);
      return { placed: false };
    }
  }
  await io.fs.unlink(aside);
  return { placed: false };
};
