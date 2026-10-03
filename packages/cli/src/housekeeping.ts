// Housekeeping at the start of every command but help, version and init (D59): core's housekeeping hands released
// trash past its keepLocalFor deadline to the detached delete, and names each interrupted operation on stderr with
// `plainport recover`, which is the only thing that replays a journal. It never fails or delays the command beyond
// reading the journals: what it cannot do now is left to gc and recover.

import { housekeeping } from "@plainport/core";
import type { CommandContext } from "./registry.ts";

/** Commands that run before there is anything to keep, or that only describe plainport. */
const SKIPPED: ReadonlySet<string> = new Set(["help", "version", "init"]);

export const housekeep = async (command: string, ctx: CommandContext): Promise<void> => {
  if (SKIPPED.has(command)) return;
  const paths = ctx.paths();
  if (!paths.ok) return;
  try {
    const done = await housekeeping({
      host: ctx.system,
      paths: paths.value,
      env: ctx.env,
      log: (level, message) => ctx.output.log(level, message),
      now: () => ctx.clock.now(),
    });
    // recover settles them itself; telling it to run recover is noise.
    if (command !== "recover") for (const notice of done.notices) ctx.output.log("warn", notice);
    for (const item of done.started)
      ctx.output.log(
        "info",
        `deleting ${item.trash}, the trash of ${item.project}, past its keepLocalFor deadline`,
      );
  } catch (error) {
    ctx.output.log(
      "warn",
      `housekeeping was skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
