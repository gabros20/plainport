// The store commands' core (Q2, Q4, Q8, Q13): add (bootstrap or adopt, managed.toml under its lock), list, test (the
// probe, the sidecar, delete denied never called append-only, bootstrap leftovers), remove (store.in-use) and the
// constrained upgrade to format 2 (each store.not-quiescent case, the marker, the window, crashes and recover).
// Every device is a sandboxed home; every store an in-memory blob store shared through a store world.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type Failure, fail, finding, ok, type Result } from "@plainport/contract";
import { encodePlain, storeEventKey } from "../catalog/codec.ts";
import type { CatalogEvent } from "../catalog/events.ts";
import { encodeStoreIdentityV2, STORE_CLAIMS_PREFIX, STORE_IDENTITY_KEY } from "../catalog/identity.ts";
import { ConfigLoader } from "../config/load.ts";
import { updateManaged } from "../config/managed.ts";
import type { ConfigLayer, ResolvedConfig } from "../config/schema.ts";
import { ensureDevice } from "../device.ts";
import { writeBootstrapJournal } from "../journal/index.ts";
import { acquireLock } from "../lock.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import { InjectedFault } from "../ports/host.ts";
import { readRegistry, updateRegistry } from "../registry.ts";
import { readStoreState } from "../stores-state.ts";
import { testHost } from "../testing/host.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { type StoreWorld, storeWorld } from "../testing/store-opener.ts";
import { ulid } from "../ulid.ts";
import { addStore } from "./add.ts";
import { listStores } from "./list.ts";
import { storeFacts } from "./location.ts";
import { removeStore } from "./remove.ts";
import { STORE_TEST_PREFIX, testStore } from "./test.ts";
import { recoverUpgrade, UPGRADE_INTENT_KEY, type UpgradePorts, upgradeStore } from "./upgrade.ts";

const PASSWORD = "store-test-password";
const TOOLS = { restic: "0.19.1", rclone: "1.75.1" };
const io = testHost();

let boxes: Sandbox[] = [];
const sandbox = (): Sandbox => {
  const box = makeSandbox("plainport-stores-");
  boxes.push(box);
  return box;
};
/** A fresh folder for the shared store each test, on the real disk (local stores' setup looks at it). */
let shared: Sandbox | undefined;
const ARCHIVE = (): string => {
  shared ??= sandbox();
  return `${shared.home}/Archive`;
};
afterEach(() => {
  for (const box of boxes) box.cleanup();
  boxes = [];
  shared = undefined;
});

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};
const failed = (result: Result<unknown>): Failure => {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
  return result;
};
const text = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

interface Device {
  box: Sandbox;
  id: string;
  env: Record<string, string>;
  opener: ReturnType<StoreWorld["opener"]>;
  config(): Promise<ResolvedConfig>;
  managed(): string;
}

const device = async (
  world: StoreWorld,
  options: { password?: string; wrap?: (blob: BlobStore) => BlobStore } = {},
): Promise<Device> => {
  const box = sandbox();
  const made = value(
    await ensureDevice(io, box.paths, { role: "owner", name: "mbp", clock: { now: () => new Date() } }),
  );
  const env = { HOME: box.home, PLAINPORT_STORE_PASSWORD: options.password ?? PASSWORD };
  return {
    box,
    id: made.device.id,
    env,
    opener: world.opener(box.home, options.wrap === undefined ? {} : { wrap: options.wrap }),
    config: async () => value(await new ConfigLoader(io, box.paths).load({ env })).config,
    managed: () => readFileSync(box.paths.managedFile, "utf8"),
  };
};

const ports = { faultAt: () => {}, clock: () => new Date(), log: () => {}, wait: async () => {} };
const local = (path: string) => ({ kind: "local" as const, path });

const add = (d: Device, name = "archive", path = ARCHIVE()) =>
  addStore(io, { paths: d.box.paths, env: d.env, name, store: local(path), opener: d.opener, ports });

const writeManaged = (d: Device, layer: ConfigLayer) =>
  updateManaged(io, d.box.paths, (current) => ok({ ...current, ...layer }));

describe("store add", () => {
  test("sets a new store up as format 2, pins its id, and writes only references to managed.toml", async () => {
    const world = storeWorld();
    const d = await device(world);
    const added = value(await add(d));
    expect(added).toMatchObject({ name: "archive", outcome: "published", format: 2, configChanged: true });
    expect(added.repo).toBe(`repos/${added.id}`);
    const blob = world.blobAt(ARCHIVE());
    expect(JSON.parse(text(blob.data.get(STORE_IDENTITY_KEY)) as string)).toEqual({
      v: 2,
      id: added.id,
      repo: `repos/${added.id}`,
      catalog: { seal: "none" },
      format: 2,
    });
    expect(world.repoAt(ARCHIVE(), added.repo).initialized).toBe(true);
    expect(value(await readRegistry(io, d.box.paths)).stores).toEqual({ archive: added.id });
    const managed = d.managed();
    expect(Bun.TOML.parse(managed)).toEqual({
      defaultStore: "archive",
      stores: { archive: { kind: "local", path: ARCHIVE() } },
    });
    expect(managed).not.toContain(PASSWORD);
  });

  test("is idempotent: a re-run adopts the same store and changes nothing", async () => {
    const world = storeWorld();
    const d = await device(world);
    const first = value(await add(d));
    const managed = d.managed();
    const again = value(await add(d));
    expect(again).toMatchObject({ id: first.id, outcome: "adopted", format: 2, configChanged: false });
    expect(d.managed()).toBe(managed);
    expect(world.blobAt(ARCHIVE()).data.size).toBe([...world.blobAt(ARCHIVE()).data.keys()].length);
  });

  test("a second device adopts with the same password; with another, it records nothing", async () => {
    const world = storeWorld();
    const a = await device(world);
    const published = value(await add(a));
    const b = await device(world);
    expect(value(await add(b))).toMatchObject({ id: published.id, outcome: "adopted" });
    const c = await device(world, { password: "another" });
    expect(failed(await add(c)).finding.code).toBe("restic.wrong-password");
    expect(value(await readRegistry(io, c.box.paths)).stores).toBeUndefined();
  });

  test("refuses another store under a configured name, writing nothing", async () => {
    const world = storeWorld();
    const d = await device(world);
    value(await add(d));
    const managed = d.managed();
    const refused = failed(await add(d, "archive", `${ARCHIVE()}-other`));
    expect(refused.finding.code).toBe("usage.invalid");
    expect(refused.finding.fix).toContain("plainport store add <new-name>");
    expect(d.managed()).toBe(managed);
    expect(world.blobAt(`${ARCHIVE()}-other`).data.size).toBe(0);
  });

  test("a name pinned here only reaches its own store (D85): another is store.identity-changed before any write", async () => {
    const world = storeWorld();
    const d = await device(world);
    value(await updateRegistry(io, d.box.paths, (r) => ok({ ...r, stores: { archive: ulid() } })));
    const refused = failed(await add(d));
    expect(refused.finding.code).toBe("store.identity-changed");
    expect(world.blobAt(ARCHIVE()).data.size).toBe(0);
    expect(() => d.managed()).toThrow();
  });

  test("an election that waits out its tie-break (D109's waiting) is store.bootstrap-undecided, exit 6: retry later", async () => {
    const world = storeWorld();
    const d = await device(world);
    const blob = world.blobAt(ARCHIVE());
    // A rival that stood with a higher id and never decides: this attempt holds the tie-break and waits for it.
    const rival = ulid(Date.now() + 3_600_000);
    value(
      await blob.put(
        `${STORE_CLAIMS_PREFIX}${rival}.json`,
        new TextEncoder().encode(`${JSON.stringify({ v: 1, id: rival, decision: "candidate" })}\n`),
      ),
    );
    const refused = failed(await add(d));
    expect([refused.exitCode, refused.finding.code]).toEqual([6, "store.bootstrap-undecided"]);
    expect((refused.data as { outcome?: string } | undefined)?.outcome).toBe("waiting");
    expect(blob.data.has(STORE_IDENTITY_KEY)).toBe(false);
    expect(value(await readRegistry(io, d.box.paths)).stores).toBeUndefined();
  });

  test("an offload refuses while the store's upgrade marker stands (Q2)", async () => {
    const { refuseWhileUpgrading } = await import("./upgrade.ts");
    const world = storeWorld();
    const d = await device(world);
    value(await add(d));
    const blob = world.blobAt(ARCHIVE());
    expect((await refuseWhileUpgrading(blob, "archive", "offload")).ok).toBe(true);
    value(await blob.put(UPGRADE_INTENT_KEY, new TextEncoder().encode("{}\n")));
    const refused = failed(await refuseWhileUpgrading(blob, "archive", "offload"));
    expect([refused.exitCode, refused.finding.code]).toEqual([6, "store.not-quiescent"]);
  });

  test("refuses a store whose upgrade marker stands (Q2)", async () => {
    const world = storeWorld();
    const a = await device(world);
    value(await add(a));
    const blob = world.blobAt(ARCHIVE());
    value(await blob.put(UPGRADE_INTENT_KEY, new TextEncoder().encode("{}\n")));
    const b = await device(world);
    expect(failed(await add(b)).finding.code).toBe("store.not-quiescent");
    expect(value(await readRegistry(io, b.box.paths)).stores).toBeUndefined();
  });

  test("--secret-stdin saves the password through the Keychain provider; managed.toml holds the reference only", async () => {
    const world = storeWorld();
    const saved = new Map<string, string>();
    const box = sandbox();
    value(
      await ensureDevice(io, box.paths, { role: "owner", name: "mbp", clock: { now: () => new Date() } }),
    );
    const secrets = {
      keychain: {
        get: async (ref: string) =>
          saved.has(ref)
            ? ok(saved.get(ref) as string)
            : fail(finding("store.secret-missing", { message: "no item" })),
        set: async (ref: string, secret: string) => {
          saved.set(ref, secret);
          return ok(undefined);
        },
      },
    };
    const opener = world.opener(box.home, { secrets });
    const added = value(
      await addStore(io, {
        paths: box.paths,
        env: { HOME: box.home },
        name: "nas",
        store: { kind: "local", path: `${ARCHIVE()}-nas`, secret: "keychain:plainport/nas" },
        opener,
        ports,
        secretValue: "typed-on-stdin-7f3a",
      }),
    );
    expect(added.secretSaved).toBe(true);
    expect(saved.get("keychain:plainport/nas")).toBe("typed-on-stdin-7f3a");
    const managed = readFileSync(box.paths.managedFile, "utf8");
    expect(managed).toContain("keychain:plainport/nas");
    expect(managed).not.toContain("typed-on-stdin-7f3a");
  });
});

describe("store list", () => {
  test("lists each store with its location, source, pin and roots, and reaches nothing without a probe", async () => {
    const world = storeWorld();
    const d = await device(world);
    const added = value(await add(d));
    value(
      await writeManaged(d, {
        roots: { work: { on: { mbp: "~/work" } } },
        stores: {
          archive: local(ARCHIVE()),
          nas: { kind: "sftp", host: "nas", path: "/srv/plainport", secret: "env:NAS_PASSWORD" },
        },
      }),
    );
    const before = world.blobAt(ARCHIVE()).calls.get;
    const listed = value(await listStores(io, { paths: d.box.paths, env: d.env, tools: TOOLS }));
    expect(listed.stores).toEqual([
      {
        name: "archive",
        kind: "local",
        location: ARCHIVE(),
        source: "managed",
        default: true,
        id: added.id,
        sealed: false,
        roots: ["work"],
      },
      {
        name: "nas",
        kind: "sftp",
        location: "sftp:nas:/srv/plainport",
        source: "managed",
        default: false,
        roots: [],
      },
    ]);
    expect(world.blobAt(ARCHIVE()).calls.get).toBe(before);
  });
});

describe("store test", () => {
  const run = (d: Device, name = "archive") =>
    d.config().then((config) =>
      testStore(io, {
        paths: d.box.paths,
        env: d.env,
        name,
        store: config.stores[name] as ResolvedConfig["stores"][string],
        opener: d.opener,
        tools: TOOLS,
        now: () => new Date("2026-10-29T10:00:00Z"),
        mint: () => ulid(),
      }),
    );

  test("measures read and list after write, deletes its probe, and records the result under the facts", async () => {
    const world = storeWorld();
    const d = await device(world);
    const added = value(await add(d));
    const report = value(await run(d));
    expect(report).toMatchObject({
      reachable: true,
      delete: "allowed",
      id: added.id,
      format: 2,
      repository: { opens: true },
      ok: true,
      recorded: true,
      losing: [],
      contested: [],
    });
    expect(report.semantics.readAfterWrite).toEqual({ value: true, evidence: "measured" });
    expect(report.semantics.listAfterWrite).toEqual({ value: true, evidence: "measured" });
    expect(report.semantics.conditionalCreate).toEqual({ value: true, evidence: "measured" });
    expect(report.operations.commit).toEqual({ eligible: true });
    const blob = world.blobAt(ARCHIVE());
    expect([...blob.data.keys()].filter((k) => k.startsWith(STORE_TEST_PREFIX))).toEqual([]);
    const config = await d.config();
    const facts = storeFacts(config.stores.archive as ResolvedConfig["stores"][string], d.box.home, TOOLS);
    const state = value(await readStoreState(io, d.box.paths, added.id, facts));
    expect(state.measured?.test).toEqual({ at: "2026-10-29T10:00:00.000Z", ok: true, delete: "allowed" });
    expect(state.measured?.semantics?.readAfterWrite).toEqual({ value: true, evidence: "measured" });
  });

  test("on a store that denies deletes it says denied, never append-only", async () => {
    const world = storeWorld();
    const a = await device(world);
    value(await add(a));
    const denying = (blob: BlobStore): BlobStore => ({
      ...blob,
      semantics: () => blob.semantics(),
      capabilities: () => blob.capabilities(),
      delete: async (key) =>
        fail(
          finding("store.failed", { message: `AccessDenied: delete ${key} is not allowed`, paths: [key] }),
        ),
    });
    const b = await device(world, { wrap: denying });
    value(await add(b));
    const report = value(await run(b));
    expect(report.delete).toBe("denied");
    expect(JSON.stringify(report).toLowerCase()).not.toContain("append-only");
  });

  test("a store that does not answer is unreachable, and nothing is recorded", async () => {
    const world = storeWorld();
    const a = await device(world);
    const added = value(await add(a));
    const down = (): Promise<Result<never>> =>
      Promise.resolve(fail(finding("store.unreachable", { message: "connection refused" })));
    const b = await device(world, {
      wrap: (blob) => ({
        ...blob,
        semantics: () => blob.semantics(),
        capabilities: () => blob.capabilities(),
        get: down,
        put: down,
        list: down,
        stat: down,
        delete: down,
      }),
    });
    value(await writeManaged(b, { stores: { archive: local(ARCHIVE()) } }));
    value(await updateRegistry(io, b.box.paths, (r) => ok({ ...r, stores: { archive: added.id } })));
    const report = value(await run(b));
    expect(report).toMatchObject({ reachable: false, delete: "unreachable", recorded: false, ok: false });
  });

  test("lists losing bootstrap repositories and contested candidacies with the quiesced manual steps", async () => {
    const world = storeWorld();
    const d = await device(world);
    const added = value(await add(d));
    const blob = world.blobAt(ARCHIVE());
    const loser = ulid();
    value(await blob.put(`repos/${loser}/config`, new TextEncoder().encode("x")));
    value(await blob.put(`${STORE_CLAIMS_PREFIX}${loser}.json`, new TextEncoder().encode("{}")));
    value(await blob.put(`${STORE_CLAIMS_PREFIX}${loser}.refused`, new TextEncoder().encode("{}")));
    const report = value(await run(d));
    expect(report.losing).toEqual([{ attempt: loser, keys: [`repos/${loser}/config`] }]);
    expect(report.contested).toEqual([
      {
        attempt: loser,
        keys: [`${STORE_CLAIMS_PREFIX}${loser}.json`, `${STORE_CLAIMS_PREFIX}${loser}.refused`],
      },
    ]);
    expect(report.contested.map((c) => c.attempt)).not.toContain(added.id);
    expect(report.cleanup).toContain("stop plainport on every device");
    expect(report.cleanup).toContain(`repos/${loser}/`);
    // Nothing of them is removed.
    expect(blob.data.has(`repos/${loser}/config`)).toBe(true);
  });

  test("a name pinned here to another store is refused before the probe is written", async () => {
    const world = storeWorld();
    const d = await device(world);
    value(await add(d));
    value(await updateRegistry(io, d.box.paths, (r) => ok({ ...r, stores: { archive: ulid() } })));
    expect(failed(await run(d)).finding.code).toBe("store.identity-changed");
    const blob = world.blobAt(ARCHIVE());
    expect([...blob.data.keys()].some((k) => k.startsWith(STORE_TEST_PREFIX))).toBe(false);
  });
});

describe("store remove", () => {
  const remove = (d: Device, name = "archive") => removeStore(io, { paths: d.box.paths, env: d.env, name });

  test("refuses while a root sends snapshots to the store, by name or as the default (store.in-use)", async () => {
    const world = storeWorld();
    const d = await device(world);
    value(await add(d));
    value(await writeManaged(d, { roots: { work: { on: { mbp: "~/work" } } } }));
    const managed = d.managed();
    const refused = failed(await remove(d));
    expect(refused.finding.code).toBe("store.in-use");
    expect(refused.finding.message).toContain("root work");
    expect(d.managed()).toBe(managed);
    value(await writeManaged(d, { roots: { work: { store: "archive", on: { mbp: "~/work" } } } }));
    expect(failed(await remove(d)).finding.code).toBe("store.in-use");
  });

  test("refuses while an open setup attempt names it", async () => {
    const world = storeWorld();
    const d = await device(world);
    value(await add(d));
    const op = ulid();
    await writeBootstrapJournal(io, d.box.paths, {
      v: 1,
      op,
      kind: "bootstrap",
      step: "bootstrap.begin",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: 1,
      host: "h",
      store: { name: "archive", location: ARCHIVE() },
      repo: `repos/${op}`,
      seal: "none",
      history: [],
    });
    const refused = failed(await remove(d));
    expect(refused.finding.code).toBe("store.in-use");
    expect(refused.finding.message).toContain(op);
  });

  test("forgets an unused store on this device only: its table, the default and the pin; the store is untouched", async () => {
    const world = storeWorld();
    const d = await device(world);
    const added = value(await add(d));
    const blob = world.blobAt(ARCHIVE());
    const keys = [...blob.data.keys()].sort();
    expect(value(await remove(d))).toEqual({ name: "archive", id: added.id, removed: true });
    expect(Bun.TOML.parse(d.managed())).toEqual({});
    expect(value(await readRegistry(io, d.box.paths)).stores).toBeUndefined();
    expect([...blob.data.keys()].sort()).toEqual(keys);
  });

  test("a store config.toml defines is the user's to remove there", async () => {
    const world = storeWorld();
    const d = await device(world);
    d.box.file(".config/plainport/config.toml", `[stores.archive]\nkind = "local"\npath = "${ARCHIVE()}"\n`);
    const refused = failed(await remove(d));
    expect(refused.finding.code).toBe("usage.invalid");
    expect(refused.finding.message).toContain("never writes it");
  });
});

describe("store upgrade", () => {
  const OTHER = ulid(Date.parse("2026-01-01T00:00:00Z"));
  const NOW = new Date("2026-10-29T12:00:00Z");

  /** A device with a format-1 store pinned under `archive`, as v0.1.x's init leaves it. */
  const m1Store = async (world: StoreWorld) => {
    const d = await device(world);
    const id = ulid();
    const blob = world.blobAt(ARCHIVE());
    value(await blob.put(STORE_IDENTITY_KEY, new TextEncoder().encode(`${JSON.stringify({ v: 1, id })}\n`)));
    value(await writeManaged(d, { defaultStore: "archive", stores: { archive: local(ARCHIVE()) } }));
    value(await updateRegistry(io, d.box.paths, (r) => ok({ ...r, stores: { archive: id } })));
    return { d, id, blob };
  };

  const event = (fields: Partial<CatalogEvent> & Pick<CatalogEvent, "type">, at: Date): CatalogEvent =>
    ({
      v: 1,
      id: ulid(at.getTime()),
      device: OTHER,
      at: at.toISOString(),
      op: ulid(at.getTime()),
      ...fields,
    }) as CatalogEvent;
  const putEvent = async (blob: BlobStore, e: CatalogEvent) =>
    value(await blob.put(storeEventKey(e.id), encodePlain(e)));

  const upgrade = (
    d: Device,
    options: {
      othersStopped?: boolean;
      wait?: (ms: number) => Promise<void>;
      faultAt?: (point: string) => void;
    } = {},
  ) =>
    d.config().then((config) => {
      const upgradePorts: UpgradePorts = {
        io,
        paths: d.box.paths,
        env: d.env,
        clock: () => NOW,
        wait: options.wait ?? (async () => {}),
        faultAt: options.faultAt ?? (() => {}),
      };
      return upgradeStore(upgradePorts, {
        name: "archive",
        config,
        opener: d.opener,
        device: d.id,
        othersStopped: options.othersStopped ?? true,
        mint: () => ulid(NOW.getTime()),
      });
    });

  test("upgrades a quiescent format-1 store: marker, window, store.json v2 with M1's repo, marker removed", async () => {
    const world = storeWorld();
    const { d, id, blob } = await m1Store(world);
    const waited: number[] = [];
    let markerDuringWait: string | undefined;
    const done = value(
      await upgrade(d, {
        wait: async (ms) => {
          waited.push(ms);
          markerDuringWait = text(blob.data.get(UPGRADE_INTENT_KEY));
        },
      }),
    );
    expect(done).toEqual({ name: "archive", id, from: 1, format: 2, upgraded: true, resumed: false });
    expect(waited).toEqual([15 * 60_000]);
    expect(JSON.parse(markerDuringWait as string)).toMatchObject({ v: 1, store: id, device: d.id });
    expect(JSON.parse(text(blob.data.get(STORE_IDENTITY_KEY)) as string)).toEqual({
      v: 2,
      id,
      repo: "repo",
      catalog: { seal: "none" },
      format: 2,
    });
    expect(blob.data.has(UPGRADE_INTENT_KEY)).toBe(false);
    // Again: nothing to do.
    expect(value(await upgrade(d))).toMatchObject({ from: 2, upgraded: false });
  });

  test("refuses while this device has an open journal", async () => {
    const world = storeWorld();
    const { d, blob } = await m1Store(world);
    const op = ulid();
    await writeBootstrapJournal(io, d.box.paths, {
      v: 1,
      op,
      kind: "bootstrap",
      step: "bootstrap.begin",
      startedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      pid: 1,
      host: "h",
      store: { name: "other", location: "/x" },
      repo: `repos/${op}`,
      seal: "none",
      history: [],
    });
    const refused = failed(await upgrade(d));
    expect(refused.finding.code).toBe("store.not-quiescent");
    expect(refused.finding.message).toContain("open setup attempt");
    expect(blob.data.has(UPGRADE_INTENT_KEY)).toBe(false);
  });

  test("refuses while a plainport lock is live on this device", async () => {
    const world = storeWorld();
    const { d } = await m1Store(world);
    await io.fs.mkdirp(d.box.paths.locksDir);
    const held = value(
      await acquireLock(io, `${d.box.paths.locksDir}/${ulid()}.lock`, {
        timeoutMs: 0,
        held: () => {
          throw new Error("unexpected");
        },
      }),
    );
    try {
      const refused = failed(await upgrade(d));
      expect(refused.finding.code).toBe("store.not-quiescent");
      expect(refused.finding.message).toContain("holds");
    } finally {
      await held.release();
    }
  });

  test("refuses while another device holds a lease in the catalog", async () => {
    const world = storeWorld();
    const { d, blob } = await m1Store(world);
    const old = new Date("2026-01-01T00:00:00Z");
    const project = ulid(old.getTime());
    const root = ulid(old.getTime());
    const snapshot = ulid(old.getTime());
    const where = { project, root, path: "web" };
    await putEvent(
      blob,
      event(
        {
          type: "offloaded",
          ...where,
          snapshot,
          stored: { archive: "a".repeat(64) },
          stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
        } as Partial<CatalogEvent> & { type: "offloaded" },
        old,
      ),
    );
    await putEvent(blob, event({ type: "onloaded", ...where, base: snapshot, over: snapshot } as never, old));
    const refused = failed(await upgrade(d));
    expect(refused.finding.code).toBe("store.not-quiescent");
    expect(refused.finding.message).toContain(`device ${OTHER} holds a lease`);
  });

  test("refuses while another device wrote an event inside the quiet window", async () => {
    const world = storeWorld();
    const { d, blob } = await m1Store(world);
    const recent = new Date(NOW.getTime() - 5 * 60_000);
    await putEvent(
      blob,
      event({ type: "registered", project: ulid(), root: ulid(), path: "web" } as never, recent),
    );
    const refused = failed(await upgrade(d));
    expect(refused.finding.code).toBe("store.not-quiescent");
    expect(refused.finding.message).toContain("inside the quiet window");
  });

  test("refuses without --others-stopped, and the fix lists the devices the catalog names", async () => {
    const world = storeWorld();
    const { d, blob } = await m1Store(world);
    await putEvent(
      blob,
      event(
        { type: "registered", project: ulid(), root: ulid(), path: "web" } as never,
        new Date("2026-01-01"),
      ),
    );
    const refused = failed(await upgrade(d, { othersStopped: false }));
    expect(refused.finding.code).toBe("store.not-quiescent");
    expect(refused.finding.message).toContain("--others-stopped");
    expect(refused.finding.fix).toContain(OTHER);
    expect(refused.finding.fix).toContain("--others-stopped --yes");
  });

  test("another device's event during the window aborts it and removes the marker", async () => {
    const world = storeWorld();
    const { d, blob } = await m1Store(world);
    const refused = failed(
      await upgrade(d, {
        wait: async () => {
          await putEvent(
            blob,
            event({ type: "registered", project: ulid(), root: ulid(), path: "late" } as never, NOW),
          );
        },
      }),
    );
    expect(refused.finding.code).toBe("store.not-quiescent");
    expect(refused.finding.message).toContain("during the quiet window");
    expect(refused.finding.message).toContain("marker removed");
    expect(blob.data.has(UPGRADE_INTENT_KEY)).toBe(false);
    expect(JSON.parse(text(blob.data.get(STORE_IDENTITY_KEY)) as string).v).toBe(1);
  });

  test("refuses a store that does not hold this device's pinned id", async () => {
    const world = storeWorld();
    const { d } = await m1Store(world);
    value(await updateRegistry(io, d.box.paths, (r) => ok({ ...r, stores: { archive: ulid() } })));
    expect(failed(await upgrade(d)).finding.code).toBe("store.identity-changed");
  });

  for (const seam of ["upgrade.intent.written", "upgrade.replaced"] as const) {
    test(`a crash at ${seam} leaves the marker: a re-run resumes it, and recover clears it`, async () => {
      for (const settle of ["resume", "recover"] as const) {
        const world = storeWorld();
        const { d, id, blob } = await m1Store(world);
        await expect(
          upgrade(d, {
            faultAt: (point) => {
              if (point === seam) throw new InjectedFault(point);
            },
          }),
        ).rejects.toBeInstanceOf(InjectedFault);
        expect(blob.data.has(UPGRADE_INTENT_KEY)).toBe(true);
        // While it stands, a v0.2 setup refuses.
        const other = await device(world);
        expect(failed(await add(other)).finding.code).toBe("store.not-quiescent");
        const format = seam === "upgrade.replaced" ? 2 : 1;
        expect(JSON.parse(text(blob.data.get(STORE_IDENTITY_KEY)) as string).v).toBe(format);
        if (settle === "resume") {
          const done = value(await upgrade(d));
          expect(done).toMatchObject({
            id,
            format: 2,
            resumed: true,
            upgraded: seam === "upgrade.intent.written",
          });
          expect(JSON.parse(text(blob.data.get(STORE_IDENTITY_KEY)) as string).v).toBe(2);
        } else {
          expect(value(await recoverUpgrade({ io, paths: d.box.paths }, blob, "archive", d.id))).toEqual({
            store: "archive",
            outcome: "cleared",
            format,
          });
        }
        expect(blob.data.has(UPGRADE_INTENT_KEY)).toBe(false);
      }
    });
  }

  test("recover leaves another device's marker as it is", async () => {
    const world = storeWorld();
    const { d, id, blob } = await m1Store(world);
    const marker = { v: 1, op: ulid(), store: id, device: OTHER, at: NOW.toISOString() };
    value(await blob.put(UPGRADE_INTENT_KEY, new TextEncoder().encode(JSON.stringify(marker))));
    expect(value(await recoverUpgrade({ io, paths: d.box.paths }, blob, "archive", d.id))).toEqual({
      store: "archive",
      outcome: "kept",
    });
    expect(blob.data.has(UPGRADE_INTENT_KEY)).toBe(true);
    // And this device's upgrade refuses while it stands.
    expect(failed(await upgrade(d)).finding.code).toBe("store.not-quiescent");
  });

  test("a format-2 store needs no upgrade", async () => {
    const world = storeWorld();
    const d = await device(world);
    const added = value(await add(d));
    expect(value(await upgrade(d))).toEqual({
      name: "archive",
      id: added.id,
      from: 2,
      format: 2,
      upgraded: false,
      resumed: false,
    });
    expect(encodeStoreIdentityV2).toBeDefined();
  });
});
