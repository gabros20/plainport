// The store commands through the CLI: an upgrade killed at each of its seams leaves its marker on the store and its
// journal here; while it stands an offload refuses, and `plainport recover` clears it (Q2's crash rows).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testHost } from "../../../core/src/testing/host.ts";
import { makeSandbox, type Sandbox } from "../../../core/src/testing/sandbox.ts";
import { capture, sandboxPorts } from "../testing.ts";
import { REGISTRY } from "./index.ts";

let box: Sandbox;
const store = () => join(box.home, "ssd");
const marker = () => join(store(), "meta/v1/upgrade-intent.json");
const identity = () => JSON.parse(readFileSync(join(store(), "meta/v1/store.json"), "utf8"));
const upgradeJournals = () => {
  const dir = join(box.paths.journalDir, "upgrade");
  return existsSync(dir) ? readdirSync(dir) : [];
};
const cli = (argv: string[], at?: string) =>
  capture(argv, REGISTRY, {
    ports: sandboxPorts(box.home, at === undefined ? {} : { system: testHost({ faults: { at } }) }),
  });
const envelope = (out: string) => JSON.parse(out.trim().split("\n").at(-1) as string);

beforeEach(async () => {
  box = makeSandbox("plainport-store-cli-");
  box.dir("work");
  box.file("work/web/package.json", `${JSON.stringify({ name: "web" })}\n`);
  const run = await cli([
    "init",
    "--root",
    "work=~/work",
    "--store-path",
    "~/ssd",
    "--device",
    "mbp",
    "--yes",
  ]);
  if (run.code !== 0) throw new Error(run.err);
  // An M1 store, as v0.1.x's init leaves it: format 1 under the same id.
  writeFileSync(join(store(), "meta/v1/store.json"), `${JSON.stringify({ v: 1, id: identity().id })}\n`);
});
afterEach(() => box.cleanupSettled());

describe("store upgrade: crash rows (Q2)", () => {
  for (const [seam, format] of [
    ["upgrade.intent.written", 1],
    ["upgrade.replaced", 2],
  ] as const) {
    test(`killed at ${seam}: the marker stands, an offload refuses, recover clears it`, async () => {
      const crashed = await cli(["store", "upgrade", "local", "--others-stopped", "--yes"], seam);
      expect(crashed.code).toBe(1);
      expect(existsSync(marker())).toBe(true);
      expect(upgradeJournals()).toHaveLength(1);
      expect(identity().v).toBe(format);

      const offload = await cli(["offload", "work:web", "--yes", "--json"]);
      expect(offload.code).toBe(6);
      expect(envelope(offload.out).error.finding.code).toBe("store.not-quiescent");

      const recovered = await cli(["recover", "--json"]);
      expect(recovered.code).toBe(0);
      expect(envelope(recovered.out).data.upgrades).toEqual([
        expect.objectContaining({ store: "local", outcome: "cleared", format }),
      ]);
      expect(existsSync(marker())).toBe(false);
      expect(upgradeJournals()).toEqual([]);
      expect(identity().v).toBe(format);
      // And the upgrade runs again to the end.
      const again = await cli(["store", "upgrade", "local", "--others-stopped", "--yes", "--json"]);
      expect(again.code).toBe(0);
      expect(identity().v).toBe(2);
      expect(upgradeJournals()).toEqual([]);
    });
  }

  test("a finished upgrade leaves no marker and no journal", async () => {
    const run = await cli(["store", "upgrade", "local", "--others-stopped", "--yes", "--json"]);
    expect(run.code).toBe(0);
    expect(envelope(run.out).data).toMatchObject({ from: 1, format: 2, upgraded: true });
    expect(existsSync(marker())).toBe(false);
    expect(upgradeJournals()).toEqual([]);
  });
});
