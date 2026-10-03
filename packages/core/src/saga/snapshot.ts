// An offload's snapshot (DESIGN.md "Offload process" step 6): restic backs the folder up with the strip set as
// excludes, the previous snapshot as its parent and plainport's tags, journaled before (snapshot.start) and after
// (snapshot.done, the restic id added to `attempts`). Restic's exit 3 is never a partial success (D28): the snapshot
// it wrote anyway is journaled and named by a snapshot-discarded event, so it can never become a head.

import type { Failure, Result } from "@plainport/contract";
import { ok } from "@plainport/contract";
import { appendEvent, type EventLog } from "../catalog/log.ts";
import type { OffloadJournal } from "../journal/index.ts";
import type { Engine, RunContext } from "../ports/engine.ts";
import { ulid } from "../ulid.ts";
import { type Saga, withFix } from "./journaled.ts";

export interface SnapshotRequest {
  saga: Saga<OffloadJournal>;
  engine: Engine;
  events: EventLog;
  /** This device's id, for the snapshot-discarded event. */
  device: string;
  clock(): Date;
  log(level: "warn", message: string): void;
  excludes: readonly string[];
  /** The restic id of the snapshot this one follows. */
  parent?: string;
  ctx: RunContext;
  /** The failure a cancelled snapshot reports. */
  cancelled(): Failure;
}

/** Takes the snapshot; its restic id, or the failure (kept for recover when restic wrote one anyway). */
export const takeSnapshot = async (req: SnapshotRequest): Promise<Result<string>> => {
  const { saga } = req;
  const { op, project, store } = saga.journal;
  const starting = await saga.step("offload.snapshot.start");
  if (!starting.ok) return starting;
  const made = await req.engine.snapshot(
    {
      dir: project.dir,
      excludes: [...req.excludes],
      ...(req.parent === undefined ? {} : { parent: req.parent }),
      tags: [
        "plainport",
        `plainport:project=${project.id}`,
        `plainport:root=${project.rootId}`,
        `plainport:path=${project.path}`,
        `plainport:op=${op}`,
        "plainport:kind=offload",
      ],
    },
    req.ctx,
  );
  if (!made.ok) {
    if (made.incomplete !== undefined) {
      // restic wrote a snapshot although it could not read everything (exit 3, D28): name it as discarded.
      const discarded = { snapshot: made.incomplete.snapshot, event: ulid(req.clock().getTime()) };
      const noted = await saga.step("offload.snapshot.discarded", {
        attempts: [...saga.journal.attempts, discarded.snapshot],
        discarded,
      });
      // The journal stays at snapshot.start, naming nothing restic wrote: recover closes it, not a re-run.
      if (!noted.ok)
        return saga.keep(
          withFix(
            noted,
            "fix what the message names (permissions, free space), then run plainport recover: it closes this offload, which changed nothing local, so a new one can start",
          ),
        );
      const written = await appendEvent(req.events, {
        v: 1,
        id: discarded.event,
        type: "snapshot-discarded",
        device: req.device,
        at: req.clock().toISOString(),
        op,
        project: project.id,
        root: project.rootId,
        path: project.path,
        snapshot: op,
        stored: { [store.name]: discarded.snapshot },
      });
      // Unwritten, it stays journaled for recover to write.
      if (!written.ok) {
        req.log("warn", `the discarded snapshot could not be recorded yet: ${written.finding.message}`);
        return saga.keep(
          withFix(
            made,
            `run plainport recover once the store accepts writes (${written.finding.code}): it records the incomplete snapshot restic wrote and closes this offload, which changed nothing local; then make the files restic could not read readable and re-run`,
          ),
        );
      }
      saga.after("offload.snapshot.discarded.appended");
    }
    return req.ctx.signal?.aborted ? req.cancelled() : made;
  }
  const done = await saga.step("offload.snapshot.done", {
    attempts: [...saga.journal.attempts, made.value.id],
  });
  if (!done.ok) return done;
  return ok(made.value.id);
};
