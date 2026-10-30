// T2: the catalog over remote stores (M2 Task 21), on the S3 store (SeaweedFS, D94) and SFTP that `scripts/testenv up`
// brings up. A sync of a store holding 1,000 events starts two rclone processes, one listing and one batch read,
// besides the identity read; a sync with nothing new starts none for events. The times are recorded (printed).

import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunSpec } from "@plainport/core";
import { describeT2 } from "../../../test/tiers.ts";
import { encodePlain } from "../../core/src/catalog/codec.ts";
import { type CatalogEvent, CatalogEventSchema } from "../../core/src/catalog/events.ts";
import { loadCatalog } from "../../core/src/catalog/log.ts";
import { testHost } from "../../core/src/testing/host.ts";
import { memoryBlobStore } from "../../core/src/testing/memory-blob-store.ts";
import { ulid } from "../../core/src/ulid.ts";
import { type Backend, purgeRoot, seedFrom, t2World } from "./testing/t2.ts";

const EVENTS = 1_000;
const idAt = (ms: number) => ulid(ms, (b) => b.fill(0));
const PROJECT = idAt(1);

const event = (n: number): CatalogEvent =>
  CatalogEventSchema.parse({
    v: 1,
    id: idAt(1_000_000 + n),
    type: "offloaded",
    device: idAt(3),
    at: "2026-10-29T12:00:00.000Z",
    op: idAt(500_000 + n),
    project: PROJECT,
    root: idAt(2),
    path: "web",
    snapshot: idAt(500_000 + n),
    ...(n === 1 ? {} : { base: idAt(500_000 + n - 1) }),
    stored: { s3: "cd".repeat(32) },
    stats: { files: 3, bytes: 30, strippedBytes: 0, ecosystems: ["node"] },
  });

/** The rclone subcommand a run was for. */
const VERBS = ["cat", "lsjson", "copy", "rcat", "moveto", "deletefile", "mkdir"];
const verbOf = (spec: RunSpec): string => spec.args?.find((a) => VERBS.includes(a)) ?? "?";

for (const backend of ["s3", "sftp"] as const satisfies readonly Backend[]) {
  describeT2(`catalog remote on ${backend}`, () => {
    test(`a ${EVENTS}-event sync starts two rclone processes for its events, one listing and one batch read`, async () => {
      const world = await t2World();
      const remote = world.remote(backend, `catalog-${crypto.randomUUID()}`);
      const runs: string[] = [];
      const host = testHost();
      const counting = {
        ...host,
        run: (spec: RunSpec) => {
          runs.push(verbOf(spec));
          return host.run(spec);
        },
      };
      const store = world.store(remote, { host: counting });
      try {
        // The store's identity and its events, seeded in one rclone run.
        const storeId = idAt(900);
        const local = world.sandbox.dir("seed/meta/v1");
        writeFileSync(join(local, "store.json"), `${JSON.stringify({ v: 1, id: storeId })}\n`);
        mkdirSync(join(local, "events"));
        for (let n = 1; n <= EVENTS; n++) {
          const e = event(n);
          writeFileSync(join(local, "events", `${e.id}.json`), encodePlain(e));
        }
        seedFrom(world, remote, world.sandbox.dir("seed/meta"), "meta");

        const mirror = memoryBlobStore({ createIfAbsent: true });
        runs.length = 0;
        const started = performance.now();
        const first = await loadCatalog({ store, mirror, storeId, now: new Date() });
        const firstMs = performance.now() - started;
        if (!first.ok) throw new Error(`${first.finding.code}: ${first.finding.message}`);
        expect([first.value.stale, first.value.copied, first.value.findings]).toEqual([false, EVENTS, []]);
        expect(first.value.state.projects[PROJECT]?.head).toBe(idAt(500_000 + EVENTS));
        // The identity file (outside the sync), then the sync's two: one listing, one batch read; 3 runs in all (M4).
        expect(runs).toEqual(["cat", "lsjson", "copy"]);

        runs.length = 0;
        const again = performance.now();
        const second = await loadCatalog({ store, mirror, storeId, now: new Date() });
        const secondMs = performance.now() - again;
        expect(second.ok && [second.value.copied, second.value.cached]).toEqual([0, true]);
        expect(runs).toEqual(["cat", "lsjson"]);
        console.log(
          `catalog remote on ${backend}: first sync of ${EVENTS} events ${Math.round(firstMs)} ms (3 rclone runs), sync with nothing new ${Math.round(secondMs)} ms (2 rclone runs)`,
        );
      } finally {
        purgeRoot(world, remote);
        world.cleanup();
      }
    }, 600_000);
  });
}
