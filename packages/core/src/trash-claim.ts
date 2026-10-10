// A released trash has one deleter at a time (D64): the detached delete (spawner.ts posixDeleteTrash) first writes
// `<root>/.plainport-trash/<op>.claim.boot` (its pid, start and this host's boot session, Q5 i), then
// `<op>.claim` (this device's id, its pid, this host's boot time and when it started), then deletes the trash, the
// claim, the `.claim.boot` and the journal, in that order (D67: a crash between the last two leaves a released journal
// whose trash is gone, which housekeeping and gc read as finished and close). housekeeping, gc and recover leave a
// trash alone only while its claim is live: this device's, from this boot, and its pid alive. Anything else is gone and
// taken over, claim included: another device id (journals are per device, so only this device's delete can claim its
// trash), an earlier boot, a dead pid, a claim that cannot be read (the trash is committed and released, so a takeover
// loses no work). A pid reused within one boot keeps a claim live while that process lives (as D63).
//
// "From this boot" is boot.ts's fromThisBoot: by the boot session when the `.claim.boot` beside the claim reads and is
// that claim's (same pid and start) and this host's session can be read, so a clock step cannot make a live claim
// look an earlier boot's; by M1's boot-time rule otherwise. The session lives in a file of its own so the claim keeps
// M1's shape: v0.1.1's strict parser reads a claim it cannot parse as gone, and would then run a second deleter.

import { type Finding, FindingSchema } from "@plainport/contract";
import { z } from "zod";
import { fromThisBoot } from "./boot.ts";
import { type LocalIo, systemErrorCode } from "./io.ts";
import type { HostPorts } from "./ports/host.ts";

export const TrashClaimSchema = z
  .strictObject({
    v: z.literal(1),
    /** This device's id (device.json), which a hostname change does not move. */
    device: z.string().min(1),
    pid: z.int().positive(),
    /** This host's boot time when the claim was written, in epoch milliseconds. */
    bootedAt: z.number(),
    startedAt: z.iso.datetime(),
  })
  .meta({
    title: "TrashClaim",
    description: "<root>/.plainport-trash/<op>.claim: the detached delete deleting that trash (D64)",
  });
export type TrashClaim = z.infer<typeof TrashClaimSchema>;

/** `<root>/.plainport-trash/<op>.claim.boot`: the boot session the claim beside it was written in (Q5 i). */
export const TrashClaimBootSchema = z
  .strictObject({
    v: z.literal(1),
    /** The claim's pid and startedAt: a `.claim.boot` left by another claim (a rollback's deleter) is not this one's. */
    pid: z.int().positive(),
    startedAt: z.iso.datetime(),
    /** HostPorts.bootSession when the claim was written. */
    session: z.string().min(1),
  })
  .meta({
    title: "TrashClaimBoot",
    description:
      "<root>/.plainport-trash/<op>.claim.boot: the boot session of the claim beside it, written before the claim (Q5 i)",
  });
export type TrashClaimBoot = z.infer<typeof TrashClaimBootSchema>;

/** The claim file of a trash folder (`<root>/.plainport-trash/<op>`). */
export const trashClaimFile = (trash: string): string => `${trash}.claim`;

/** The boot session file beside the claim. */
export const trashClaimBootFile = (trash: string): string => `${trash}.claim.boot`;

/** Every file a claim on `trash` may leave: the claim, its `.claim.boot`, and the `.claim.tmp` a delete killed while claiming left. */
export const trashClaimFiles = (trash: string): string[] => [
  trashClaimFile(trash),
  trashClaimBootFile(trash),
  `${trashClaimFile(trash)}.tmp`,
];

/**
 * What reads a claim: the files, this process's view of pids and the boot time, and this host's boot session. An io
 * that is no host port (a read-only view's) has no session, so M1's rule decides there.
 */
export type ClaimIo = LocalIo & Partial<Pick<HostPorts, "bootSession">>;

/** Parsed JSON of `path`, or undefined when it is not there or does not read. */
const readJson = async (io: LocalIo, path: string): Promise<{ found: boolean; value?: unknown }> => {
  try {
    return { found: true, value: JSON.parse(await io.fs.readText(path)) };
  } catch (error) {
    if (error instanceof SyntaxError) return { found: true };
    return { found: systemErrorCode(error) !== "ENOENT" };
  }
};

/** The state of the claim written at `file` (the claim, or a `.claim.tmp`) on `trash`; see trashClaim. */
export const claimAt = async (
  io: ClaimIo,
  file: string,
  trash: string,
  device: string,
): Promise<{ state: "none" | "live" | "gone"; claim?: TrashClaim }> => {
  const read = await readJson(io, file);
  if (!read.found) return { state: "none" };
  const parsed = TrashClaimSchema.safeParse(read.value);
  if (!parsed.success) return { state: "gone" };
  const claim = parsed.data;
  if (claim.device !== device) return { state: "gone", claim };
  const boot = TrashClaimBootSchema.safeParse((await readJson(io, trashClaimBootFile(trash))).value);
  const session =
    boot.success && boot.data.pid === claim.pid && boot.data.startedAt === claim.startedAt
      ? boot.data.session
      : undefined;
  const now = session === undefined ? undefined : await io.bootSession?.();
  if (
    !fromThisBoot(io.proc, { bootedAt: claim.bootedAt, ...(session === undefined ? {} : { session }) }, now)
  )
    return { state: "gone", claim };
  return { state: (await io.proc.isAlive(claim.pid)) ? "live" : "gone", claim };
};

/** Whether the trash is claimed by a live deleter on this device: `live`, `gone` (taken over), or `none`. */
export const trashClaim = (
  io: ClaimIo,
  trash: string,
  device: string,
): Promise<{ state: "none" | "live" | "gone"; claim?: TrashClaim }> =>
  claimAt(io, trashClaimFile(trash), trash, device);

/** The JSON Schema of the trash claim, published in schemas/ by `bun run contract`. */
export const trashClaimJsonSchemas = (): Record<
  "trash-claim" | "trash-claim-boot",
  Record<string, unknown>
> => ({
  "trash-claim": z.toJSONSchema(TrashClaimSchema, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >,
  "trash-claim-boot": z.toJSONSchema(TrashClaimBootSchema, {
    target: "draft-2020-12",
    io: "input",
  }) as Record<string, unknown>,
});

/**
 * `<root>/.plainport-trash/<op>.refused`: the finding of the delete guard's last refusal of that trash (D87), left by
 * the detached delete (which has no one to tell) and by every in-process deleter, so housekeeping, gc and status can
 * say why a released trash stays and how to let it go. Removed with the trash once it is deleted.
 */
export const trashRefusedFile = (trash: string): string => `${trash}.refused`;

/** Leaves the refusal note; best effort, since the refusal itself is what keeps the trash safe. */
export const noteRefusal = async (io: LocalIo, trash: string, refusal: Finding): Promise<void> => {
  try {
    await io.fs.writeTextDurable(trashRefusedFile(trash), `${JSON.stringify(refusal)}\n`);
  } catch (error) {
    systemErrorCode(error);
  }
};

/** The last refusal noted for a trash, if any; a note that does not read is no note. */
export const readRefusal = async (io: LocalIo, trash: string): Promise<Finding | undefined> => {
  try {
    const parsed = FindingSchema.safeParse(JSON.parse(await io.fs.readText(trashRefusedFile(trash))));
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) systemErrorCode(error);
    return undefined;
  }
};
