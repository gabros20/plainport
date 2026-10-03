// A released trash has one deleter at a time (D64): the detached delete (spawner.ts posixDeleteTrash) first writes
// `<root>/.plainport-trash/<op>.claim` (this device's id, its pid, this host's boot time and when it started), then
// deletes the trash, the claim and the journal, in that order (D67: a crash between the last two leaves a released
// journal whose trash is gone, which housekeeping and gc read as finished and close). housekeeping, gc and recover leave a trash alone only
// while its claim is live: this device's, from this boot, and its pid alive. Anything else is gone and taken over,
// claim included: another device id (journals are per device, so only this device's delete can claim its trash), an
// earlier boot, a dead pid, a claim that cannot be read (the trash is committed and released, so a takeover loses no
// work). A pid reused within one boot keeps a claim live while that process lives (as D63).

import { z } from "zod";
import { type LocalIo, systemErrorCode } from "./io.ts";

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

/** The claim file of a trash folder (`<root>/.plainport-trash/<op>`). */
export const trashClaimFile = (trash: string): string => `${trash}.claim`;

/** Boot times computed at different moments differ by the clock's drift against uptime; a reboot moves it far more. */
const SAME_BOOT_MS = 120_000;

/** Whether the trash is claimed by a live deleter on this device: `live`, `gone` (taken over), or `none`. */
export const trashClaim = async (
  io: LocalIo,
  trash: string,
  device: string,
): Promise<{ state: "none" | "live" | "gone"; claim?: TrashClaim }> => {
  let text: string;
  try {
    text = await io.fs.readText(trashClaimFile(trash));
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return { state: "none" };
    return { state: "gone" };
  }
  let claim: TrashClaim;
  try {
    const parsed = TrashClaimSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { state: "gone" };
    claim = parsed.data;
  } catch {
    return { state: "gone" };
  }
  if (claim.device !== device) return { state: "gone", claim };
  if (Math.abs(claim.bootedAt - io.proc.bootedAtMs()) > SAME_BOOT_MS) return { state: "gone", claim };
  return { state: (await io.proc.isAlive(claim.pid)) ? "live" : "gone", claim };
};

/** The JSON Schema of the trash claim, published in schemas/ by `bun run contract`. */
export const trashClaimJsonSchemas = (): Record<"trash-claim", Record<string, unknown>> => ({
  "trash-claim": z.toJSONSchema(TrashClaimSchema, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >,
});
