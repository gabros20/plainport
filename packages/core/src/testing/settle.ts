// Waits, in tests, for an offload's detached delete to finish (D47, D67): its trash, then its claim, then its journal
// are gone. A test that captures the state after an offload must start from here, or the delete finishing later shows
// up as a change. It fails loudly when the delete does not finish in time.

import { existsSync } from "node:fs";
import { journalFile } from "../journal/index.ts";
import type { PlainportPaths } from "../paths.ts";
import { trashClaimFile } from "../trash-claim.ts";

/** Waits until the offload `op`'s trash, its claim and its journal are all gone; throws after `timeoutMs`. */
export const settledOffload = async (
  paths: PlainportPaths,
  offloaded: { op: string; trash: string },
  timeoutMs = 30_000,
): Promise<void> => {
  const left = () =>
    [offloaded.trash, trashClaimFile(offloaded.trash), journalFile(paths, offloaded.op)].filter((p) =>
      existsSync(p),
    );
  const deadline = Date.now() + timeoutMs;
  while (left().length > 0) {
    if (Date.now() > deadline)
      throw new Error(
        `the detached delete of offload ${offloaded.op} did not finish: ${left().join(", ")} still there`,
      );
    await Bun.sleep(10);
  }
};
