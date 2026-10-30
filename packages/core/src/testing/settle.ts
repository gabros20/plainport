// Waits, in tests, for an offload's detached delete to finish (D47, D67): its trash, then its claim, then its journal
// are gone, and last the trash holder, when the delete left it empty. A test that captures the state after an offload must start from here, or the delete finishing later shows
// up as a change. It fails loudly when the delete does not finish in time.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { journalFile } from "../journal/index.ts";
import type { PlainportPaths } from "../paths.ts";
import { trashClaimFile } from "../trash-claim.ts";

/**
 * Waits until the offload `op`'s trash, its claim and its journal are all gone, then until its `.plainport-trash`
 * holder is gone or holds something else (the delete removes it last, only when empty); throws after `timeoutMs`. An
 * offload whose copy is deleted names no trash (D77): it is read from the journal while that is there, and once the
 * journal is gone, so are the trash and the claim (the holder is then not known, and not waited for).
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
  /** The holder, while it stands empty: the delete has yet to remove it. */
  const holder = (): string[] => {
    if (trash === undefined || basename(dirname(trash)) !== ".plainport-trash") return [];
    try {
      return readdirSync(dirname(trash)).length === 0 ? [dirname(trash)] : [];
    } catch {
      return []; // gone
    }
  };
  const deadline = Date.now() + timeoutMs;
  while (left().length > 0 || holder().length > 0) {
    if (Date.now() > deadline)
      throw new Error(
        `the detached delete of offload ${offloaded.op} did not finish: ${[...left(), ...holder()].join(", ")} still there`,
      );
    await Bun.sleep(10);
  }
};
