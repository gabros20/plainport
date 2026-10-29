// `plainport store test <name>` (DESIGN.md "Core API" stores.test, Q8, Q13: safe_write): measures what it can of the
// store and records it in this device's record of the store (stores/<id>.json, Q4), under the facts it was measured
// with, so a change of endpoint, access or tool version drops it.
//
// It writes, reads, lists, and deletes one probe key under meta/v1/store-test/, nothing else:
//   - the put answers, or the store is unreachable;
//   - a get right after it sees it (readAfterWrite) and a list names it (listAfterWrite), each `measured`;
//   - where the profile claims a conditional create, a create-only put on the same key must be refused;
//   - the delete is `allowed` when the key is gone afterwards, `denied` when the store refused it or kept the key, and
//     `unreachable` when the store stopped answering. A denied delete is never called append-only: that would need
//     proof across the whole repository (M3).
// The other properties stay as the store's profile states them (documented or asserted). It also opens the store's
// restic repository with this device's password (a wrong password, a missing repository), and lists what bootstraps
// left behind: repositories of attempts that lost (repos/<attempt>/) and candidacies besides the winner's
// (meta/v1/store-claims/), with the manual steps, quiesce first. plainport never deletes a repository.

import type { Finding, Result } from "@plainport/contract";
import { ok } from "@plainport/contract";
import {
  identityChanged,
  readStoreDescriptor,
  STORE_CLAIMS_PREFIX,
  type StoreDescriptor,
} from "../catalog/identity.ts";
import type { Store } from "../config/schema.ts";
import type { LocalIo } from "../io.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import {
  capabilitiesOf,
  eligibility,
  STORE_OPERATIONS,
  type StoreOperation,
  type StoreSemantics,
} from "../ports/blob-store.ts";
import type { StoreOpener } from "../ports/store.ts";
import { readRegistry } from "../registry.ts";
import { withFix } from "../saga/journaled.ts";
import { recordMeasured, type StoreTest } from "../stores-state.ts";
import { storeFacts, storeLocation, type ToolVersions } from "./location.ts";
import { reachStore } from "./reach.ts";

/** Where `store test` writes its probe keys; one per run, removed by the run itself. */
export const STORE_TEST_PREFIX = "meta/v1/store-test/";
const REPOS_PREFIX = "repos/";

export type DeleteVerdict = NonNullable<StoreTest["delete"]>;

export interface Leftover {
  /** The bootstrap attempt's id. */
  attempt: string;
  /** The keys it left in the store. */
  keys: string[];
}

export interface StoreTestReport {
  name: string;
  location: string;
  /** What the store's meta/v1/store.json says, when it has one. */
  id?: string;
  format?: 1 | 2;
  /** The id this device pinned for the name, if any (D85). */
  pinned?: string;
  reachable: boolean;
  /** Whether the probe key could be deleted; absent when the probe could not be written. */
  delete?: DeleteVerdict;
  /** The profile: what was measured here, the rest as the store states it. */
  semantics: StoreSemantics;
  /** Whether each operation is eligible on that profile (release without Q21's post-grace proof). */
  operations: Record<StoreOperation, { eligible: boolean; missing?: string[] }>;
  /** Whether the store's restic repository opens with this device's password. */
  repository?: { opens: boolean; code?: string };
  /** Repositories of bootstrap attempts that are not the published one. */
  losing: Leftover[];
  /** Candidacies of attempts other than the published winner (all of them while nothing is published). */
  contested: Leftover[];
  /** The manual steps that remove `losing` and `contested`, quiesced first; absent when there is nothing to remove. */
  cleanup?: string;
  /** The measurement was written to this device's record of the store (it needs the store's id). */
  recorded: boolean;
  ok: boolean;
  findings: Finding[];
}

export interface TestStoreOptions {
  paths: PlainportPaths;
  env: Env;
  name: string;
  store: Store;
  opener: StoreOpener;
  tools: ToolVersions;
  now: () => Date;
  /** A fresh ULID, for the probe key. */
  mint: () => string;
  signal?: AbortSignal;
}

const measured = <T>(value: T) => ({ value, evidence: "measured" as const });

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Groups `keys` under `prefix` by the attempt id their name starts with (`<id>/…` or `<id>.<suffix>`). */
const byAttempt = (keys: readonly string[], prefix: string): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const key of keys) {
    const rest = key.slice(prefix.length);
    const id = /^[0-9A-HJKMNP-TV-Z]{26}/.exec(rest)?.[0];
    if (id === undefined) continue;
    out.set(id, [...(out.get(id) ?? []), key]);
  }
  return out;
};

const quiesced = (name: string, what: string): string =>
  `stop plainport on every device that uses store ${name} and wait until none runs (detached deletes included), then remove ${what} from the store by hand; plainport never deletes a repository or a candidacy itself`;

export const testStore = async (io: LocalIo, options: TestStoreOptions): Promise<Result<StoreTestReport>> => {
  const { name, store, paths } = options;
  const findings: Finding[] = [];
  const location = storeLocation(store, paths.home);
  const registry = await readRegistry(io, paths);
  if (!registry.ok) return registry;
  const pinned = registry.value.stores?.[name];
  const reached = await reachStore(io, options);
  if (!reached.ok) return reached;
  const { blob, engine } = reached.value;
  const profile = blob.semantics();
  const report = (
    found: Partial<StoreTestReport> & { semantics: StoreSemantics; reachable: boolean },
  ): StoreTestReport => {
    const operations = Object.fromEntries(
      STORE_OPERATIONS.map((op) => {
        const verdict = eligibility(op, found.semantics);
        return [op, verdict.eligible ? { eligible: true } : { eligible: false, missing: verdict.missing }];
      }),
    ) as StoreTestReport["operations"];
    return {
      name,
      location,
      ...(pinned !== undefined && { pinned }),
      losing: [],
      contested: [],
      recorded: false,
      ok: false,
      findings,
      operations,
      ...found,
    };
  };

  // The identity first: it says whether the store answers at all, and which repository and winner are published.
  const identity = await readStoreDescriptor(blob);
  if (!identity.ok) {
    findings.push(identity.finding);
    if (identity.finding.code === "store.unreachable")
      return ok(report({ semantics: profile, reachable: false, delete: "unreachable" }));
  }
  const descriptor: StoreDescriptor | null = identity.ok ? identity.value : null;
  // A name pinned to a store only ever reaches that store (D85): nothing is written to another.
  if (identity.ok && pinned !== undefined && descriptor?.id !== pinned)
    return withFix(
      identityChanged(pinned, descriptor?.id ?? null, `store at ${location}`),
      `point stores.${name} back at the store this device set up as ${name} (${pinned}); a different store needs a new name; nothing was written to ${location}`,
    );

  // The probe: one key, written, read, listed, created again where a conditional create is claimed, deleted.
  const found: Partial<StoreSemantics> = {};
  const key = `${STORE_TEST_PREFIX}${options.mint()}.probe`;
  const value = new TextEncoder().encode(`plainport store test ${options.now().toISOString()}\n`);
  const put = await blob.put(key, value);
  if (!put.ok) {
    findings.push(put.finding);
    return ok(
      report({
        semantics: profile,
        reachable: put.finding.code !== "store.unreachable",
        ...idOf(descriptor),
      }),
    );
  }
  const got = await blob.get(key);
  if (got.ok) found.readAfterWrite = measured(got.value !== null && sameBytes(got.value, value));
  else findings.push(got.finding);
  const listed = await blob.list(STORE_TEST_PREFIX);
  if (listed.ok) found.listAfterWrite = measured(listed.value.some((entry) => entry.key === key));
  else findings.push(listed.finding);
  if (capabilitiesOf(profile).createIfAbsent) {
    const again = await blob.put(key, value, { ifNotExists: true });
    if (again.ok) found.conditionalCreate = measured(false);
    else if (again.finding.code === "store.key-exists") found.conditionalCreate = measured(true);
    else findings.push(again.finding);
  }
  let verdict: DeleteVerdict;
  const deleted = await blob.delete(key);
  if (!deleted.ok) verdict = deleted.finding.code === "store.unreachable" ? "unreachable" : "denied";
  else {
    const after = await blob.get(key);
    verdict = !after.ok
      ? after.finding.code === "store.unreachable"
        ? "unreachable"
        : "denied"
      : after.value === null
        ? "allowed"
        : "denied";
  }
  const semantics: StoreSemantics = { ...profile, ...found };

  // The repository at the store's published location, with this device's password; it is only listed.
  let repository: StoreTestReport["repository"];
  if (descriptor !== null) {
    const opens = await engine.list({ tags: ["plainport"] });
    repository = opens.ok ? { opens: true } : { opens: false, code: opens.finding.code };
    if (!opens.ok) findings.push(opens.finding);
  }

  // What bootstraps left: repositories that are not the published one, candidacies that are not the winner's.
  const losing: Leftover[] = [];
  const contested: Leftover[] = [];
  const repos = await blob.list(REPOS_PREFIX);
  if (repos.ok)
    for (const [attempt, keys] of byAttempt(
      repos.value.map((e) => e.key),
      REPOS_PREFIX,
    ))
      if (descriptor === null || `repos/${attempt}` !== descriptor.repo) losing.push({ attempt, keys });
  const claims = await blob.list(STORE_CLAIMS_PREFIX);
  if (claims.ok)
    for (const [attempt, keys] of byAttempt(
      claims.value.map((e) => e.key),
      STORE_CLAIMS_PREFIX,
    ))
      if (descriptor === null || attempt !== descriptor.id) contested.push({ attempt, keys });
  const leftovers = [
    ...losing.map((l) => `${REPOS_PREFIX}${l.attempt}/`),
    ...contested.flatMap((c) => c.keys),
  ];
  const cleanup = leftovers.length === 0 ? undefined : quiesced(name, leftovers.join(", "));

  const healthy =
    verdict !== "unreachable" && (repository?.opens ?? true) && found.readAfterWrite !== undefined;
  const at = options.now().toISOString();
  // Recorded under the store's own id, and only for the store this name is pinned to (D85).
  const id = descriptor?.id;
  const recordable = id !== undefined && (pinned === undefined || pinned === id);
  let recorded = false;
  if (recordable) {
    const written = await recordMeasured(io, paths, id, storeFacts(store, paths.home, options.tools), {
      semantics,
      test: { at, ok: healthy, delete: verdict },
    });
    if (written.ok) recorded = true;
    else findings.push(written.finding);
  }
  return ok(
    report({
      ...idOf(descriptor),
      reachable: verdict !== "unreachable",
      delete: verdict,
      semantics,
      ...(repository !== undefined && { repository }),
      losing,
      contested,
      ...(cleanup !== undefined && { cleanup }),
      recorded,
      ok: healthy,
    }),
  );
};

const idOf = (descriptor: StoreDescriptor | null): { id?: string; format?: 1 | 2 } =>
  descriptor === null ? {} : { id: descriptor.id, format: descriptor.format };
