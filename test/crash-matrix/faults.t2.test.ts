// The crash matrix's fault dimension (T2; M2 Task 27): the store cut, or its acknowledgement lost, at the worst
// moments, through Toxiproxy (scripts/testenv.ts PROFILES). `cut` resets both directions; `lost-ack` lets the request
// through whole and resets the response, so the store did the work and the client cannot know. lost-ack runs on the S3
// store only: on SFTP the server speaks first, so a downstream reset fires in the SSH handshake, like cut.
//
// Each row runs the hooked binary (harness.ts) against a store reached through the proxy, paused where the fault goes
// in, then lets it go on into the fault:
//
//   offload.commit.start     paused at the step, the fault in, then the event append: cut, nothing lands; lost-ack,
//                            the event lands and the client sees a failure. The journal stays at commit.start.
//   offload.release.reread   paused at release.trash, the fault in, then release's catalog read: nothing moves.
//   trash.delete.checked     an offload whose trash is held for a 1 s grace (Q16), the fault in after it: the checked
//                            read before the delete fails, and the trash stays.
//   onload.restore           paused at onload.restore.start, the fault in, then restic's restore: the onload fails
//                            and closes its own journal; the stub and the shelved project stay.
//   bootstrap · <point>      `store add` paused at each bootstrap step and seam, the fault in, then whatever the
//                            attempt does next on the store.
//
// Then `plainport recover` runs once with the fault still in (nothing pending may settle on a guess: pending, and
// nothing deleted), the fault is cleared, and recover runs again: it settles the operation as its rule allows, and
// the row's checks (checks.ts, bootstrap-checks.ts) hold: invariants 1–6, no work lost, a second recover with nothing
// to do. The live run must name the fault store.unreachable (exit 9), never another failure.
//
// One proxy per store kind serves every row on it, so a kind's fault rows run one at a time; the two kinds run side
// by side. macOS only in M2, like every row of the subprocess harness.

import { afterAll, describe, expect } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RecoveryOutcome, RecoveryReport } from "../../packages/core/src/recover/recover.ts";
import type { BootstrapRecoveryOutcome } from "../../packages/core/src/saga/bootstrap.ts";
import type { OffloadStep } from "../../packages/core/src/saga/offload.ts";
import type { OnloadStep } from "../../packages/core/src/saga/onload.ts";
import { applyProfile, loadTestEnv, type TestEnv } from "../../scripts/testenv.ts";
import { macOnlyTests, onMac } from "../platform.ts";
import type { RemoteKind } from "../support/remote-device.ts";
import { beforeAllT2, describeT2 } from "../tiers.ts";
import { bootstrapSteps, damageBootstrap, expected, rawBlob, settledProblems } from "./bootstrap-checks.ts";
import {
  crashedOperation,
  DAMAGE_MODE,
  damage,
  journalSteps,
  settleJournals,
  settlementProblems,
  snapshotIds,
  worldProblems,
} from "./checks.ts";
import { hashTree, treeDiff } from "./fixture.ts";
import {
  envelopeOf,
  type Harness,
  inRow,
  makeHarness,
  offloadArgs,
  ok,
  onloadArgs,
  pauseAt,
  type Ran,
  type RowRun,
  remoteKind,
  removeHarness,
  type StoreKind,
  slots,
} from "./harness.ts";
import { ALL_ROWS, BOOTSTRAP_ROWS, type BootstrapRow, type Row } from "./matrix.ts";

/** The row that crashes at a step the first time it is reached, whichever scenario reaches it. */
const rowAt = (step: string): Row => {
  const row = ALL_ROWS.find((r) => r.point === step && r.occurrence === 1);
  if (row === undefined) throw new Error(`no row at ${step}`);
  return row;
};

export type Fault = "cut" | "lost-ack";

/** The faults each store kind takes (see the file comment). */
export const FAULTS: readonly (readonly [RemoteKind, Fault])[] = [
  ["sftp", "cut"],
  ["s3", "cut"],
  ["s3", "lost-ack"],
];

/** Where a saga's fault goes in, what the faulted run leaves, and what recover settles once the store is back. */
interface SagaPoint {
  saga: "offload" | "onload";
  /** The step the run is paused at while the fault goes in; none for the held trash, which needs no pause. */
  pause?: OffloadStep | OnloadStep;
  /** The journal step the faulted run leaves, or undefined when it closes its own journal. */
  leaves?: OffloadStep;
  /** recover's outcome once the store is back, by fault; undefined: nothing left to recover. */
  settles: Readonly<Record<Fault, RecoveryOutcome | undefined>>;
}

export const SAGA_POINTS: Readonly<Record<string, SagaPoint>> = {
  "offload.commit.start": {
    saga: "offload",
    pause: "offload.commit.start",
    leaves: "offload.commit.start",
    // cut: the event never landed, so nothing committed (D24); lost-ack: it did, so the release finishes.
    settles: { cut: "rolled-back", "lost-ack": "finished" },
  },
  "offload.release.reread": {
    saga: "offload",
    pause: "offload.release.trash",
    leaves: "offload.release.trash",
    settles: { cut: "finished", "lost-ack": "finished" },
  },
  "trash.delete.checked": {
    saga: "offload",
    leaves: "offload.release.held",
    settles: { cut: "trash-deleted", "lost-ack": "trash-deleted" },
  },
  "onload.restore": {
    saga: "onload",
    pause: "onload.restore.start",
    settles: { cut: undefined, "lost-ack": undefined },
  },
};

/** The one bootstrap point after which the attempt makes no store call: a fault there cannot stop it publishing. */
const LAST_STORE_WRITE_PAST = "bootstrap.recorded";

/** Bootstrap's fault rows: every plain bootstrap point (a rival's needs no store fault to reach its point). */
const BOOTSTRAP_POINTS = BOOTSTRAP_ROWS.filter((row) => row.scenario === "plain");

/** A row's own time: restic retries a failing connection for a minute before it is store.unreachable. */
const FAULT_ROW_MS = 420_000;

let harness: Harness | undefined;
let env: TestEnv | undefined;
/** What each row saw, printed at the end: the live run's exit, the journal it left, recover's outcomes. */
const ledger: string[] = [];
const kinds = new Map<RemoteKind, StoreKind>();
// One row at a time per proxy: a fault on it reaches every connection through it.
const pools = new Map<RemoteKind, <T>(work: () => Promise<T>) => Promise<T>>();

beforeAllT2(async () => {
  if (!onMac) return;
  env = loadTestEnv();
  for (const name of ["sftp", "s3"] as const) {
    kinds.set(name, remoteKind(env, name, { proxied: true }));
    pools.set(name, slots(1));
    await applyProfile(env, name, "clear");
  }
  harness = await makeHarness({ withRclone: true });
}, 240_000);

afterAll(async () => {
  if (ledger.length > 0) process.stdout.write(`${ledger.sort().join("\n")}\n`);
  if (env !== undefined) for (const name of ["sftp", "s3"] as const) await applyProfile(env, name, "clear");
  await removeHarness(harness);
}, 180_000);

const run = <T>(name: RemoteKind, work: (r: RowRun) => Promise<T>) => {
  const kind = kinds.get(name);
  if (kind === undefined || harness === undefined) throw new Error(`the ${name} store kind was not set up`);
  return inRow(
    harness,
    kind,
    pools.get(name) as <U>(w: () => Promise<U>) => Promise<U>,
    async (r) => {
      try {
        return await work(r);
      } finally {
        await applyProfile(env as TestEnv, name, "clear");
      }
    },
    FAULT_ROW_MS,
  );
};

const inject = (name: RemoteKind, fault: Fault) => applyProfile(env as TestEnv, name, fault);
const clear = (name: RemoteKind) => applyProfile(env as TestEnv, name, "clear");

/** The faulted run's failure: it must say store.unreachable (exit 9), whatever the fault and the store. */
const unreachableProblems = (ran: Ran, what: string): string[] => {
  const error = envelopeOf(ran)?.error;
  const code = error?.finding?.code;
  return ran.code === 9 && code === "store.unreachable"
    ? []
    : [
        `the faulted ${what} ended with exit ${ran.code ?? ran.signal} (${code}: ${error?.finding?.message ?? `${ran.err}${ran.out}`.slice(-400)}), not store.unreachable (exit 9)`,
      ];
};

/** What a recover with the store still down may do: leave every operation pending, settle nothing on a guess. */
const downProblems = (report: RecoveryReport): string[] =>
  report.operations
    .filter((o) => o.outcome !== "pending")
    .map((o) => `with the store down, recover settled ${o.kind} ${o.op} at ${o.step} as ${o.outcome}`);

/**
 * The folder and its trash copies as a recover with the store down must leave them: as they were. The holder's own
 * files (claims, the note of why a trash stays) are plainport's bookkeeping, not the project.
 */
const placesOf = (r: RowRun) => {
  const holder = join(r.root, ".plainport-trash");
  const copies = new Map<string, string>();
  for (const op of existsSync(holder) ? readdirSync(holder) : []) {
    const copy = join(holder, op, "web");
    if (existsSync(copy)) for (const [path, hash] of hashTree(copy)) copies.set(`${op}/${path}`, hash);
  }
  return {
    folder: existsSync(r.dir) ? hashTree(r.dir) : undefined,
    stub: existsSync(`${r.dir}.plainport`),
    trash: copies.size === 0 ? undefined : copies,
  };
};
const samePlaces = (a: ReturnType<typeof placesOf>, b: ReturnType<typeof placesOf>): string[] => {
  const problems: string[] = [];
  const diff = (x: Map<string, string> | undefined, y: Map<string, string> | undefined) =>
    x === undefined || y === undefined ? (x === y ? [] : ["(present on one side only)"]) : treeDiff(x, y);
  const folder = diff(a.folder, b.folder);
  if (folder.length > 0)
    problems.push(`with the store down, recover changed the folder: ${folder.join(", ")}`);
  const trash = diff(a.trash, b.trash);
  if (trash.length > 0) problems.push(`with the store down, recover changed the trash: ${trash.join(", ")}`);
  if (a.stub !== b.stub) problems.push("with the store down, recover changed the stub");
  return problems;
};

const sagaFaultWork = async (r: RowRun, name: RemoteKind, point: string, fault: Fault): Promise<string[]> => {
  const at = SAGA_POINTS[point] as SagaPoint;
  await r.init();
  const problems: string[] = [];
  if (at.saga === "onload") await r.shelve();
  if (point === "trash.delete.checked") r.offload({ conflictGrace: '"1s"' });
  const before = journalSteps(r.box.paths);
  const seen = await snapshotIds((await r.world()).store.engine);

  // The faulted run.
  const args = at.saga === "offload" ? offloadArgs : onloadArgs;
  if (at.pause !== undefined) {
    const ran = await r.run(args, pauseAt(at.pause), () => inject(name, fault));
    problems.push(...unreachableProblems(ran, at.saga));
  } else {
    // The held trash: the offload ends held, then the store goes down before its checked read.
    ok(await r.run(args), "offload");
    await Bun.sleep(1_100);
    await inject(name, fault);
  }
  const steps = journalSteps(r.box.paths);
  const op = crashedOperation(before, steps);
  const left = op === undefined ? undefined : steps.get(op);
  if (left !== at.leaves) problems.push(`the faulted run left the journal at ${left}, not ${at.leaves}`);
  if (at.saga === "offload") r.captureAfterCrash();

  // recover with the store still down: pending, and nothing moved or deleted.
  const placed = placesOf(r);
  const down = await r.recover();
  problems.push(...downProblems(down), ...samePlaces(placed, placesOf(r)));
  // Pending because the store did not answer: recover asked it (the checked read, the re-read, the event's state),
  // not for another reason (a held trash's grace still running would be pending too).
  const heldBack = down.operations.find((o) => o.op === op);
  if (
    at.leaves !== undefined &&
    (heldBack?.outcome !== "pending" || heldBack.finding?.code !== "store.unreachable")
  )
    problems.push(
      `with the store down, recover reported ${op} ${heldBack?.outcome} (${heldBack?.finding?.code}), not pending with store.unreachable`,
    );

  // The store back: recover settles it.
  await clear(name);
  const report = await r.recover();
  await settleJournals(r.box.paths);
  const again = await r.recover();
  const want = at.settles[fault];
  const settled = report.operations.find((o) => o.op === op);
  ledger.push(
    `${point} · ${fault} · ${name}: journal left at ${left}; store down: ${down.operations.map((o) => o.outcome).join(",") || "nothing"}; back: ${report.operations.map((o) => o.outcome).join(",") || "nothing"}`,
  );
  if (want !== undefined && settled?.outcome !== want)
    problems.push(`once the store was back, recover settled ${op} as ${settled?.outcome}, not ${want}`);
  if (DAMAGE_MODE) damage(await r.world());
  const w = await r.world();
  const settlement = {
    crashedStep: left,
    crashedOp: op,
    journalAtRecover: left !== undefined,
    report,
    again,
    reference: r.reference,
    ...(r.released === undefined ? {} : { released: r.released }),
    seen,
    projectId: r.projectId(),
  };
  if (at.leaves !== undefined) problems.push(...settlementProblems(rowAt(at.leaves), settlement));
  else if (report.operations.length > 0 || again.operations.length > 0)
    problems.push(
      `recover had work after a run that closed its own journal: ${JSON.stringify(report.operations)}`,
    );
  problems.push(...(await worldProblems({ saga: at.saga }, w, settlement)));
  return problems;
};

const bootstrapFaultWork = async (
  r: RowRun,
  name: RemoteKind,
  row: BootstrapRow,
  fault: Fault,
): Promise<string[]> => {
  await r.init({ add: false });
  const problems: string[] = [];
  const blob = await rawBlob(r);
  const ran = await r.run(r.addArgs(), pauseAt(row.point), () => inject(name, fault));
  const outcome = envelopeOf(ran)?.data?.outcome;
  // Only past the attempt's last store write (bootstrap.recorded) does the run publish despite the fault; anywhere
  // else it meets the store and must say store.unreachable.
  if (row.point === LAST_STORE_WRITE_PAST) {
    if (ran.code !== 0 || outcome !== "published")
      problems.push(`past its last store write, store add ended ${ran.code} (${outcome}), not published`);
  } else problems.push(...unreachableProblems(ran, "store add"));
  // The step the attempt's journal reached before the store failed it: the run goes on past the paused point to its
  // next store call, journaling what comes first (elect.start before its candidacy is written).
  const [left] = [...bootstrapSteps(r).values()];

  const pinned = () =>
    JSON.stringify(existsSync(r.box.paths.registryFile) ? (r.registry().stores ?? {}) : {});
  const pinnedBefore = pinned();
  const down = await r.recoverRun();
  const downBootstraps = down.report.bootstraps as unknown as { attempt: string; outcome: string }[];
  for (const b of downBootstraps)
    if (b.outcome !== "pending")
      problems.push(`with the store down, recover settled the bootstrap ${b.attempt} as ${b.outcome}`);
  if (pinned() !== pinnedBefore) problems.push("with the store down, recover changed the registry's pins");

  await clear(name);
  const { report } = await r.recoverRun();
  const bootstraps = report.bootstraps as unknown as { attempt: string; outcome: BootstrapRecoveryOutcome }[];
  if (bootstraps.length > 1) return [...problems, `recover settled ${JSON.stringify(bootstraps)}`];
  const settled = bootstraps[0];
  // cut: nothing the fault met reached the store, so the attempt settles as a crash at the step its journal reached
  // would; lost-ack: the write the fault met may have landed, which moves a rollback on to a publication.
  const atStep =
    left === undefined ? expected(row) : expected({ ...row, step: left as BootstrapRow["step"] });
  const allowed: BootstrapRecoveryOutcome[] =
    fault === "cut" ? [atStep] : [...new Set([atStep, "published" as const])];
  let attempt = settled?.attempt;
  let want: BootstrapRecoveryOutcome;
  if (settled === undefined) {
    // The faulted run settled itself: published past the fault, or rolled back by itself.
    const published = await blob.get("meta/v1/store.json");
    const id =
      published.ok && published.value !== null
        ? (JSON.parse(new TextDecoder().decode(published.value)) as { id: string }).id
        : undefined;
    attempt = id;
    want = id === undefined ? "rolled-back" : "published";
  } else want = settled.outcome;
  ledger.push(
    `bootstrap · ${row.point} · ${fault} · ${name}: store add exit ${ran.code}; journal left at ${left}; store down: ${downBootstraps.map((b) => b.outcome).join(",") || "nothing"}; back: ${settled?.outcome ?? `nothing (${want} by the run)`}`,
  );
  if (!allowed.includes(want)) problems.push(`the attempt settled ${want}, not ${allowed.join(" or ")}`);
  if (!(row.outcomes as readonly string[]).includes(want))
    problems.push(`${want} is not an outcome rule ${row.rule} allows (${row.outcomes.join(", ")})`);
  if (DAMAGE_MODE) damageBootstrap(r, want === "published");
  problems.push(...(await settledProblems(r, blob, attempt, want)));
  return problems;
};

/** A row's test: green when its checks find nothing, or, in the damage mode, when they find the harm done. */
const faultTest = (work: () => Promise<string[]>) => async () => {
  const problems = await work();
  if (DAMAGE_MODE) expect(problems.length).toBeGreaterThan(0);
  else expect(problems).toEqual([]);
};

const ROWS_PER_KIND = 2 * (Object.keys(SAGA_POINTS).length + BOOTSTRAP_POINTS.length);
const TEST_MS = FAULT_ROW_MS * (ROWS_PER_KIND + 1);

describeT2("crash matrix, network faults on remote stores", () => {
  const macRow = macOnlyTests(process.env, { concurrent: true });
  for (const [name, fault] of FAULTS)
    describe(`${fault} on ${name}`, () => {
      for (const point of Object.keys(SAGA_POINTS))
        macRow(
          `${point} · ${fault} · ${name}`,
          faultTest(() => run(name, (r) => sagaFaultWork(r, name, point, fault))),
          TEST_MS,
        );
      for (const row of BOOTSTRAP_POINTS)
        macRow(
          `bootstrap · ${row.point} · ${fault} · ${name}`,
          faultTest(() => run(name, (r) => bootstrapFaultWork(r, name, row, fault))),
          TEST_MS,
        );
    });
});
