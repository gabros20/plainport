// What every crash-matrix row asserts once recover has run, in both variants (in-process and SIGKILL subprocess):
//
// - recover found the journal at the step the crash left (the row's step) and settled it with an outcome its rule
//   allows (RECOVERY_RULE_OUTCOMES), never leaving it pending;
// - invariants 1–3 on this device (invariantViolations) and 4–6 on the store (catalogInvariantViolations);
// - no work is lost: a folder still in place is byte-identical to the project as the crash left it, and a folder that
//   is gone is shelved, its head restoring byte-identical to it apart from the stripped paths;
// - recover is idempotent: running it again finds nothing to do.

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldCatalog } from "../../packages/core/src/catalog/fold.ts";
import { readEvents, storeEventLog } from "../../packages/core/src/catalog/log.ts";
import type { PlainportPaths } from "../../packages/core/src/paths.ts";
import type { BlobStore } from "../../packages/core/src/ports/blob-store.ts";
import type { Engine } from "../../packages/core/src/ports/engine.ts";
import type { RecoveryReport } from "../../packages/core/src/recover/recover.ts";
import { StubSchema } from "../../packages/core/src/stub.ts";
import {
  catalogInvariantViolations,
  invariantViolations,
  type TreeCapture,
} from "../../packages/core/src/testing/invariants.ts";
import { ulid } from "../../packages/core/src/ulid.ts";
import { hashTree, removeTree, STRIPPED, type TreeHash, treeDiff } from "./fixture.ts";
import type { Row } from "./matrix.ts";

export interface World {
  paths: PlainportPaths;
  /** This device's ULID. */
  device: string;
  /** The project's folder. */
  dir: string;
  /** The root's folder on this device. */
  root: string;
  store: { name: string; blob: BlobStore; engine: Engine };
  /** Where to restore the head to compare it: on the project's own volume (a case pair needs a case-sensitive one). */
  scratch?: string;
}

/** The engine ids of the snapshots the store's repository holds. */
export const snapshotIds = async (engine: Engine): Promise<Set<string>> => {
  const listed = await engine.list({});
  if (!listed.ok) throw new Error(`listing snapshots: ${listed.finding.message}`);
  return new Set(listed.value.map((s) => s.id));
};

/** The journal steps on disk, by operation. */
export const journalSteps = (paths: PlainportPaths): Map<string, string> => {
  const out = new Map<string, string>();
  let names: string[] = [];
  try {
    names = readdirSync(paths.journalDir).filter((n) => n.endsWith(".json"));
  } catch {}
  for (const name of names) {
    try {
      const journal = JSON.parse(readFileSync(join(paths.journalDir, name), "utf8"));
      out.set(journal.op, journal.step);
    } catch {}
  }
  return out;
};

/** Waits up to `ms` for the detached deletes recover started to finish: no journal left. */
export const settleJournals = async (paths: PlainportPaths, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (journalSteps(paths).size > 0 && Date.now() < deadline) await Bun.sleep(25);
};

export interface Settlement {
  /** The step the crashed operation's journal was at before recover, if it still had one. */
  crashedStep: string | undefined;
  /** The crashed operation's id. */
  crashedOp: string | undefined;
  report: RecoveryReport;
  /** The report of a second recover run. */
  again: RecoveryReport;
  /** The project as the crash left it (its folder in place, in the trash, or as release captured it). */
  reference: TreeHash;
  /** The folder as release began (invariant 1), once an offload got that far. */
  released?: TreeCapture;
  /** Snapshot ids seen in the repository before recover ran. */
  seen: Set<string>;
  /** The project's id, once registered. */
  projectId: string | undefined;
}

/** Every problem with a settled row; none means it passed. */
export const rowProblems = async (row: Row, world: World, s: Settlement): Promise<string[]> => {
  const problems: string[] = [];

  // The step the crash left, and recover's outcome for it.
  // A crash after the detached delete started races it: the delete may finish, journal and all, before recover runs.
  const raced = row.point === "offload.release.detached";
  if (s.crashedStep === undefined) {
    if (!raced) problems.push(`the crash left no journal (expected one at ${row.step})`);
  } else if (s.crashedStep !== row.step) {
    problems.push(`the crash left the journal at ${s.crashedStep}, expected ${row.step}`);
  }
  const ops = s.report.operations.filter((o) => o.op === s.crashedOp);
  if (s.crashedStep !== undefined) {
    if (ops.length !== 1) problems.push(`recover reported ${ops.length} operations for ${s.crashedOp}`);
    for (const op of ops) {
      if (op.step !== s.crashedStep)
        problems.push(`recover found ${op.step}, the journal said ${s.crashedStep}`);
      if (!row.outcomes.includes(op.outcome))
        problems.push(
          `recover's outcome ${op.outcome} is not one rule ${row.rule} allows (${row.outcomes.join(", ")})`,
        );
      if (op.outcome === "pending")
        problems.push(
          `recover left the operation pending: ${op.finding?.code ?? ""} ${op.finding?.message ?? ""}`,
        );
    }
  }
  const others = s.report.operations.filter((o) => o.op !== s.crashedOp && o.outcome === "pending");
  for (const o of others) problems.push(`recover left ${o.kind} ${o.op} pending at ${o.step}`);
  if (s.again.operations.length > 0 || s.again.unreadable.length > 0)
    problems.push(
      `a second recover found work: ${s.again.operations.map((o) => `${o.op} ${o.step} ${o.outcome}`).join("; ")}`,
    );

  // Invariants 1–3.
  problems.push(
    ...(await invariantViolations({
      paths: world.paths,
      device: world.device,
      project: { id: s.projectId, dir: world.dir },
      roots: [world.root],
      store: world.store,
      ...(s.released === undefined ? {} : { released: s.released }),
      stripped: STRIPPED,
    })),
  );

  // Invariants 4–6.
  const read = await readEvents(storeEventLog(world.store.blob));
  if (!read.ok) return [...problems, `the store's events cannot be read: ${read.finding.message}`];
  const events = read.value.events;
  problems.push(
    ...catalogInvariantViolations({
      events,
      snapshotsBefore: s.seen,
      snapshotsNow: await snapshotIds(world.store.engine),
    }),
  );

  // No work lost.
  let present = true;
  try {
    readdirSync(world.dir);
  } catch {
    present = false;
  }
  if (present) {
    const now = hashTree(world.dir, row.saga === "onload" ? STRIPPED : []);
    const was = row.saga === "onload" ? withoutStripped(s.reference) : s.reference;
    const differ = treeDiff(was, now);
    if (differ.length > 0)
      problems.push(`the folder is not the project as the crash left it: ${differ.join(", ")}`);
  } else {
    const project = s.projectId === undefined ? undefined : foldCatalog(events).projects[s.projectId];
    let stub: string | undefined;
    try {
      stub = StubSchema.parse(JSON.parse(readFileSync(`${world.dir}.plainport`, "utf8"))).snapshot;
    } catch {}
    const head = project?.head ?? undefined;
    const event = events.find((e) => e.type === "offloaded" && e.snapshot === head);
    const stored = event?.type === "offloaded" ? event.stored[world.store.name] : undefined;
    if (stub === undefined || head === undefined || stub !== head || stored === undefined)
      problems.push(`the folder is gone, but no stub names a stored head (stub ${stub}, head ${head})`);
    else {
      const target = mkdtempSync(join(world.scratch ?? tmpdir(), "plainport-crash-head-"));
      try {
        const restored = await world.store.engine.restore(stored, join(target, "web"), { op: ulid() });
        if (!restored.ok) problems.push(`the head ${head} does not restore: ${restored.finding.message}`);
        else {
          const differ = treeDiff(withoutStripped(s.reference), hashTree(join(target, "web")));
          if (differ.length > 0)
            problems.push(`the head ${head} is not the project as the crash left it: ${differ.join(", ")}`);
        }
      } finally {
        removeTree(target);
      }
    }
  }
  return problems;
};

const withoutStripped = (tree: TreeHash): TreeHash =>
  new Map([...tree].filter(([p]) => !STRIPPED.some((s) => p === s || p.startsWith(`${s}/`))));
