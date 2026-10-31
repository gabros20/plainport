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
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { storeOpener } from "../../packages/cli/src/stores.ts";
import { STORE_CLAIMS_PREFIX, STORE_IDENTITY_KEY } from "../../packages/core/src/catalog/identity.ts";
import { ConfigLoader } from "../../packages/core/src/config/load.ts";
import type { BootstrapRecoveryOutcome } from "../../packages/core/src/saga/bootstrap.ts";
import { testHost } from "../../packages/host-macos/src/testing.ts";
import { loadTestEnv } from "../../scripts/testenv.ts";
import { macOnlyTests, onMac } from "../platform.ts";
import type { RemoteKind } from "../support/remote-device.ts";
import { beforeAllT2, describeT2 } from "../tiers.ts";
import { DAMAGE_MODE, damage } from "./checks.ts";
import {
  crashAt,
  envelopeOf,
  type Harness,
  inRow,
  killed,
  makeHarness,
  PASSWORD,
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

// --- Bootstrap ---------------------------------------------------------------------------------------------------

/** What recovery must settle the row to: before the candidacy nothing is published; a rival makes it contested. */
const expected = (row: BootstrapRow): BootstrapRecoveryOutcome =>
  row.scenario === "rival"
    ? "contested"
    : row.step === "bootstrap.begin" || row.step === "bootstrap.initialised"
      ? "rolled-back"
      : "published";

const record = (id: string, decision: string) =>
  new TextEncoder().encode(`${JSON.stringify({ v: 1, id, decision })}\n`);

/** The row's store before it is set up: its metadata layer through the binary's own opener, for the rival's files. */
const rawBlob = async (r: RowRun) => {
  const host = testHost();
  const env = r.env();
  const loaded = await new ConfigLoader(host, r.box.paths).load({ env });
  if (!loaded.ok) throw new Error(loaded.finding.message);
  const store = loaded.value.config.stores[r.kind.store];
  if (store === undefined) throw new Error("no remote store in the row's config");
  const opened = await storeOpener(host, env).open(
    r.kind.store,
    store,
    PASSWORD,
    store.kind === "s3"
      ? { accessKeyId: env.T18_S3_KEY_ID as string, secretAccessKey: env.T18_S3_SECRET_KEY as string }
      : undefined,
  );
  if (!opened.ok) throw new Error(`${opened.finding.code}: ${opened.finding.message}`);
  return opened.value.blob;
};

const registryStores = (r: RowRun): Record<string, string> => {
  if (!existsSync(r.box.paths.registryFile)) return {};
  return (r.registry() as { stores?: Record<string, string> }).stores ?? {};
};

const journalNames = (r: RowRun): string[] =>
  existsSync(r.box.paths.journalDir)
    ? readdirSync(r.box.paths.journalDir).filter((name) => name.endsWith(".json"))
    : [];

/** The damage mode's harm to a settled bootstrap: the pin it left taken away, or one it never made written. */
const damageBootstrap = (r: RowRun, published: boolean) => {
  const registry = existsSync(r.box.paths.registryFile) ? r.registry() : { v: 1, projects: {} };
  registry.stores = published ? {} : { [r.kind.store]: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" };
  writeFileSync(r.box.paths.registryFile, `${JSON.stringify(registry, null, 2)}\n`);
};

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

  const identity = await blob.get(STORE_IDENTITY_KEY);
  if (!identity.ok) return [...problems, `the store's identity cannot be read: ${identity.finding.message}`];
  const published =
    identity.value === null
      ? undefined
      : (JSON.parse(new TextDecoder().decode(identity.value)) as { id: string; repo: string });
  const pinned = registryStores(r)[r.kind.store];
  if (want === "published") {
    if (published?.id !== attempt || pinned !== attempt)
      problems.push(`published ${published?.id}, pinned ${pinned}, not the attempt ${attempt}`);
    else {
      // The published repository is this attempt's, and it opens with this device's password.
      const listed = await (await r.world()).store.engine.list({ noLock: true });
      if (!listed.ok) problems.push(`the published repository does not open: ${listed.finding.code}`);
    }
  } else if (published !== undefined || pinned !== undefined)
    problems.push(`${want}, yet published ${published?.id}, pinned ${pinned}`);
  if (want === "rolled-back") {
    const claims = await blob.list(`${STORE_CLAIMS_PREFIX}${attempt}`);
    if (!claims.ok || claims.value.length > 0)
      problems.push(`rolled back, yet the attempt's claims are on the store: ${JSON.stringify(claims)}`);
  }
  if (journalNames(r).some((name) => name.startsWith(attempt)))
    problems.push("the bootstrap journal is still there");
  const again = await r.recoverRun();
  if ((again.report.bootstraps as unknown[]).length !== 0 || again.report.operations.length !== 0)
    problems.push(`a second recover had work to do: ${again.ran.out}`);
  // Rolled back, the store is as if the attempt never ran: a retry sets it up.
  if (want === "rolled-back" && !DAMAGE_MODE) {
    const retry = await r.run(r.addArgs());
    const outcome = envelopeOf(retry)?.data?.outcome;
    if (retry.code !== 0 || outcome !== "published")
      problems.push(`a retry after the rollback did not publish: ${retry.err}${retry.out}`);
  }
  return problems;
};

const bootstrapTest = (name: RemoteKind, row: BootstrapRow) => async () => {
  const problems = await run(name, (r) => bootstrapWork(r, row));
  if (DAMAGE_MODE) expect(problems.length).toBeGreaterThan(0);
  else expect(problems).toEqual([]);
};
