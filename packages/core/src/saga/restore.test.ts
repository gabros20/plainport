// plainport restore (D58) against a sandboxed home, an in-memory store and the fake engine (T0): a snapshot restored
// and verified side by side into a free path, with no lease, no hydration and no catalog event, also while the
// project's head is conflicted or incomplete (D44).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, finding, type Result } from "@plainport/contract";
import { nodePlugin } from "../../../eco-node/src/index.ts";
import { appendEvent, type CatalogEvent, readEvents, storeEventLog } from "../catalog/index.ts";
import { ConfigLoader } from "../config/load.ts";
import { type Device, ensureDevice } from "../device.ts";
import { readJournals } from "../journal/index.ts";
import type { HostPorts } from "../ports/host.ts";
import type { StoreOpener } from "../ports/store.ts";
import { readRegistry } from "../registry.ts";
import { type ProjectRef, resolveProject } from "../roots/address.ts";
import { setUpStore } from "../store.ts";
import { quietChecks } from "../testing/checks.ts";
import { type FakeEngine, fakeEngine } from "../testing/fake-engine.ts";
import { testHost } from "../testing/host.ts";
import { captureTree, type TreeCapture } from "../testing/invariants.ts";
import { type MemoryBlobStore, memoryBlobStore } from "../testing/memory-blob-store.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { ulid } from "../ulid.ts";
import { runOffload } from "./offload.ts";
import { runOnload } from "./onload.ts";
import { type RestoreDeps, runRestore } from "./restore.ts";

const PATH = process.env.PATH ?? "/usr/bin:/bin";

let box: Sandbox;
let device: Device;
let store: MemoryBlobStore;
let mirror: MemoryBlobStore;
let engine: FakeEngine;
let dir: string;

const opener: StoreOpener = { open: async () => ({ ok: true, value: { blob: store, engine } }) };

beforeEach(async () => {
  box = makeSandbox("plainport-restore-");
  box.file(
    ".config/plainport/config.toml",
    [
      "version = 1",
      'defaultStore = "ssd"',
      "[stores.ssd]",
      'kind = "local"',
      'path = "~/ssd"',
      "[roots.work]",
      'store = "ssd"',
      'on = { mbp = "~/work" }',
    ].join("\n"),
  );
  box.dir("ssd");
  const made = await ensureDevice(testHost(), box.paths, { role: "owner", name: "mbp" });
  if (!made.ok) throw new Error(made.finding.message);
  device = made.value.device;
  store = memoryBlobStore({ createIfAbsent: true });
  mirror = memoryBlobStore({ createIfAbsent: true });
  engine = fakeEngine();
  const setUp = await setUpStore(testHost(), {
    paths: box.paths,
    env: { PLAINPORT_STORE_PASSWORD: "pw" },
    name: "ssd",
    store: { kind: "local", path: "~/ssd" },
    opener,
    mint: () => ulid(),
  });
  if (!setUp.ok) throw new Error(setUp.finding.message);
  box.file("work/web/package.json", `${JSON.stringify({ name: "web" })}\n`);
  box.file("work/web/package-lock.json", `${JSON.stringify({ lockfileVersion: 3 })}\n`);
  box.file("work/web/src/main.ts", "export const main = 1;\n");
  box.file("work/web/.env", "TOKEN=op://vault/item\n");
  box.file("work/web/node_modules/dep/index.js", "x".repeat(400));
  symlinkSync("src/main.ts", join(box.home, "work/web/main-link"));
  dir = join(box.home, "work/web");
});

afterEach(() => box.cleanup());

const env = () => ({ HOME: box.home, PATH, PLAINPORT_STORE_PASSWORD: "pw" });

const ref = async (input = "work:web"): Promise<ProjectRef> => {
  const resolved = await resolveProject(testHost(), box.paths, input, {
    cwd: box.home,
    env: { HOME: box.home },
    device: "mbp",
  });
  if (!resolved.ok) throw new Error(resolved.finding.message);
  return resolved.value;
};

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

const deps = (host: HostPorts = testHost()): RestoreDeps => ({
  host,
  paths: box.paths,
  device,
  env: env(),
  loader: new ConfigLoader(host, box.paths),
  opener,
  openMirror: async () => ({ ok: true, value: mirror }),
  emit: () => {},
  log: () => {},
});

const offload = async () =>
  value(
    await runOffload(
      {
        host: testHost(),
        checks: quietChecks,
        plugins: [nodePlugin],
        paths: box.paths,
        device,
        env: env(),
        loader: new ConfigLoader(testHost(), box.paths),
        opener,
        openMirror: async () => ({ ok: true, value: mirror }),
        emit: () => {},
        log: () => {},
      },
      { project: await ref() },
    ),
  );

const onload = async () =>
  value(
    await runOnload(
      {
        host: testHost(),
        plugins: [nodePlugin],
        paths: box.paths,
        device,
        env: env(),
        loader: new ConfigLoader(testHost(), box.paths),
        opener,
        openMirror: async () => ({ ok: true, value: mirror }),
        emit: () => {},
        log: () => {},
      },
      { project: await ref(), hydrate: false },
    ),
  );

const storeEvents = async (): Promise<CatalogEvent[]> => value(await readEvents(storeEventLog(store))).events;

/** Everything a restore must leave as it was: the events, the registry, the journals, the stub. */
const untouched = async () => ({
  events: (await storeEvents()).map((e) => e.id),
  registry: value(await readRegistry(testHost(), box.paths)),
  journals: (await readJournals(testHost(), box.paths)).journals,
  stub: existsSync(`${dir}.plainport`) ? readFileSync(`${dir}.plainport`, "utf8") : undefined,
});

const without = (tree: TreeCapture, prefix: string): TreeCapture =>
  new Map([...tree].filter(([path]) => path !== prefix && !path.startsWith(`${prefix}/`)));

const waitTrashGone = async () => {
  const holder = join(box.home, "work/.plainport-trash");
  for (let i = 0; i < 400 && existsSync(holder) && readdirSync(holder).length > 0; i++) await Bun.sleep(25);
};

describe("restore: a snapshot side by side (D58)", () => {
  test("the head lands in a free path, verified: no lease, no hydration, no event, the stub stays", async () => {
    const before = captureTree(dir);
    const shelved = await offload();
    await waitTrashGone();
    const was = await untouched();
    const to = join(box.home, "old/web");
    const restored = value(await runRestore(deps(), { project: await ref(), to }));
    expect(restored).toMatchObject({
      project: "work:web",
      snapshot: shelved.snapshot,
      store: "ssd",
      dir: to,
    });
    expect(captureTree(to)).toEqual(without(before, "node_modules"));
    expect(existsSync(join(to, "node_modules"))).toBe(false);
    expect(await untouched()).toEqual(was);
    expect(existsSync(join(box.home, "old/.plainport-staging"))).toBe(false);
    expect(engine.restores.map((r) => r.snapshot)).toHaveLength(1);
  });

  test("an older snapshot by id, beside the project's own working copy", async () => {
    const first = await offload();
    await waitTrashGone();
    await onload();
    writeFileSync(join(dir, "src/main.ts"), "export const main = 2;\n");
    await offload();
    await waitTrashGone();
    await onload();
    const to = join(box.home, "old/web-1");
    value(await runRestore(deps(), { project: await ref(), snapshot: first.snapshot, to }));
    expect(readFileSync(join(to, "src/main.ts"), "utf8")).toBe("export const main = 1;\n");
    expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe("export const main = 2;\n");
  });

  test("an occupied path refuses (path.occupied) and nothing is written", async () => {
    await offload();
    const to = box.dir("old/web");
    writeFileSync(join(to, "mine.txt"), "mine\n");
    const result = await runRestore(deps(), { project: await ref(), to });
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "path.occupied"]);
    expect(readdirSync(to)).toEqual(["mine.txt"]);
    expect(engine.restores).toEqual([]);
  });

  test("a path inside a registered project's folder refuses (project.nested)", async () => {
    await offload();
    await waitTrashGone();
    await onload();
    const result = await runRestore(deps(), { project: await ref(), to: join(dir, "old") });
    expect(result.ok ? 0 : result.finding.code).toBe("project.nested");
    expect(existsSync(join(dir, "old"))).toBe(false);
  });

  test("an unknown snapshot is snapshot.not-found (4)", async () => {
    await offload();
    const result = await runRestore(deps(), {
      project: await ref(),
      snapshot: ulid(),
      to: join(box.home, "x"),
    });
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([4, "snapshot.not-found"]);
  });

  test("allowed while the head is conflicted (D44): by id; without one it names --snapshot", async () => {
    const mine = await offload();
    const id = Object.keys(value(await readRegistry(testHost(), box.paths)).projects)[0] as string;
    const rootId = value(await readRegistry(testHost(), box.paths)).roots?.work as string;
    const s = ulid();
    value(
      await appendEvent(storeEventLog(store), {
        v: 1,
        id: s,
        op: s,
        type: "offloaded",
        device: ulid(),
        at: "2026-10-02T00:00:00.000Z",
        project: id,
        root: rootId,
        path: "web",
        snapshot: s,
        stored: { ssd: "c".repeat(64) },
        stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
      }),
    );
    const bare = await runRestore(deps(), { project: await ref(), to: join(box.home, "a") });
    expect(bare.ok ? 0 : bare.finding.code).toBe("catalog.head-moved");
    expect(bare.ok ? "" : bare.finding.fix).toContain("--snapshot");
    value(
      await runRestore(deps(), { project: await ref(), snapshot: mine.snapshot, to: join(box.home, "b") }),
    );
    expect(readFileSync(join(box.home, "b/src/main.ts"), "utf8")).toBe("export const main = 1;\n");
  });

  test("allowed while the head is incomplete (D44): by id", async () => {
    const mine = await offload();
    const id = Object.keys(value(await readRegistry(testHost(), box.paths)).projects)[0] as string;
    const rootId = value(await readRegistry(testHost(), box.paths)).roots?.work as string;
    const s = ulid();
    value(
      await appendEvent(storeEventLog(store), {
        v: 1,
        id: s,
        op: s,
        type: "offloaded",
        device: ulid(),
        at: "2026-10-02T00:00:00.000Z",
        project: id,
        root: rootId,
        path: "web",
        base: ulid(),
        snapshot: s,
        stored: { ssd: "c".repeat(64) },
        stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
      }),
    );
    const bare = await runRestore(deps(), { project: await ref(), to: join(box.home, "a") });
    expect(bare.ok ? 0 : bare.finding.code).toBe("catalog.incomplete");
    value(
      await runRestore(deps(), { project: await ref(), snapshot: mine.snapshot, to: join(box.home, "b") }),
    );
    expect(existsSync(join(box.home, "b/src/main.ts"))).toBe(true);
  });

  test("a restored tree that does not match the listing is removed (verify.mismatch, 7)", async () => {
    await offload();
    engine.hooks.duringRestore = (target) =>
      writeFileSync(join(target, "src/main.ts"), "damaged, longer than before\n");
    const to = join(box.home, "old/web");
    const result = await runRestore(deps(), { project: await ref(), to });
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([7, "verify.mismatch"]);
    expect(existsSync(to)).toBe(false);
    expect(existsSync(join(box.home, "old/.plainport-staging"))).toBe(false);
  });

  test("a store that cannot restore leaves nothing behind", async () => {
    await offload();
    engine.hooks.failNext = { restore: fail(finding("store.unreachable", { message: "the disk is gone" })) };
    const to = join(box.home, "old/web");
    const result = await runRestore(deps(), { project: await ref(), to });
    expect(result.ok ? 0 : result.finding.code).toBe("store.unreachable");
    expect(existsSync(to)).toBe(false);
    expect(existsSync(join(box.home, "old/.plainport-staging"))).toBe(false);
  });
});
