// The conflict grace on a clock no step moves (review r2 M2; DESIGN.md "Held trash"). The grace's deadline is a wall
// time in the journal (keepUntil), which a forward step of the clock (an NTP correction after sleep, a manual change)
// would bring forward, and with it the checked read and Q21's proof. Beside the journal, `<op>.held` records the same
// deadline on this boot's uptime: while the host has not rebooted, the checked read also waits until the uptime has
// passed it. Across a reboot only the wall clock counts (the residual DESIGN states). The file is a sidecar, never
// read by v0.1.1 (it reads only `<ulid>.json`), and goes with the journal (removeJournal).

import { z } from "zod";
import { errorCode, type LocalIo } from "../io.ts";
import type { PlainportPaths } from "../paths.ts";

const HeldClockSchema = z.strictObject({
  v: z.literal(1),
  /** HostPorts.bootSession when it was written. */
  boot: z.string().min(1),
  /** The deadline, in this boot's uptime milliseconds. */
  until: z.number().int().nonnegative(),
});

/** `<journal dir>/<op>.held`. */
export const heldClockFile = (paths: PlainportPaths, op: string): string => `${paths.journalDir}/${op}.held`;

/**
 * This host's uptime at `now`, in milliseconds: the clock's time less the boot time the host computes from it, so a
 * step of the wall clock moves both and leaves the uptime as it was (a stepped test clock without a step of the boot
 * time stands for time that really passed).
 */
const uptimeMs = (io: LocalIo, now: Date): number => now.getTime() - io.proc.bootedAtMs();

/** Records `deadline` (a wall time) on this boot's uptime; best effort, since the wall deadline still holds. */
export const recordHeldClock = async (
  io: LocalIo,
  paths: PlainportPaths,
  op: string,
  boot: string | undefined,
  deadline: string,
  now: Date,
): Promise<void> => {
  if (boot === undefined) return;
  const until = Math.max(0, Math.round(uptimeMs(io, now) + (Date.parse(deadline) - now.getTime())));
  try {
    await io.fs.writeTextDurable(heldClockFile(paths, op), `${JSON.stringify({ v: 1, boot, until })}\n`);
  } catch (error) {
    errorCode(error);
  }
};

/**
 * How long the grace still runs on this boot's uptime, in milliseconds: 0 when it has passed, when no record is there,
 * or when the host has rebooted since it was written (the wall clock alone then decides).
 */
export const heldClockRemaining = async (
  io: LocalIo,
  paths: PlainportPaths,
  op: string,
  boot: string | undefined,
  now: Date,
): Promise<number> => {
  if (boot === undefined) return 0;
  let parsed: z.infer<typeof HeldClockSchema>;
  try {
    const read = HeldClockSchema.safeParse(JSON.parse(await io.fs.readText(heldClockFile(paths, op))));
    if (!read.success) return 0;
    parsed = read.data;
  } catch (error) {
    if (!(error instanceof SyntaxError)) errorCode(error);
    return 0;
  }
  if (parsed.boot !== boot) return 0;
  return Math.max(0, parsed.until - uptimeMs(io, now));
};
