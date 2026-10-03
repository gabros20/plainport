// A released trash has one deleter at a time (D64): the detached delete (spawner.ts posixDeleteTrash) first writes
// `<root>/.plainport-trash/<op>.claim` (its pid, host, this host's boot time and when it started), then deletes the
// trash, the claim and the journal, in that order. housekeeping, gc and recover leave a trash whose claim belongs to a
// live process alone, and take it over (deleting the claim with it) only from one that is gone: another host's claim
// cannot be checked and counts as live, a claim from before this host's last boot or of a dead pid is gone, and a
// claim that cannot be read is taken over (the trash is committed and released, so two deleters lose no work).

import { z } from "zod";
import { type LocalIo, systemErrorCode } from "./io.ts";

export const TrashClaimSchema = z
  .strictObject({
    v: z.literal(1),
    pid: z.int().positive(),
    host: z.string().min(1),
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

/** Whether the trash is claimed by a live deleter: `live`, `gone` (taken over), or `none`. */
export const trashClaim = async (
  io: LocalIo,
  trash: string,
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
  if (claim.host !== io.proc.hostname()) return { state: "live", claim };
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
