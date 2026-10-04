// Waits, in tests, for an offload's detached delete to finish (D47, D67): its trash, then its claim, then its journal
// are gone. A test that captures the state after an offload must start from here, or the delete finishing later shows
// up as a change. It fails loudly when the delete does not finish in time.

import { existsSync, readFileSync } from "node:fs";
import { journalFile } from "../journal/index.ts";
import type { PlainportPaths } from "../paths.ts";
import { trashClaimFile } from "../trash-claim.ts";

/**
 * Waits until the offload `op`'s trash, its claim and its journal are all gone; throws after `timeoutMs`. An offload
 * whose copy is deleted names no trash (D77): it is read from the journal while that is there, and once the journal
 * is gone, so are the trash and the claim.
 */
export const settledOffload = async (
  paths: PlainportPaths,
  offloaded: { op: string; trash?: string | undefined },
  timeoutMs = 30_000,
): Promise<void> => {
  const journal = journalFile(paths, offloaded.op);
  let trash = offloaded.trash;
  const left = () => {
    if (trash === undefined && existsSync(journal)) {
      try {
        trash = JSON.parse(readFileSync(journal, "utf8")).trash;
      } catch {
        // Being rewritten; the next look reads it.
      }
    }
    return [...(trash === undefined ? [] : [trash, trashClaimFile(trash)]), journal].filter((p) =>
      existsSync(p),
    );
  };
  const deadline = Date.now() + timeoutMs;
  while (left().length > 0) {
    if (Date.now() > deadline)
      throw new Error(
        `the detached delete of offload ${offloaded.op} did not finish: ${left().join(", ")} still there`,
      );
    await Bun.sleep(10);
  }
};
