// setUpStore's identity pin (D85): once a name has an id on this device, setup only finishes that same store. A
// swapped disk or a changed path is refused with store.identity-changed before anything is written. The opener maps
// each configured path to its own in-memory store, so two "disks" can sit at one path in turn.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { STORE_IDENTITY_KEY } from "./catalog/identity.ts";
import type { Store } from "./config/schema.ts";
import type { Scheduler } from "./deadline.ts";
import type { StoreOpener } from "./ports/store.ts";
import { readRegistry } from "./registry.ts";
import { checkStorePin, setUpStore } from "./store.ts";
import { type FakeEngine, fakeEngine } from "./testing/fake-engine.ts";
import { testHost } from "./testing/host.ts";
import { type MemoryBlobStore, memoryBlobStore } from "./testing/memory-blob-store.ts";
import { makeSandbox, type Sandbox } from "./testing/sandbox.ts";
import { ulid } from "./ulid.ts";

let box: Sandbox;
/** The disk at each configured path; replace an entry to swap the disk. */
let disks: Map<string, { blob: MemoryBlobStore; engine: FakeEngine }>;

const disk = () => ({ blob: memoryBlobStore({ createIfAbsent: true }), engine: fakeEngine() });

const opener: StoreOpener = {
  open: async (_name, store) => {
    const path = "path" in store ? store.path : "";
    let found = disks.get(path);
    if (found === undefined) {
      found = disk();
      disks.set(path, found);
    }
    return { ok: true, value: found };
  },
};

const setUp = (store: Store) =>
  setUpStore(testHost(), {
    paths: box.paths,
    env: { PLAINPORT_STORE_PASSWORD: "pw" },
    name: "ssd",
    store,
    opener,
    mint: () => ulid(),
  });

const pinned = async () => {
  const registry = await readRegistry(testHost(), box.paths);
  if (!registry.ok) throw new Error(registry.finding.message);
  return registry.value.stores?.ssd;
};

beforeEach(() => {
  box = makeSandbox("plainport-store-");
  box.dir("ssd");
  disks = new Map();
});

afterEach(() => box.cleanup());

describe("setUpStore's identity pin (D85)", () => {
  test("first setup records the id; setting the same store up again changes nothing", async () => {
    const first = await setUp({ kind: "local", path: "~/ssd" });
    if (!first.ok) throw new Error(first.finding.message);
    expect(first.value).toMatchObject({ identityCreated: true, repositoryCreated: true, recorded: true });
    expect(await pinned()).toBe(first.value.id);
    const again = await setUp({ kind: "local", path: "~/ssd" });
    if (!again.ok) throw new Error(again.finding.message);
    expect(again.value).toMatchObject({
      id: first.value.id,
      identityCreated: false,
      repositoryCreated: false,
      recorded: false,
    });
  });

  test("a swapped disk at the same path is refused, and nothing is written to it or to the registry", async () => {
    const first = await setUp({ kind: "local", path: "~/ssd" });
    if (!first.ok) throw new Error(first.finding.message);
    // Another disk, already set up as some other store, mounted at the same path.
    const other = disk();
    other.blob.data.set(STORE_IDENTITY_KEY, new TextEncoder().encode(`{"v":1,"id":"${ulid()}"}\n`));
    disks.set("~/ssd", other);
    const before = new Map(other.blob.data);
    const refused = await setUp({ kind: "local", path: "~/ssd" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.finding.code).toBe("store.identity-changed");
    expect(refused.finding.message).toContain(first.value.id);
    expect(refused.finding.fix).toContain("--store <new-name>");
    expect(other.blob.data).toEqual(before);
    expect(other.blob.calls.put).toBe(0);
    expect(other.engine.repository.initialized).toBe(false);
    expect(await pinned()).toBe(first.value.id);
  });

  test("a swapped disk that carries no identity is refused, and setup does not give it one", async () => {
    const first = await setUp({ kind: "local", path: "~/ssd" });
    if (!first.ok) throw new Error(first.finding.message);
    const blank = disk();
    disks.set("~/ssd", blank);
    const refused = await setUp({ kind: "local", path: "~/ssd" });
    expect(!refused.ok && refused.finding.code).toBe("store.identity-changed");
    expect(blank.blob.data.size).toBe(0);
    expect(blank.engine.repository.initialized).toBe(false);
    expect(await pinned()).toBe(first.value.id);
  });

  test("a changed path to a folder that does not exist yet is refused without making it", async () => {
    const first = await setUp({ kind: "local", path: "~/ssd" });
    if (!first.ok) throw new Error(first.finding.message);
    const refused = await setUp({ kind: "local", path: "~/other" });
    expect(!refused.ok && refused.finding.code).toBe("store.identity-changed");
    expect(existsSync(join(box.home, "other"))).toBe(false);
    expect(disks.has("~/other")).toBe(false);
    expect(await pinned()).toBe(first.value.id);
  });

  test("a changed path to another store is refused; a changed path to the same store is accepted (D68)", async () => {
    const first = await setUp({ kind: "local", path: "~/ssd" });
    if (!first.ok) throw new Error(first.finding.message);
    box.dir("other");
    const refused = await setUp({ kind: "local", path: "~/other" });
    expect(!refused.ok && refused.finding.code).toBe("store.identity-changed");
    expect(disks.get("~/other")?.blob.data.size ?? 0).toBe(0);
    expect(await pinned()).toBe(first.value.id);
    // The same disk reached by another path (a new mount point): the id matches, so setup goes on.
    box.dir("mnt");
    disks.set("~/mnt", disks.get("~/ssd") as { blob: MemoryBlobStore; engine: FakeEngine });
    const moved = await setUp({ kind: "local", path: "~/mnt" });
    if (!moved.ok) throw new Error(moved.finding.message);
    expect(moved.value).toMatchObject({ id: first.value.id, recorded: false });
  });

  test("checkStorePin reads only: null for a name with no id, and no folder or identity is made", async () => {
    const free = await checkStorePin(testHost(), {
      paths: box.paths,
      env: { PLAINPORT_STORE_PASSWORD: "pw" },
      name: "ssd",
      store: { kind: "local", path: "~/fresh" },
      opener,
    });
    expect(free).toEqual({ ok: true, value: null });
    expect(existsSync(join(box.home, "fresh"))).toBe(false);
    expect(disks.size).toBe(0);
  });
});

describe("setUpStore on a disk that fails I/O (rule 7)", () => {
  const failing = (method: "stat" | "mkdirp", at: string, code: string) => {
    const real = testHost();
    return {
      ...real,
      fs: {
        ...real.fs,
        [method]: async (path: string, ...rest: unknown[]) => {
          if (path === at) throw Object.assign(new Error(`${code}: injected`), { code });
          return (real.fs[method] as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest);
        },
      },
    };
  };
  const setUpWith = (io: ReturnType<typeof testHost>) =>
    setUpStore(io, {
      paths: box.paths,
      env: { PLAINPORT_STORE_PASSWORD: "pw" },
      name: "ssd",
      store: { kind: "local", path: "~/ssd/store" },
      opener,
      mint: () => ulid(),
    });

  /** A fake scheduler whose timers fire at once (AGENTS.md rule 5). */
  const atOnce: Scheduler = {
    setTimer: (fire) => {
      queueMicrotask(fire);
      return undefined;
    },
    clearTimer: () => {},
  };
  /** The disk under ~/ssd on a network mount that hangs: every stat, lstat and realpath there never returns. */
  const hungUnder = (prefix: string) => {
    const real = testHost();
    const never =
      <T>(call: (path: string) => Promise<T>) =>
      (path: string) =>
        path.startsWith(prefix) ? new Promise<T>(() => {}) : call(path);
    return {
      ...real,
      fs: {
        ...real.fs,
        stat: never(real.fs.stat),
        lstat: never(real.fs.lstat),
        realpath: never(real.fs.realpath),
      },
    };
  };
  const options = {
    env: { PLAINPORT_STORE_PASSWORD: "pw" },
    name: "ssd",
    store: { kind: "local" as const, path: "~/ssd/store" },
    opener,
    probe: { scheduler: atOnce },
  };

  test("a pinned store folder whose stat never returns (a hung network mount, D32) is store.unreachable at the deadline", async () => {
    const first = await setUpWith(testHost());
    expect(first.ok ? "set up" : first.finding.message).toBe("set up");
    const result = await checkStorePin(hungUnder(join(box.home, "ssd")), { ...options, paths: box.paths });
    expect(result.ok ? 0 : [result.finding.code, result.finding.message]).toEqual([
      "store.unreachable",
      expect.stringContaining("did not answer within 10 seconds"),
    ]);
  });

  test("a new, unpinned store on a hung mount is store.unreachable at the deadline: resolving its path is bounded too", async () => {
    const result = await setUpStore(hungUnder(join(box.home, "ssd")), {
      ...options,
      paths: box.paths,
      mint: () => ulid(),
    });
    expect(result.ok ? 0 : [result.finding.code, result.finding.message]).toEqual([
      "store.unreachable",
      expect.stringContaining("did not answer within 10 seconds"),
    ]);
    expect(await pinned()).toBeUndefined();
  });

  test("a store folder that cannot be looked at is store.unreachable, never an exception", async () => {
    const result = await setUpWith(failing("stat", join(box.home, "ssd/store"), "EIO"));
    expect(result.ok ? 0 : [result.finding.code, result.finding.message]).toEqual([
      "store.unreachable",
      expect.stringContaining("cannot be looked at (EIO)"),
    ]);
  });

  test("a store folder that cannot be made (a read-only volume) is store.unreachable", async () => {
    const result = await setUpWith(failing("mkdirp", join(box.home, "ssd/store"), "EROFS"));
    expect(result.ok ? 0 : [result.finding.code, result.finding.message]).toEqual([
      "store.unreachable",
      expect.stringContaining("could not be made (EROFS)"),
    ]);
    expect(await pinned()).toBeUndefined();
  });
});
