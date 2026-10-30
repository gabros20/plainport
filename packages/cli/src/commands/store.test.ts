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

describe("store upgrade: a ULID-shaped alias (D104, Q11)", () => {
  // An M1 alias shaped like a ULID that is not the store's id: a key, never read as an id.
  const ALIAS = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
  let other: Sandbox;
  afterEach(() => other?.cleanupSettled());

  test("events keyed by the alias still read after the upgrade, on its device and from another with another alias", async () => {
    // Device A: a fresh M1 store named by the alias (store.json v1 before init, as v0.1.x left it).
    const a = makeSandbox("plainport-alias-a-");
    try {
      a.dir("work");
      a.file("work/web/package.json", `${JSON.stringify({ name: "web" })}\n`);
      a.file("work/web/src/main.ts", "export const main = 1;\n");
      const shared = join(a.home, "disk");
      const storeId = "01J9Z6K2QF8M3V7XN4T5R6Y1AB";
      a.file("disk/meta/v1/store.json", `${JSON.stringify({ v: 1, id: storeId })}\n`);
      const onA = (argv: string[]) => capture(argv, REGISTRY, { ports: sandboxPorts(a.home) });
      const json = async (argv: string[]) => {
        const run = await onA([...argv, "--json"]);
        if (run.code !== 0) throw new Error(`${argv.join(" ")}: ${run.out}${run.err}`);
        return envelope(run.out).data;
      };
      expect(
        (
          await json([
            "init",
            "--root",
            "work=~/work",
            "--store-path",
            shared,
            "--store",
            ALIAS,
            "--device",
            "mbp",
            "--yes",
          ])
        ).store,
      ).toMatchObject({ id: storeId, format: 1 });
      const first = await json(["offload", "work:web", "--yes"]);
      const events = () =>
        readdirSync(join(shared, "meta/v1/events")).map((n) =>
          JSON.parse(readFileSync(join(shared, "meta/v1/events", n), "utf8")),
        );
      const offloaded = () => events().filter((e) => e.type === "offloaded");
      // Format 1: the alias keys it, for v0.1.1.
      expect(Object.keys(offloaded()[0].stored)).toEqual([ALIAS]);

      // The offload's detached delete holds a lock until the trash is gone; the upgrade waits for it (Q2's check 1).
      const trash = join(a.home, "work/.plainport-trash");
      for (let i = 0; i < 800 && existsSync(trash) && readdirSync(trash).length > 0; i++) await Bun.sleep(25);
      for (let i = 0; i < 800 && readdirSync(a.paths.journalDir).some((n) => n.endsWith(".json")); i++)
        await Bun.sleep(25);
      expect(await json(["store", "upgrade", ALIAS, "--others-stopped", "--yes"])).toMatchObject({
        upgraded: true,
      });
      // Read on its device after the upgrade: the head is the alias-keyed snapshot, and it onloads.
      const status = await json(["status", "work:web"]);
      expect(status.project?.head ?? status.head).toBe(first.snapshot);
      await json(["onload", "work:web"]);
      writeFileSync(join(a.home, "work/web/src/main.ts"), "export const main = 2;\n");
      const second = await json(["offload", "work:web", "--yes"]);
      // Format 2: the store's id keys what is written now.
      const latest = offloaded().find((e) => e.snapshot === second.snapshot);
      expect(Object.keys(latest.stored)).toEqual([storeId]);

      // Another device, another alias: it reads both events by containment and restores the head.
      other = makeSandbox("plainport-alias-b-");
      other.dir("work");
      const onB = (argv: string[]) => capture(argv, REGISTRY, { ports: sandboxPorts(other.home) });
      const setup = await onB([
        "init",
        "--root",
        "work=~/work",
        "--store-path",
        shared,
        "--store",
        "nas",
        "--device",
        "mini",
        "--yes",
        "--json",
      ]);
      expect(setup.code).toBe(0);
      expect(envelope(setup.out).data.store).toMatchObject({ id: storeId, format: 2 });
      for (const snapshot of [first.snapshot, second.snapshot]) {
        const to = join(other.home, `restored-${snapshot}`);
        const restored = await onB(["restore", "web", "--snapshot", snapshot, "--to", to, "--json"]);
        expect(restored.code, restored.out).toBe(0);
        expect(readFileSync(join(to, "src/main.ts"), "utf8")).toBe(
          snapshot === first.snapshot ? "export const main = 1;\n" : "export const main = 2;\n",
        );
      }
    } finally {
      await a.cleanupSettled();
    }
  });
});
