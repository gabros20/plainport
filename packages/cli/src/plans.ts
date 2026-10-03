// The plan store the gate asks (run decision D36): the fresh plans saved under plans/, read once before the gate
// runs, since the gate itself is synchronous. A plan approves only the command it was made for.

import { type Env, type LocalIo, listPlans, resolvePaths, systemErrorCode } from "@plainport/core";
import type { PlanStore } from "./registry.ts";

/**
 * Loads the fresh plans on this device. What keeps them from being read (no HOME, an unreadable folder) leaves the
 * store empty: no plan id is approved, so a confirm command then asks for --yes as it would anyway. A bug throws.
 */
export const preloadPlans = async (io: LocalIo, env: Env, now: Date): Promise<PlanStore> => {
  const approved = new Set<string>();
  const paths = resolvePaths(env);
  if (paths.ok) {
    try {
      for (const plan of await listPlans(io, paths.value, now)) approved.add(`${plan.kind} ${plan.id}`);
    } catch (error) {
      // A system error (a folder that cannot be read) approves nothing; anything else is a bug and is thrown again.
      systemErrorCode(error);
    }
  }
  return { approved: (command, id) => approved.has(`${command} ${id}`) };
};
