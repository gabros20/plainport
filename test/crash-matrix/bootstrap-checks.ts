// What a settled bootstrap on a remote store must show, for the crash matrix's remote rows (remote.t2.test.ts) and
// its fault rows (faults.t2.test.ts): the outcome recovery must reach, and the store, this device's registry and its
// journals agreeing with it, a second recover with nothing to do, and a rolled-back store set up by a retry.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeOpener } from "../../packages/cli/src/stores.ts";
import { STORE_CLAIMS_PREFIX, STORE_IDENTITY_KEY } from "../../packages/core/src/catalog/identity.ts";
import { ConfigLoader } from "../../packages/core/src/config/load.ts";
import { bootstrapJournalDir } from "../../packages/core/src/journal/index.ts";
import type { BlobStore } from "../../packages/core/src/ports/blob-store.ts";
import type { BootstrapRecoveryOutcome } from "../../packages/core/src/saga/bootstrap.ts";
import { testHost } from "../../packages/host-macos/src/testing.ts";
import { DAMAGE_MODE } from "./checks.ts";
import { envelopeOf, PASSWORD, type RowRun } from "./harness.ts";
import type { BootstrapRow } from "./matrix.ts";

/** What recovery must settle the row to: before the candidacy nothing is published; a rival makes it contested. */
export const expected = (row: BootstrapRow): BootstrapRecoveryOutcome =>
  row.scenario === "rival"
    ? "contested"
    : row.step === "bootstrap.begin" || row.step === "bootstrap.initialised"
      ? "rolled-back"
      : "published";

export const record = (id: string, decision: string) =>
  new TextEncoder().encode(`${JSON.stringify({ v: 1, id, decision })}\n`);

/** The row's store before it is set up: its metadata layer through the binary's own opener, for the rival's files. */
export const rawBlob = async (r: RowRun): Promise<BlobStore> => {
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

export const registryStores = (r: RowRun): Record<string, string> => {
  if (!existsSync(r.box.paths.registryFile)) return {};
  return (r.registry() as { stores?: Record<string, string> }).stores ?? {};
};

/** The bootstrap journals on this device, by attempt: their steps. */
export const bootstrapSteps = (r: RowRun): Map<string, string> => {
  const dir = bootstrapJournalDir(r.box.paths);
  const out = new Map<string, string>();
  for (const name of existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")) : []) {
    try {
      const journal = JSON.parse(readFileSync(join(dir, name), "utf8")) as { op: string; step: string };
      out.set(journal.op, journal.step);
    } catch {
      out.set(name.replace(/\.json$/, ""), "unreadable");
    }
  }
  return out;
};

/** The damage mode's harm to a settled bootstrap: the pin it left taken away, or one it never made written. */
export const damageBootstrap = (r: RowRun, published: boolean) => {
  const registry = existsSync(r.box.paths.registryFile) ? r.registry() : { v: 1, projects: {} };
  registry.stores = published ? {} : { [r.kind.store]: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" };
  writeFileSync(r.box.paths.registryFile, `${JSON.stringify(registry, null, 2)}\n`);
};

/**
 * The store, the registry and the journals against the outcome `want` of `attempt` (the attempt recovery settled, or
 * the one the run published itself): published, this attempt's store.json and pin and a repository that opens; else
 * nothing published or pinned, and rolled back, none of its claims left. A second recover finds nothing; a rolled-back
 * store is set up by a retry.
 */
export const settledProblems = async (
  r: RowRun,
  blob: BlobStore,
  attempt: string | undefined,
  want: BootstrapRecoveryOutcome,
): Promise<string[]> => {
  const problems: string[] = [];
  const identity = await blob.get(STORE_IDENTITY_KEY);
  if (!identity.ok) return [`the store's identity cannot be read: ${identity.finding.message}`];
  const published =
    identity.value === null
      ? undefined
      : (JSON.parse(new TextDecoder().decode(identity.value)) as { id: string; repo: string });
  const pinned = registryStores(r)[r.kind.store];
  if (want === "published") {
    if (attempt === undefined || published?.id !== attempt || pinned !== attempt)
      problems.push(`published ${published?.id}, pinned ${pinned}, not the attempt ${attempt}`);
    else {
      // The published repository is this attempt's, and it opens with this device's password.
      const listed = await (await r.world()).store.engine.list({ noLock: true });
      if (!listed.ok) problems.push(`the published repository does not open: ${listed.finding.code}`);
    }
  } else if (published !== undefined || pinned !== undefined)
    problems.push(`${want}, yet published ${published?.id}, pinned ${pinned}`);
  if (want === "rolled-back" && attempt !== undefined) {
    const claims = await blob.list(`${STORE_CLAIMS_PREFIX}${attempt}`);
    if (!claims.ok || claims.value.length > 0)
      problems.push(`rolled back, yet the attempt's claims are on the store: ${JSON.stringify(claims)}`);
  }
  if (bootstrapSteps(r).size > 0)
    problems.push(`bootstrap journals are still there: ${[...bootstrapSteps(r).keys()].join(", ")}`);
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
