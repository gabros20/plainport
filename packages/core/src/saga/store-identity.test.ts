// Stable store identity (Q11, Task 9): a snapshot's location is the store its event was read from, never this device's
// alias for that store. Two sandboxed homes share one in-memory store and the fake engine (T0); each names the store
// as it likes, and every run ends with invariants 1–3 and the writers' rule for `stored` (testing/invariants.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Failure } from "@plainport/contract";
import { fail, finding } from "@plainport/contract";
import { nodePlugin } from "../../../eco-node/src/index.ts";
import {
  appendEvent,
  type CatalogEvent,
  encodeEvent,
  readEvents,
  STORE_EVENTS_PREFIX,
  storeEventLog,
} from "../catalog/index.ts";
import { ConfigLoader } from "../config/load.ts";
import { type Device, ensureDevice } from "../device.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { HostPorts } from "../ports/host.ts";
import type { StoreOpener } from "../ports/store.ts";
import { readRegistry } from "../registry.ts";
import { type ProjectRef, resolveProject } from "../roots/address.ts";
import { projectViews } from "../status/projects.ts";
import { setUpStore } from "../store.ts";
import { quietChecks } from "../testing/checks.ts";
import { type FakeEngine, fakeEngine } from "../testing/fake-engine.ts";
import { testHost } from "../testing/host.ts";
import { captureTree, invariantViolations, type TreeCapture } from "../testing/invariants.ts";
import { type MemoryBlobStore, memoryBlobStore } from "../testing/memory-blob-store.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { settledOffload } from "../testing/settle.ts";
import { ulid } from "../ulid.ts";
import { runOffload } from "./offload.ts";
import { runOnload } from "./onload.ts";
import { runRestore } from "./restore.ts";

/** One device: its home, its name for the shared store, its event mirror. */
interface Home {
  box: Sandbox;
  device: Device;
  /** This home's names for the shared store (the first is its root's). */
  aliases: string[];
  mirror: MemoryBlobStore;
}

let store: MemoryBlobStore;
let engine: FakeEngine;
let homes: Home[];
/** Names whose store does not answer (an unplugged disk). */
let offline: Set<string>;

const unreachable = (): Failure =>
  fail(finding("store.unreachable", { message: "the disk is not mounted (test)" }));

/** A store every call of which fails as an unplugged disk does. */
const unplugged = (of: BlobStore): BlobStore => ({
  capabilities: () => of.capabilities(),
  semantics: () => of.semantics(),
  get: async () => unreachable(),
  put: async () => unreachable(),
  list: async () => unreachable(),
  stat: async () => unreachable(),
  delete: async () => unreachable(),
});

const opener: StoreOpener = {
  open: async (name) => ({ ok: true, value: { blob: offline.has(name) ? unplugged(store) : store, engine } }),
};

const value = <T>(
  result: { ok: true; value: T } | { ok: false; finding: { code: string; message: string } },
): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

/** The config of a home whose root `work` uses `aliases[0]`, each alias a local store at ~/ssd. */
const configOf = (home: { box: Sandbox; aliases: string[] }, device: string, extra = "") =>
  home.box.file(
    ".config/plainport/config.toml",
    [
      "version = 1",
      `defaultStore = ${JSON.stringify(home.aliases[0])}`,
      ...home.aliases.flatMap((alias) => [
        `[stores.${JSON.stringify(alias)}]`,
        'kind = "local"',
        'path = "~/ssd"',
      ]),
      "[roots.work]",
      `store = ${JSON.stringify(home.aliases[0])}`,
      `on = { ${device} = "~/work" }`,
      extra,
    ].join("\n"),
  );

const makeHome = async (device: string, aliases: string[]): Promise<Home> => {
  const box = makeSandbox("plainport-store-identity-");
  configOf({ box, aliases }, device);
  box.dir("ssd");
  box.dir("work");
  const made = value(await ensureDevice(testHost(), box.paths, { role: "owner", name: device }));
  for (const name of aliases)
    value(
      await setUpStore(testHost(), {
        paths: box.paths,
        env: { PLAINPORT_STORE_PASSWORD: "pw" },
        name,
        store: { kind: "local", path: "~/ssd" },
        opener,
        mint: () => ulid(),
      }),
    );
  const home = { box, device: made.device, aliases, mirror: memoryBlobStore({ createIfAbsent: true }) };
  homes.push(home);
  return home;
};

beforeEach(() => {
  store = memoryBlobStore({ createIfAbsent: true });
  engine = fakeEngine();
  homes = [];
  offline = new Set();
  released.clear();
});

afterEach(async () => {
  for (const home of homes) await home.box.cleanupSettled();
});

const env = (home: Home) => ({ HOME: home.box.home, PATH: "/usr/bin:/bin", PLAINPORT_STORE_PASSWORD: "pw" });

const common = (home: Home, host: HostPorts = testHost()) => ({
  host,
  paths: home.box.paths,
  device: home.device,
  env: env(home),
  loader: new ConfigLoader(host, home.box.paths),
  opener,
  openMirror: async () => ({ ok: true as const, value: home.mirror }),
  emit: () => {},
  log: () => {},
});

const ref = async (home: Home, input = "work:web"): Promise<ProjectRef> =>
  value(
    await resolveProject(testHost(), home.box.paths, input, {
      cwd: home.box.home,
      env: { HOME: home.box.home },
      device: home.device.name,
    }),
  );

/** A small project in the home's root. */
const project = (home: Home, text = "one") => {
  home.box.file("work/web/package.json", `${JSON.stringify({ name: "web" })}\n`);
  home.box.file("work/web/src/main.ts", `export const main = "${text}";\n`);
  home.box.file("work/web/run.sh", "#!/bin/sh\necho hi\n");
  chmodSync(join(home.box.home, "work/web/run.sh"), 0o755);
};

/** Each home's folder as it stood when its last offload began: what invariant 1 checks a shelved one against. */
const released = new Map<Home, TreeCapture>();

const offload = async (home: Home, store?: string) => {
  released.set(home, captureTree(join(home.box.home, "work/web")));
  const done = value(
    await runOffload(
      { ...common(home), checks: quietChecks, plugins: [nodePlugin] },
      { project: await ref(home), ...(store === undefined ? {} : { store }) },
    ),
  );
  if (done.keepUntil === undefined) await settledOffload(home.box.paths, done);
  return done;
};

const onload = async (home: Home, req: { store?: string; snapshot?: string } = {}) =>
  runOnload({ ...common(home), plugins: [nodePlugin] }, { project: await ref(home), hydrate: false, ...req });

const events = async (): Promise<CatalogEvent[]> => value(await readEvents(storeEventLog(store))).events;

const offloadedOf = async (snapshot: string) =>
  (await events()).find(
    (e): e is Extract<CatalogEvent, { type: "offloaded" }> =>
      e.type === "offloaded" && e.snapshot === snapshot,
  ) as Extract<CatalogEvent, { type: "offloaded" }>;

/** Rewrites an event file in place, as another writer would have written it. */
const rewrite = (event: CatalogEvent) =>
  store.data.set(`${STORE_EVENTS_PREFIX}${event.id}.json`, encodeEvent(event));

const storeId = async (home: Home): Promise<string> =>
  value(await readRegistry(testHost(), home.box.paths)).stores?.[home.aliases[0] as string] as string;

const projectIdOf = async (home: Home): Promise<string | undefined> =>
  Object.entries(value(await readRegistry(testHost(), home.box.paths)).projects).find(
    ([, e]) => e.path === "web",
  )?.[0];

const expectInvariants = async (home: Home, alias = home.aliases[0] as string) =>
  expect(
    await invariantViolations({
      now: new Date(),
      paths: home.box.paths,
      device: home.device.id,
      project: { id: await projectIdOf(home), dir: join(home.box.home, "work/web") },
      roots: [join(home.box.home, "work")],
      store: { name: alias, blob: store, engine },
      ...(released.has(home) ? { released: released.get(home) as TreeCapture } : {}),
    }),
  ).toEqual([]);

const mainOf = (home: Home): string => readFileSync(join(home.box.home, "work/web/src/main.ts"), "utf8");

describe("store identity: a snapshot is located on the store its event was read from (Q11)", () => {
  test("[stored] two homes call one store archive and nas, and each reads the other's snapshots", async () => {
    const mbp = await makeHome("mbp", ["archive"]);
    const mini = await makeHome("mini", ["nas"]);
    expect(await storeId(mini)).toBe(await storeId(mbp));
    project(mbp, "from mbp");
    const first = await offload(mbp);
    // The writers' rule on a format-1 store: one entry, keyed by the writer's own alias (v0.1.1 looks it up so).
    expect(Object.keys((await offloadedOf(first.snapshot)).stored)).toEqual(["archive"]);
    await expectInvariants(mbp);

    value(await onload(mini));
    expect(mainOf(mini)).toContain("from mbp");
    await expectInvariants(mini);
    mini.box.file("work/web/src/main.ts", 'export const main = "from mini";\n');
    const second = await offload(mini);
    expect(Object.keys((await offloadedOf(second.snapshot)).stored)).toEqual(["nas"]);
    await expectInvariants(mini);

    value(await onload(mbp));
    expect(mainOf(mbp)).toContain("from mini");
    await expectInvariants(mbp);
  });

  test("[stored] (format 2) an event keyed by the store's id is read by homes that call the store archive and nas", async () => {
    const mbp = await makeHome("mbp", ["archive"]);
    const mini = await makeHome("mini", ["nas"]);
    project(mbp, "keyed by id");
    const done = await offload(mbp);
    // A format-2 writer keys the entry by the store's id (storedKey): the same event, as such a writer leaves it.
    const event = await offloadedOf(done.snapshot);
    const id = await storeId(mbp);
    rewrite({ ...event, stored: { [id]: event.stored.archive as string } });

    const side = join(mini.box.home, "side");
    value(await runRestore(common(mini), { project: await ref(mini), to: side }));
    expect(readFileSync(join(side, "src/main.ts"), "utf8")).toContain("keyed by id");
    value(await onload(mini));
    expect(mainOf(mini)).toContain("keyed by id");
  });

  test("[stored] one store under two names on one device: written under one name, read under the other", async () => {
    const mbp = await makeHome("mbp", ["archive", "nas"]);
    const registry = value(await readRegistry(testHost(), mbp.box.paths));
    expect(registry.stores?.archive).toBe(registry.stores?.nas as string);
    project(mbp, "two names");
    await offload(mbp, "archive");
    value(await onload(mbp, { store: "nas" }));
    expect(mainOf(mbp)).toContain("two names");
    mbp.box.file("work/web/src/main.ts", 'export const main = "again";\n');
    const again = await offload(mbp, "nas");
    expect(Object.keys((await offloadedOf(again.snapshot)).stored)).toEqual(["nas"]);
    value(await onload(mbp, { store: "archive" }));
    expect(mainOf(mbp)).toContain("again");
  });

  test("[stored] a legacy M1 event keyed by another device's alias, read from S, resolves to S", async () => {
    const mbp = await makeHome("mbp", ["ssd"]);
    project(mbp, "legacy");
    const done = await offload(mbp);
    // As v0.1.1 on a device that called the store `local` wrote it: M1-shaped, its key no alias of this device.
    const event = await offloadedOf(done.snapshot);
    rewrite({ ...event, stored: { local: event.stored.ssd as string } });
    value(await onload(mbp));
    expect(mainOf(mbp)).toContain("legacy");
  });

  test("[stored] a ULID-shaped M1 alias that is not the store's id resolves to S, on its device and on another", async () => {
    const shaped = ulid();
    const mbp = await makeHome("mbp", [shaped]);
    expect(await storeId(mbp)).not.toBe(shaped);
    const mini = await makeHome("mini", ["nas"]);
    project(mbp, "ulid alias");
    const done = await offload(mbp);
    expect(Object.keys((await offloadedOf(done.snapshot)).stored)).toEqual([shaped]);
    await expectInvariants(mbp);
    // Read on its own device, then from another device with a different alias: the key is never interpreted.
    const side = join(mbp.box.home, "side");
    value(await runRestore(common(mbp), { project: await ref(mbp), to: side }));
    expect(readFileSync(join(side, "src/main.ts"), "utf8")).toContain("ulid alias");
    value(await onload(mini));
    expect(mainOf(mini)).toContain("ulid alias");
  });

  test("[stored] an event with two stored entries is skipped (stored-multiple) and makes the project uncertain", async () => {
    const mbp = await makeHome("mbp", ["ssd"]);
    project(mbp, "multi");
    const done = await offload(mbp);
    const event = await offloadedOf(done.snapshot);
    rewrite({ ...event, stored: { ssd: event.stored.ssd as string, b2: "d".repeat(64) } });
    const read = value(await readEvents(storeEventLog(store)));
    expect(read.events.some((e) => e.id === event.id)).toBe(false);
    expect(read.findings.map((f) => f.message).join("\n")).toContain("stored-multiple");
    // The stub knows the snapshot no readable event names: the head is uncertain (D86), and nothing is restored.
    const refused = await onload(mbp);
    expect(refused.ok ? "ok" : refused.finding.code).toBe("catalog.head-uncertain");
    expect(existsSync(join(mbp.box.home, "work/web"))).toBe(false);
  });

  test("[stored] the store's own records: appendEvent refuses an event with zero or two stored entries", async () => {
    await makeHome("mbp", ["ssd"]);
    const base = {
      v: 1 as const,
      type: "snapshot-discarded" as const,
      device: ulid(),
      at: "2026-10-12T00:00:00.000Z",
      project: ulid(),
      root: ulid(),
      path: "web",
      snapshot: ulid(),
    };
    const counts: Record<string, string>[] = [{}, { a: "e".repeat(64), b: "f".repeat(64) }];
    for (const stored of counts) {
      const id = ulid();
      const refused = await appendEvent(storeEventLog(store), { ...base, id, op: id, stored });
      expect(refused.ok ? "ok" : refused.finding.code).toBe("contract.invalid");
      expect(store.data.has(`${STORE_EVENTS_PREFIX}${id}.json`)).toBe(false);
    }
  });

  test("[stored] a changed root default while the old store is offline still finds the snapshot by id", async () => {
    const mbp = await makeHome("mbp", ["old"]);
    project(mbp, "old store");
    const done = await offload(mbp);
    const id = await storeId(mbp);
    const viewsOf = async () =>
      value(
        await projectViews({
          io: testHost(),
          paths: mbp.box.paths,
          env: env(mbp),
          device: mbp.device,
          loader: new ConfigLoader(testHost(), mbp.box.paths),
          opener,
          openMirror: async (storeId) =>
            storeId === id
              ? { ok: true, value: mbp.mirror }
              : fail(finding("store.unreachable", { message: "x" })),
        }),
      );
    // A read while the store answers brings the mirror up to it (ls after the offload).
    expect((await viewsOf()).projects.find((p) => p.path === "web")?.head).toBe(done.snapshot);
    // The root moves to a new default store, and the old one is unplugged: its catalog comes from the mirror, by id.
    configOf({ box: mbp.box, aliases: ["new", "old"] }, "mbp");
    offline.add("old");
    const views = await viewsOf();
    const view = views.projects.find((p) => p.path === "web");
    expect(view?.state).toBe("shelved");
    expect(view?.store).toBe("old");
    expect(view?.head).toBe(done.snapshot);
    expect(view?.stale).toBe(true);
    // The mirror is the store's by its id, so the snapshot's location is still the old store's.
    const mirrored = value(await readEvents({ store: mbp.mirror, prefix: "events/" })).events.find(
      (e) => e.type === "offloaded" && e.snapshot === done.snapshot,
    );
    expect(mirrored?.type === "offloaded" ? Object.values(mirrored.stored) : []).toHaveLength(1);
    expect(readdirSync(join(mbp.box.home, "work")).sort()).toContain("web.plainport");
  });
});
