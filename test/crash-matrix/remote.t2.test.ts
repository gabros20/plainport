// The crash matrix's store dimension on remote stores (T2; ADR-0017, M2 Task 27): every row the matrix enumerates
// (matrix.ts), on an SFTP store (OpenSSH in the container) and on an S3 store (SeaweedFS, D94), each row with its own
// store under a fresh prefix, run by the hooked binary with the real restic and rclone, killed by a real SIGKILL at the
// row's step or seam, then `plainport recover`, then the row's checks (checks.ts): the same rows and the same checks as
// on a local store (subprocess.test.ts), through the harness (harness.ts).
//
// Bootstrap's rows too (BOOTSTRAP_ROWS): `plainport store add` killed at each bootstrap step and seam, then recover
// settles the attempt to published, rolled back or contested (a rival's lower candidacy, which then refuses), with
// the store, the registry and the journals agreeing, and a second recover with nothing to do.
//
// macOS only in M2, like the local variant (harness.ts): CI's T2 job runs on Linux, where the binary's preflight
// refuses, so these rows run where a Mac runs `bun run test:t2`. PLAINPORT_CRASH_MATRIX_DAMAGE=1 harms every row after
// recover, and every row must then report it.

import { afterAll, describe, expect } from "bun:test";
import { STORE_CLAIMS_PREFIX } from "../../packages/core/src/catalog/identity.ts";
import { loadTestEnv } from "../../scripts/testenv.ts";
import { macOnlyTests, onMac } from "../platform.ts";
import type { RemoteKind } from "../support/remote-device.ts";
import { beforeAllT2, describeT2 } from "../tiers.ts";
import { damageBootstrap, expected, rawBlob, record, settledProblems } from "./bootstrap-checks.ts";
import { DAMAGE_MODE, damage } from "./checks.ts";
import {
  crashAt,
  type Harness,
  inRow,
  killed,
  makeHarness,
  type RowRun,
  remoteKind,
  removeHarness,
  rowWork,
  type StoreKind,
  slots,
  testMs,
} from "./harness.ts";
import {
  ALL_ROWS,
  BOOTSTRAP_ROWS,
  type BootstrapRow,
  OFFLOAD_ROWS,
  ONLOAD_ROWS,
  type Row,
} from "./matrix.ts";

const KINDS: readonly RemoteKind[] = ["sftp", "s3"];

let harness: Harness | undefined;
const kinds = new Map<RemoteKind, StoreKind>();
const pools = new Map<RemoteKind, <T>(work: () => Promise<T>) => Promise<T>>();

const parallelOf = (kind: StoreKind) => {
  const asked = Number(process.env.PLAINPORT_CRASH_PARALLEL);
  return Number.isInteger(asked) && asked > 0 ? asked : kind.parallel;
};

beforeAllT2(async () => {
  if (!onMac) return;
  const env = loadTestEnv();
  for (const name of KINDS) {
    const kind = remoteKind(env, name);
    kinds.set(name, kind);
    pools.set(name, slots(parallelOf(kind)));
  }
  harness = await makeHarness({ withRclone: true });
}, 240_000);

afterAll(async () => {
  await removeHarness(harness);
}, 180_000);

const kindOf = (name: RemoteKind): StoreKind => {
  const kind = kinds.get(name);
  if (kind === undefined || harness === undefined) throw new Error(`the ${name} store kind was not set up`);
  return kind;
};

const run = <T>(name: RemoteKind, work: (r: RowRun) => Promise<T>, rowMs?: number) =>
  inRow(
    harness as Harness,
    kindOf(name),
    pools.get(name) as <U>(w: () => Promise<U>) => Promise<U>,
    work,
    rowMs,
  );

/** A row's test: green when its checks find nothing, or, in the damage mode, when they find the harm done. */
const rowTest = (name: RemoteKind, row: Row) => async () => {
  const problems = await run(name, (r) => rowWork(r, row, DAMAGE_MODE ? { damage } : {}));
  if (DAMAGE_MODE) expect(problems.length).toBeGreaterThan(0);
  else expect(problems).toEqual([]);
};

// The row's timeout: its own time plus the longest wait for a slot in its kind's pool (the slowest, SFTP's, here).
const ROWS_PER_KIND = ALL_ROWS.length + BOOTSTRAP_ROWS.length;
const TEST_MS = testMs(ROWS_PER_KIND, 3);

describeT2("crash matrix, SIGKILL subprocess on remote stores", () => {
  // macOS-only in M2 (see the file comment), counted so a skip never passes for a run on a Mac.
  const macRow = macOnlyTests(process.env, { concurrent: true });
  for (const name of KINDS)
    describe(`on ${name}`, () => {
      for (const [saga, rows] of [
        ["offload", OFFLOAD_ROWS],
        ["onload", ONLOAD_ROWS],
      ] as const)
        describe(`${saga} (${rows.length} rows)`, () => {
          for (const row of rows) macRow(`${row.name} · ${name}`, rowTest(name, row), TEST_MS);
        });
      describe(`bootstrap (${BOOTSTRAP_ROWS.length} rows)`, () => {
        for (const row of BOOTSTRAP_ROWS)
          macRow(`bootstrap · ${row.name} · ${name}`, bootstrapTest(name, row), TEST_MS);
      });
    });
});

const bootstrapWork = async (r: RowRun, row: BootstrapRow): Promise<string[]> => {
  await r.init({ add: false });
  const problems: string[] = [];
  const rival = "00000000000000000000000000";
  const blob = await rawBlob(r);
  // Another device's attempt stands with a lower id: this attempt sees it and refuses (D109). That device then
  // refuses too, so recovery's outcome is final.
  if (row.scenario === "rival") {
    const put = await blob.put(`${STORE_CLAIMS_PREFIX}${rival}.json`, record(rival, "candidate"));
    if (!put.ok) throw new Error(put.finding.message);
  }
  killed(await r.run(r.addArgs(), crashAt(row.point)), "store add");
  if (row.scenario === "rival") {
    const put = await blob.put(`${STORE_CLAIMS_PREFIX}${rival}.refused`, record(rival, "refused"));
    if (!put.ok) throw new Error(put.finding.message);
  }
  const { report } = await r.recoverRun();
  const bootstraps = report.bootstraps as unknown as { attempt: string; outcome: string; step?: string }[];
  const want = expected(row);
  if (bootstraps.length !== 1 || bootstraps[0]?.outcome !== want)
    return [`recover settled ${JSON.stringify(bootstraps)}, not ${want}`];
  const attempt = bootstraps[0]?.attempt as string;
  if (!(row.outcomes as readonly string[]).includes(want))
    problems.push(`${want} is not an outcome rule ${row.rule} allows (${row.outcomes.join(", ")})`);
  if (DAMAGE_MODE) damageBootstrap(r, want === "published");
  problems.push(...(await settledProblems(r, blob, attempt, want)));
  return problems;
};

const bootstrapTest = (name: RemoteKind, row: BootstrapRow) => async () => {
  const problems = await run(name, (r) => bootstrapWork(r, row));
  if (DAMAGE_MODE) expect(problems.length).toBeGreaterThan(0);
  else expect(problems).toEqual([]);
};
