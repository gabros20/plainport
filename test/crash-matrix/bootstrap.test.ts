// The crash matrix for bootstrap (ADR-0017, DESIGN.md "Bootstrap"): for every bootstrap row (matrix.ts), on a store
// with a proven conditional create and on one that elects by the sole-candidate rule, crash the attempt at the row's
// step or seam (an InjectedFault from the host's faultAt), run the bootstrap recovery, and check that it settles to
// one of "published by this attempt", "lost", "contested" or "rolled back (nothing published)", within what the row's
// rule allows, with the store, the registry and the journal agreeing, and a second recovery with nothing to do.

import { afterEach, describe, expect, test } from "bun:test";
import { STORE_CLAIMS_PREFIX, STORE_IDENTITY_KEY } from "../../packages/core/src/catalog/identity.ts";
import { InjectedFault } from "../../packages/core/src/ports/host.ts";
import type { BootstrapRecoveryOutcome } from "../../packages/core/src/saga/bootstrap.ts";
import {
  type BootstrapWorld,
  bootstrapWorld,
  keysUnder,
  publishedStore,
} from "../../packages/core/src/testing/bootstrap-world.ts";
import { ulid } from "../../packages/core/src/ulid.ts";
import { BOOTSTRAP_ROWS, type BootstrapRow } from "./matrix.ts";

const ROUTES = [
  ["conditional create", {}],
  ["sole candidate", { conditionalCreate: false }],
] as const;

let worlds: BootstrapWorld[] = [];
afterEach(() => {
  for (const w of worlds) w.cleanup();
  worlds = [];
});

const record = (id: string, decision: string) =>
  new TextEncoder().encode(`${JSON.stringify({ v: 1, id, decision })}\n`);

/** What recovery must settle the row to: before the candidacy nothing is published; a rival makes it contested. */
const expected = (row: BootstrapRow): BootstrapRecoveryOutcome =>
  row.scenario === "rival"
    ? "contested"
    : row.step === "bootstrap.begin" || row.step === "bootstrap.initialised"
      ? "rolled-back"
      : "published";

describe("crash matrix: bootstrap", () => {
  for (const [route, options] of ROUTES) {
    for (const row of BOOTSTRAP_ROWS) {
      test(`bootstrap · ${row.name} · ${route}`, async () => {
        const w = bootstrapWorld(options);
        worlds.push(w);
        if (row.scenario === "rival") {
          // Another device's attempt stood and refused: this attempt sees it, refuses, and the outcome is final.
          const rival = ulid();
          await w.store.put(`${STORE_CLAIMS_PREFIX}${rival}.json`, record(rival, "candidate"));
          await w.store.put(`${STORE_CLAIMS_PREFIX}${rival}.refused`, record(rival, "refused"));
        }
        const device = w.device("pw", { faults: { at: row.point } });
        await expect(device.run()).rejects.toBeInstanceOf(InjectedFault);
        const [attempt] = await device.journals();
        expect(attempt).toBeDefined();
        const id = attempt as string;
        expect(row.step).toBeDefined();

        device.ports.faultAt = () => {};
        const settled = await device.recover();
        if (!settled.ok) throw new Error(`${settled.finding.code}: ${settled.finding.message}`);
        const [op, ...more] = settled.value.operations;
        expect(more).toEqual([]);
        expect(op).toMatchObject({ attempt: id, step: row.step });
        expect(row.outcomes).toContain(op?.outcome as BootstrapRecoveryOutcome);
        expect(op?.outcome).toBe(expected(row));

        // The store, this device's registry and its journal agree with the outcome.
        const published = publishedStore(w.store);
        if (op?.outcome === "published") {
          expect(published).toMatchObject({ v: 2, id, repo: `repos/${id}`, format: 2 });
          expect(w.repos.get(`repos/${id}`)).toMatchObject({ initialized: true, password: "pw" });
          expect(await device.recorded()).toBe(id);
        } else {
          expect(w.store.data.has(STORE_IDENTITY_KEY)).toBe(false);
          expect(await device.recorded()).toBeUndefined();
        }
        if (op?.outcome === "rolled-back")
          expect(keysUnder(w.store, `${STORE_CLAIMS_PREFIX}${id}`)).toEqual([]);
        if (op?.outcome === "contested")
          expect(keysUnder(w.store, `${STORE_CLAIMS_PREFIX}${id}`)).toEqual([
            `${STORE_CLAIMS_PREFIX}${id}.json`,
            `${STORE_CLAIMS_PREFIX}${id}.refused`,
          ]);
        expect(await device.journals()).toEqual([]);
        const again = await device.recover();
        expect(again.ok && again.value.operations).toEqual([]);

        // Rolled back, the store is as if the attempt never ran: a retry sets it up.
        if (op?.outcome === "rolled-back") {
          const retry = await device.run();
          expect(retry.ok && retry.value.outcome).toBe("published");
        }
      });
    }
  }
});
