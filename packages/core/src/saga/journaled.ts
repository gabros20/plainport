// One saga's journal (ADR-0008, D24): every step is written atomically and then reaches the host's crash seam, and
// one place decides what a failure leaves behind. runSaga runs a saga's body: a failure that comes back before the
// commit has changed nothing local, so its journal is removed; a failure after the commit, or one the body marks with
// keep() because an effect recover must settle may have happened (an append whose outcome is unknown, a snapshot that
// must be recorded), keeps it for `plainport recover`. Exceptions, which are bugs or injected faults (simulated
// crashes), propagate and keep it too. Offload uses it now; onload and recover take the same shape.

import { type Failure, fail, finding, ok, type Result } from "@plainport/contract";
import { assertSystemError, type LocalIo, systemErrorCode } from "../io.ts";
import { type Journal, journalFile, removeJournal, writeJournal } from "../journal/index.ts";
import type { PlainportPaths } from "../paths.ts";

/** fs.write-failed for an expected I/O error (systemErrorCode rethrows anything else, a bug). */
export const writeFailed = (
  error: unknown,
  what: string,
  committed: boolean,
  path: string,
  kind: "offload" | "onload" = "offload",
): Failure => {
  const code = systemErrorCode(error);
  const safe = kind === "offload" ? "the snapshot is committed" : "the files are in place";
  return fail(
    finding("fs.write-failed", {
      message: `${what} failed (${code}): ${(error as Error).message}${committed ? `; ${safe}, and nothing is lost` : "; nothing local was changed"}`,
      fix: committed
        ? `fix what the message names (permissions, free space), then run plainport recover to finish the ${kind}`
        : "fix what the message names (permissions, free space), then re-run",
      paths: [path],
    }),
  );
};

/** The same failure with another fix: the one that is true where it happened. */
export const withFix = (failure: Failure, fix: string): Failure => ({
  ...failure,
  finding: { ...failure.finding, fix },
});

export interface SagaContext {
  /** Which saga: what a failure after the commit says is safe, and which one recover finishes. Default: the journal's. */
  kind?: "offload" | "onload";
  io: LocalIo;
  paths: PlainportPaths;
  /** The host's crash seam. */
  faultAt(point: string): void;
  clock(): Date;
  log(level: "warn", message: string): void;
}

export interface Saga<J extends Journal, S extends string = string> {
  /** The journal as last written, and as the next step will change it. */
  readonly journal: J;
  /** Journals a step, then reaches the crash seam. An I/O error is fs.write-failed, never an exception. */
  step(name: S, change?: Partial<J>): Promise<Result<void>>;
  /**
   * The crash seam right after a side effect, with no journal write: a fault here leaves the effect done and the
   * journal still at the step before it, the state a lost write leaves (D52).
   */
  after(point: string): void;
  /** The commit landed: from here every failure keeps the journal, and fs.write-failed says the snapshot is safe. */
  commit(): void;
  readonly committed: boolean;
  /**
   * Marks a failure before the commit that must keep the journal: recover has something to settle. The mark is a
   * field (keepJournal), so it survives a copy (withFix, a spread).
   */
  keep(failure: Failure): Failure;
  /** Removes the journal now: the run ended with nothing left to recover. */
  close(): Promise<void>;
}

/** Opens a saga on a fresh journal; nothing is written until its first step. */
export const openSaga = <J extends Journal, S extends string = string>(
  ctx: SagaContext,
  journal: J,
): Saga<J, S> => {
  let committed = false;
  return {
    journal,
    async step(name, change = {}) {
      const at = ctx.clock().toISOString();
      Object.assign(journal, change, { step: name, updatedAt: at });
      journal.history.push({ step: name, at });
      try {
        await writeJournal(ctx.io, ctx.paths, journal);
      } catch (error) {
        return writeFailed(
          error,
          `writing the journal at ${name}`,
          committed,
          journalFile(ctx.paths, journal.op),
          ctx.kind ?? journal.kind,
        );
      }
      ctx.faultAt(name);
      return ok(undefined);
    },
    after: (point) => ctx.faultAt(point),
    commit() {
      committed = true;
    },
    get committed() {
      return committed;
    },
    keep: (failure) => ({ ...failure, keepJournal: true }) as Failure,
    async close() {
      try {
        await removeJournal(ctx.io, ctx.paths, journal.op);
      } catch (error) {
        assertSystemError(error);
        ctx.log(
          "warn",
          `the journal ${journalFile(ctx.paths, journal.op)} could not be removed; plainport recover removes it`,
        );
      }
    },
  };
};

/** Runs a saga's body (see the file comment): the one place a failure's journal is kept or removed. */
/** Whether a failure carries keep()'s mark. */
const isKept = (failure: Failure): boolean => (failure as { keepJournal?: unknown }).keepJournal === true;

export const runSaga = async <J extends Journal, T>(
  saga: Saga<J, string>,
  body: () => Promise<Result<T>>,
): Promise<Result<T>> => {
  const result = await body();
  if (!result.ok && !saga.committed && !isKept(result)) await saga.close();
  return result;
};
