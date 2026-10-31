// T2: every read the catalog makes through the rclone adapter, when it is the first call to meet a cut store (Toxiproxy's
// `cut` on the store's proxy), says store.unreachable, on S3 (SeaweedFS) and SFTP. A read that called a cut store
// store.failed would hide that the store only needs to come back (M2 Task 27: rclone's S3 backend took a root it could
// not check for a file, and its filtered cat said only "can't limit to single files when using filters"). The crash
// matrix's fault rows meet the cut at a listing or a get; getMany is the one read no row reaches first.

import { afterAll, expect, test } from "bun:test";
import { applyProfile, loadTestEnv } from "../../../scripts/testenv.ts";
import { describeT2 } from "../../../test/tiers.ts";
import { t2World, value } from "./testing/t2.ts";

afterAll(async () => {
  for (const proxy of ["s3", "sftp"] as const)
    try {
      await applyProfile(loadTestEnv(), proxy, "clear");
    } catch {}
}, 30_000);

for (const kind of ["s3", "sftp"] as const)
  describeT2(`blob-rclone on ${kind}, the store cut`, () => {
    test("get, getMany, list and stat each say store.unreachable when they meet the cut first", async () => {
      const world = await t2World();
      try {
        const store = world.store(world.remote(kind, `cut-${crypto.randomUUID()}`, { proxied: true }));
        value(await store.put("meta/v1/events/a.json", new TextEncoder().encode("{}\n")));
        value(await store.put("meta/v1/events/b.json", new TextEncoder().encode("{}\n")));
        await applyProfile(world.env, kind, "cut");
        const reads = {
          get: await store.get("meta/v1/events/a.json"),
          getMany: await store.getMany(["meta/v1/events/a.json", "meta/v1/events/b.json"]),
          list: await store.list("meta/v1/events/"),
          stat: await store.stat("meta/v1/events/a.json"),
        };
        await applyProfile(world.env, kind, "clear");
        expect(
          Object.fromEntries(
            Object.entries(reads).map(([read, r]) => [read, r.ok ? "ok" : `${r.finding.code}`]),
          ),
        ).toEqual({
          get: "store.unreachable",
          getMany: "store.unreachable",
          list: "store.unreachable",
          stat: "store.unreachable",
        });
      } finally {
        await applyProfile(world.env, kind, "clear");
        await world.dispose();
      }
    }, 300_000);
  });
