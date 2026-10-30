// Sealing on stores (M2 Task 20, T0): the policy fixed at bootstrap and defaulting by kind, the device's pin, the key
// from the engine, and every refusal. Devices are sandboxed homes sharing in-memory stores and fake repositories.
//   - seal|catalogKey: a sealed store opens with the key derived from its repository's master key, pinned by key id.
//   - A kid mismatch fails closed (catalog.seal-failed), and nothing is read.
//   - A store pinned sealed never reads a plaintext event (catalog.unsealed-event), which leaves the fold uncertain.
//   - A plain writer on a sealed store refuses before it reads or writes an event (D106, policyFits).
//   - A key that cannot be derived is store.seal-key-unavailable; an unreachable store stays store.unreachable.

import { afterEach, describe, expect, test } from "bun:test";
import { fail, finding, ok, type Result } from "@plainport/contract";
import { type CatalogPolicy, encode, encodePlain, PLAIN_CATALOG, storeEventKey } from "../catalog/codec.ts";
import type { CatalogEvent } from "../catalog/events.ts";
import { STORE_IDENTITY_KEY } from "../catalog/identity.ts";
import { appendEvent, loadCatalog, storeEventLog } from "../catalog/log.ts";
import { deriveSealKey, keyId, MASTER_KEY_BYTES } from "../catalog/seal.ts";
import { ConfigLoader } from "../config/load.ts";
import type { Store } from "../config/schema.ts";
import { ensureDevice } from "../device.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { StoreOpener } from "../ports/store.ts";
import { openStore } from "../store.ts";
import { readStoreSeal } from "../stores-state.ts";
import { testHost } from "../testing/host.ts";
import { memoryBlobStore } from "../testing/memory-blob-store.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { type StoreWorld, storeWorld } from "../testing/store-opener.ts";
import { ulid } from "../ulid.ts";
import { addStore } from "./add.ts";
import { storeLocation } from "./location.ts";

const io = testHost();
const PASSWORD = "seal-test-password";
const ports = { faultAt: () => {}, clock: () => new Date(), log: () => {}, wait: async () => {} };
const NAS: Store = {
  kind: "sftp",
  host: "nas",
  path: "/srv/plainport",
  secret: "env:PLAINPORT_STORE_PASSWORD",
};
const BUCKET: Store = {
  kind: "s3",
  endpoint: "http://127.0.0.1:9000",
  bucket: "plainport",
  secret: "env:PLAINPORT_STORE_PASSWORD",
  accessKeyId: "env:PP_KEY_ID",
  secretAccessKey: "env:PP_SECRET_KEY",
};

let boxes: Sandbox[] = [];
afterEach(() => {
  for (const box of boxes) box.cleanup();
  boxes = [];
});

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};
const code = (result: Result<unknown>) => (result.ok ? "ok" : result.finding.code);

const device = async (world: StoreWorld, wrap?: (blob: BlobStore) => BlobStore) => {
  const box = makeSandbox("plainport-seal-");
  boxes.push(box);
  value(await ensureDevice(io, box.paths, { role: "owner", name: "mbp", clock: { now: () => new Date() } }));
  const env = {
    HOME: box.home,
    PLAINPORT_STORE_PASSWORD: PASSWORD,
    PP_KEY_ID: "key-id",
    PP_SECRET_KEY: "key",
  };
  const opener = world.opener(box.home, wrap === undefined ? {} : { wrap });
  const add = (store: Store, seal?: "v1" | "none", name = "nas") =>
    addStore(io, {
      paths: box.paths,
      env,
      name,
      store,
      opener,
      ports,
      ...(seal === undefined ? {} : { seal }),
    });
  const open = async (name = "nas", over: StoreOpener = opener) => {
    const config = value(await new ConfigLoader(io, box.paths).load({ env })).config;
    return openStore(io, { paths: box.paths, env, name, config, opener: over });
  };
  return { box, env, opener, add, open };
};

/** A catalog event of the project, for a store's log. */
const registered = (project: string): Extract<CatalogEvent, { type: "registered" }> => {
  const id = ulid();
  return {
    v: 1,
    id,
    type: "registered",
    device: ulid(),
    at: new Date().toISOString(),
    op: id,
    project,
    root: ulid(),
    path: "webshop-frontend",
  };
};

describe("seal: the policy is fixed at bootstrap and defaults by kind (Q10)", () => {
  for (const [kind, store] of [
    ["sftp", NAS],
    ["s3", BUCKET],
  ] as const) {
    test(`a new ${kind} store is sealed by default; this device pins it with the first key's id`, async () => {
      const world = storeWorld();
      const d = await device(world);
      const added = value(await d.add(store));
      expect([added.outcome, added.sealed]).toEqual(["published", true]);
      const blob = world.blobAt(storeLocation(store, d.box.home));
      expect(JSON.parse(new TextDecoder().decode(blob.data.get(STORE_IDENTITY_KEY))).catalog).toEqual({
        seal: "v1",
      });
      expect(value(await readStoreSeal(io, d.box.paths, added.id))?.policy).toBe("v1");

      const opened = value(await d.open());
      const master = world.repoAt(storeLocation(store, d.box.home), added.repo).masterKey;
      const key = value(deriveSealKey(master, added.id));
      expect(opened.catalog).toEqual({ seal: "sealed", storeId: added.id, key });
      expect(value(await readStoreSeal(io, d.box.paths, added.id))?.kid).toBe(keyId(key));
    });
  }

  test("--no-seal keeps a new remote store plain; a local one is plain unless --seal", async () => {
    const world = storeWorld();
    const d = await device(world);
    expect(value(await d.add(NAS, "none")).sealed).toBe(false);
    expect(value(await d.open()).catalog).toEqual(PLAIN_CATALOG);
    const local: Store = { kind: "local", path: `${d.box.home}/Archive` };
    expect(value(await d.add(local, undefined, "archive")).sealed).toBe(false);
    const sealedLocal: Store = { kind: "local", path: `${d.box.home}/Vault` };
    expect(value(await d.add(sealedLocal, "v1", "vault")).sealed).toBe(true);
  });

  test("seal|catalogKey: a second device derives the same key; a sealed event one writes, the other reads", async () => {
    const world = storeWorld();
    const a = await device(world);
    const b = await device(world);
    const added = value(await a.add(NAS));
    expect(value(await b.add(NAS)).outcome).toBe("adopted");
    const [left, right] = [value(await a.open()), value(await b.open())];
    expect(right.catalog).toEqual(left.catalog);
    const event = registered(ulid());
    value(await appendEvent(storeEventLog(left.blob, left.catalog), event));
    const stored = world.blobAt(storeLocation(NAS, a.box.home)).data.get(storeEventKey(event.id));
    expect(new TextDecoder().decode(stored)).not.toContain(event.project);
    const read = value(
      await loadCatalog({
        store: right.blob,
        mirror: memoryBlobStore(),
        storeId: added.id,
        now: new Date(),
        policy: right.catalog,
      }),
    );
    expect(Object.keys(read.state.projects)).toEqual([event.project]);
  });
});

describe("seal: the pins", () => {
  test("a kid mismatch fails closed: a store whose repository's key is not the pinned one is catalog.seal-failed", async () => {
    const world = storeWorld();
    const d = await device(world);
    const added = value(await d.add(NAS));
    value(await d.open());
    // The repository is replaced by one with another master key (say, set up again under the same store.json).
    world.repoAt(storeLocation(NAS, d.box.home), added.repo).masterKey = crypto.getRandomValues(
      new Uint8Array(MASTER_KEY_BYTES),
    );
    const refused = await d.open();
    expect(code(refused)).toBe("catalog.seal-failed");
    expect(refused.ok ? "" : refused.finding.message).toContain("pinned key id");
  });

  test("a sealed event under another key fails closed too: catalog.seal-failed, never read as absent", async () => {
    const world = storeWorld();
    const d = await device(world);
    const added = value(await d.add(NAS));
    const opened = value(await d.open());
    const event = registered(ulid());
    const other: CatalogPolicy = { seal: "sealed", storeId: added.id, key: new Uint8Array(32).fill(3) };
    world
      .blobAt(storeLocation(NAS, d.box.home))
      .data.set(storeEventKey(event.id), value(encode(event, other)));
    const read = value(
      await loadCatalog({
        store: opened.blob,
        mirror: memoryBlobStore(),
        storeId: added.id,
        now: new Date(),
        policy: opened.catalog,
      }),
    );
    expect(read.findings.map((f) => f.code)).toEqual(["catalog.seal-failed"]);
    expect(read.uncertain).toEqual([event.id]);
    expect(read.state.projects).toEqual({});
  });

  test("a store pinned sealed never reads a plaintext event: catalog.unsealed-event, and the fold is uncertain", async () => {
    const world = storeWorld();
    const d = await device(world);
    const added = value(await d.add(NAS));
    const opened = value(await d.open());
    const event = registered(ulid());
    world.blobAt(storeLocation(NAS, d.box.home)).data.set(storeEventKey(event.id), encodePlain(event));
    const read = value(
      await loadCatalog({
        store: opened.blob,
        mirror: memoryBlobStore(),
        storeId: added.id,
        now: new Date(),
        policy: opened.catalog,
      }),
    );
    expect(read.findings.map((f) => f.code)).toEqual(["catalog.unsealed-event"]);
    expect(read.uncertain).toEqual([event.id]);
    expect(read.state.projects).toEqual({});
  });

  test("D106: a plain writer on a sealed store refuses before it reads or writes an event", async () => {
    const world = storeWorld();
    const d = await device(world);
    const added = value(await d.add(NAS));
    const plainWriter: StoreOpener = {
      open: async (...args) => {
        const opened = await d.opener.open(...args);
        return opened.ok ? ok({ ...opened.value, catalog: PLAIN_CATALOG }) : opened;
      },
    };
    const opened = value(await d.open("nas", plainWriter));
    expect(opened.catalog).toEqual(PLAIN_CATALOG);
    const blob = world.blobAt(storeLocation(NAS, d.box.home));
    const gets = blob.calls.get;
    const read = await loadCatalog({
      store: opened.blob,
      mirror: memoryBlobStore(),
      storeId: added.id,
      now: new Date(),
      policy: opened.catalog,
    });
    expect(code(read)).toBe("catalog.seal-failed");
    expect(read.ok ? "" : read.finding.message).toContain("the store publishes seal v1");
    // Only the identity was read; no event was listed, fetched or written.
    expect(blob.calls.get).toBe(gets + 1);
    expect([...blob.data.keys()].filter((k) => k.startsWith("meta/v1/events/"))).toEqual([]);
  });

  test("a store pinned plain whose identity now says sealed: store.identity-changed, and the pin stays", async () => {
    const world = storeWorld();
    const d = await device(world);
    const added = value(await d.add(NAS, "none"));
    const blob = world.blobAt(storeLocation(NAS, d.box.home));
    const identity = JSON.parse(new TextDecoder().decode(blob.data.get(STORE_IDENTITY_KEY)));
    blob.data.set(
      STORE_IDENTITY_KEY,
      new TextEncoder().encode(`${JSON.stringify({ ...identity, catalog: { seal: "v1" } })}\n`),
    );
    expect(code(await d.open())).toBe("store.identity-changed");
    expect(value(await readStoreSeal(io, d.box.paths, added.id))?.policy).toBe("none");
  });

  test("a device that never pinned the store pins it at its first use (an M1-era record)", async () => {
    const world = storeWorld();
    const d = await device(world);
    const added = value(await d.add(NAS));
    const file = `${d.box.paths.stateDir}/stores/${added.id}.json`;
    await io.fs.unlink(file);
    value(await d.open());
    expect(value(await readStoreSeal(io, d.box.paths, added.id))?.policy).toBe("v1");
  });
});

describe("seal: a key that cannot be derived", () => {
  test("is store.seal-key-unavailable naming the cause; an unreachable store stays store.unreachable", async () => {
    const world = storeWorld();
    const d = await device(world);
    value(await d.add(NAS));
    const failing = (failure: ReturnType<typeof fail>): StoreOpener => ({
      open: async (...args) => {
        const opened = await d.opener.open(...args);
        if (!opened.ok) return opened;
        return ok({ ...opened.value, engine: { ...opened.value.engine, catalogKey: async () => failure } });
      },
    });
    const broken = await d.open(
      "nas",
      failing(fail(finding("restic.failed", { message: "restic cat masterkey failed with exit code 1" }))),
    );
    expect(code(broken)).toBe("store.seal-key-unavailable");
    expect(broken.ok ? "" : broken.finding.message).toContain("restic.failed");
    const away = await d.open("nas", failing(fail(finding("store.unreachable", { message: "dial tcp" }))));
    expect(code(away)).toBe("store.unreachable");
  });
});
