// M2 Task 18: `plainport recover` settles the store setups this device left open (saga/bootstrap.ts), with the store
// its config names, through the opener: an attempt stopped after its candidacy is published by recover, and one
// stopped before it is rolled back; the report says which, and a pending one fails recover with its finding.

import { afterEach, describe, expect, test } from "bun:test";
import type { Result } from "@plainport/contract";
import { ConfigLoader } from "../config/load.ts";
import { ensureDevice } from "../device.ts";
import { InjectedFault } from "../ports/host.ts";
import type { StoreOpener } from "../ports/store.ts";
import {
  type BootstrapDevice,
  type BootstrapWorld,
  bootstrapWorld,
  STORE_NAME,
} from "../testing/bootstrap-world.ts";
import { fakeEngine } from "../testing/fake-engine.ts";
import { testHost } from "../testing/host.ts";
import { memoryBlobStore } from "../testing/memory-blob-store.ts";
import { recover } from "./recover.ts";

let worlds: BootstrapWorld[] = [];
afterEach(() => {
  for (const w of worlds) w.cleanup();
  worlds = [];
});

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

/** recover on the device, its config naming the world's store, its opener reaching it as the device's bootstrap did. */
const recoverOn = async (w: BootstrapWorld, d: BootstrapDevice) => {
  d.box.file(
    ".config/plainport/config.toml",
    ["version = 1", `[stores.${STORE_NAME}]`, 'kind = "local"', 'path = "~/archive"'].join("\n"),
  );
  const made = value(await ensureDevice(testHost(), d.box.paths, { role: "owner", name: "mbp" }));
  const opener: StoreOpener = {
    open: async () =>
      ({
        ok: true,
        value: { blob: w.store, engine: fakeEngine(), engineAt: d.target.engineAt, location: w.location },
      }) as const,
  };
  return recover({
    host: testHost(),
    paths: d.box.paths,
    device: made.device,
    env: { HOME: d.box.home, PLAINPORT_STORE_PASSWORD: d.password },
    loader: new ConfigLoader(testHost(), d.box.paths),
    opener,
    openMirror: async () => ({ ok: true, value: memoryBlobStore() }),
    log: () => {},
  });
};

describe("recover: store setups left open", () => {
  test("an attempt stopped after its candidacy is published, and its id recorded", async () => {
    const w = bootstrapWorld();
    worlds.push(w);
    const d = w.device("pw", { faults: { at: "bootstrap.candidacy.written" } });
    await expect(d.run()).rejects.toBeInstanceOf(InjectedFault);
    const [attempt] = await d.journals();
    const report = value(await recoverOn(w, d));
    expect(report.bootstraps).toEqual([
      {
        attempt: attempt as string,
        store: STORE_NAME,
        step: "bootstrap.elect.start",
        outcome: "published",
        id: attempt,
      },
    ]);
    expect(await d.recorded()).toBe(attempt);
    expect(await d.journals()).toEqual([]);
  });

  test("an attempt stopped before its candidacy is rolled back: nothing is published", async () => {
    const w = bootstrapWorld();
    worlds.push(w);
    const d = w.device("pw", { faults: { at: "bootstrap.initialised" } });
    await expect(d.run()).rejects.toBeInstanceOf(InjectedFault);
    const report = value(await recoverOn(w, d));
    expect(report.bootstraps.map((b) => b.outcome)).toEqual(["rolled-back"]);
    expect(w.store.data.has("meta/v1/store.json")).toBe(false);
    expect(await d.recorded()).toBeUndefined();
  });

  test("an attempt holding the tie-break that waits out its budget (`waiting`, D109) is pending: store.bootstrap-undecided, exit 6", async () => {
    const w = bootstrapWorld();
    worlds.push(w);
    const d = w.device("pw", { faults: { at: "bootstrap.candidacy.written" } });
    await expect(d.run()).rejects.toBeInstanceOf(InjectedFault);
    // Another device's candidacy with a higher id stands and never refuses: this attempt holds the tie-break and waits.
    const rival = "7ZZZZZZZZZZZZZZZZZZZZZZZZZ";
    await w.store.put(
      `meta/v1/store-claims/${rival}.json`,
      new TextEncoder().encode(`${JSON.stringify({ v: 1, id: rival, decision: "candidate" })}\n`),
    );
    const result = await recoverOn(w, d);
    expect(result.ok ? "" : [result.exitCode, result.finding.code]).toEqual([6, "store.bootstrap-undecided"]);
    const report = (result.ok ? undefined : result.data) as { bootstraps: { outcome: string }[] } | undefined;
    expect(report?.bootstraps.map((b) => b.outcome)).toEqual(["pending"]);
    // Nothing published, nothing refused by this attempt, and its journal stays for a re-run with its id.
    expect(w.store.data.has("meta/v1/store.json")).toBe(false);
    expect([...w.store.data.keys()].filter((k) => k.endsWith(".refused"))).toEqual([]);
    expect(await d.journals()).toHaveLength(1);
  });

  test("a store config no longer names is pending, and recover fails with its finding", async () => {
    const w = bootstrapWorld();
    worlds.push(w);
    const d = w.device("pw", { faults: { at: "bootstrap.candidacy.written" } });
    await expect(d.run()).rejects.toBeInstanceOf(InjectedFault);
    d.box.file(".config/plainport/config.toml", "version = 1\n");
    const made = value(await ensureDevice(testHost(), d.box.paths, { role: "owner", name: "mbp" }));
    const result = await recover({
      host: testHost(),
      paths: d.box.paths,
      device: made.device,
      env: { HOME: d.box.home },
      loader: new ConfigLoader(testHost(), d.box.paths),
      opener: { open: async () => ({ ok: true, value: { blob: w.store, engine: fakeEngine() } }) },
      openMirror: async () => ({ ok: true, value: memoryBlobStore() }),
      log: () => {},
    });
    expect(result.ok ? "" : [result.exitCode, result.finding.code]).toEqual([6, "store.not-set-up"]);
    expect(await d.journals()).toHaveLength(1);
  });
});
