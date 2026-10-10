import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent,
  type CatalogEvent,
  ensureStoreIdentity,
  guardedFs,
  type LocalIo,
  loadCatalog,
  mirrorEventLog,
  PATH_REFUSED,
  PathGuard,
  readEvents,
  resolvePaths,
  type Scheduler,
  STORE_PROBE_DEADLINE_MS,
  storeEventLog,
  ulid,
} from "@plainport/core";
import { blobStoreContract } from "../../core/src/testing/blob-store-contract.ts";
import { testHost } from "../../core/src/testing/host.ts";
import { fsBlobStore, openEventMirror } from "./index.ts";

const temp = () => mkdtempSync(join(tmpdir(), "plainport-blob-fs-"));
// Every test goes through the guarded test host, as production goes through the host port.
const io = testHost();

/** The io of a file system without hard links (exFAT, FAT32, some SMB mounts): link() fails with `code`. */
const withoutLinks = (code: string): LocalIo => ({
  ...io,
  fs: {
    ...io.fs,
    link: async () => {
      throw Object.assign(new Error(`${code}: operation not supported, link`), { code });
    },
  },
});

blobStoreContract("blob-fs", () => {
  const dir = temp();
  return { store: fsBlobStore(io, dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
});

// D41: where link() is refused, create-only falls back to an exclusive open, keeping exactly one winner.
for (const code of ["EPERM", "ENOTSUP", "EOPNOTSUPP"]) {
  blobStoreContract(`blob-fs without hard links (${code})`, () => {
    const dir = temp();
    return {
      store: fsBlobStore(withoutLinks(code), dir),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  });
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("blob-fs on disk", () => {
  let dir: string;
  beforeEach(() => {
    dir = temp();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("reports create-if-absent, and no replace-if-match", () => {
    expect(fsBlobStore(io, dir).capabilities()).toEqual({ createIfAbsent: true, replaceIfMatch: false });
    expect(() => fsBlobStore(io, dir).put("a", bytes("x"), { ifMatch: "etag" })).toThrow();
  });

  test("keys are paths under the store root, and writes leave no temporary files behind", async () => {
    const store = fsBlobStore(io, dir);
    expect((await store.put("meta/v1/events/01.json", bytes("one"), { ifNotExists: true })).ok).toBe(true);
    expect((await store.put("meta/v1/events/01.json", bytes("two"), { ifNotExists: true })).ok).toBe(false);
    expect((await store.put("meta/v1/state.json", bytes("s1"))).ok).toBe(true);
    expect((await store.put("meta/v1/state.json", bytes("s2"))).ok).toBe(true);
    expect(readFileSync(join(dir, "meta/v1/events/01.json"), "utf8")).toBe("one");
    expect(readFileSync(join(dir, "meta/v1/state.json"), "utf8")).toBe("s2");
    expect(readdirSync(join(dir, "meta/v1/events"))).toEqual(["01.json"]);
    expect(readdirSync(join(dir, "meta/v1")).sort()).toEqual(["events", "state.json"]);
  });

  test("a temporary file a crashed writer left, and macOS metadata files, are not listed as keys", async () => {
    mkdirSync(join(dir, "meta/v1/events"), { recursive: true });
    writeFileSync(join(dir, "meta/v1/events/01.json.4242.abcdef012345.tmp"), "half");
    // What macOS leaves on exFAT/FAT/SMB volumes (seen on the exFAT image in the T1 suite), and Finder's file.
    writeFileSync(join(dir, "meta/v1/events/._02.json"), "appledouble");
    writeFileSync(join(dir, "meta/v1/.DS_Store"), "finder");
    writeFileSync(join(dir, "meta/v1/events/02.json"), "whole");
    const listed = await fsBlobStore(io, dir).list("meta/v1/events/");
    expect(listed.ok && listed.value.map((e) => e.key)).toEqual(["meta/v1/events/02.json"]);
  });

  test("an unmounted store is store.unreachable, and a write never creates its root", async () => {
    const gone = join(dir, "Volumes", "Archive", "plainport");
    const store = fsBlobStore(io, gone);
    for (const result of [
      await store.put("meta/v1/events/01.json", bytes("x"), { ifNotExists: true }),
      await store.put("meta/v1/state.json", bytes("x")),
      await store.get("meta/v1/state.json"),
      await store.list("meta/v1/events/"),
      await store.stat("meta/v1/state.json"),
      await store.delete("meta/v1/state.json"),
    ]) {
      expect(result).toMatchObject({ ok: false, exitCode: 9, finding: { code: "store.unreachable" } });
    }
    expect(existsSync(join(dir, "Volumes"))).toBe(false);
  });

  test("a store root that is a file is store.unreachable too", async () => {
    writeFileSync(join(dir, "file"), "x");
    expect(await fsBlobStore(io, join(dir, "file")).list("")).toMatchObject({
      ok: false,
      finding: { code: "store.unreachable" },
    });
  });

  test("a key whose parent is a file is store.failed, with the path", async () => {
    const store = fsBlobStore(io, dir);
    await store.put("a", bytes("file"));
    const result = await store.put("a/b", bytes("x"));
    expect(result).toMatchObject({ ok: false, finding: { code: "store.failed" } });
  });

  test("without hard links a create-only write leaves no temporary file and still refuses an existing key", async () => {
    const store = fsBlobStore(withoutLinks("ENOTSUP"), dir);
    expect((await store.put("meta/v1/events/01.json", bytes("one"), { ifNotExists: true })).ok).toBe(true);
    const again = await store.put("meta/v1/events/01.json", bytes("two"), { ifNotExists: true });
    expect(again).toMatchObject({ ok: false, finding: { code: "store.key-exists" } });
    expect(readdirSync(join(dir, "meta/v1/events"))).toEqual(["01.json"]);
    expect(readFileSync(join(dir, "meta/v1/events/01.json"), "utf8")).toBe("one");
  });

  test("every read and write goes through the io it was given, so the host guard sees it", async () => {
    const guarded: LocalIo = { ...io, fs: guardedFs(io.fs, new PathGuard({ refuse: [dir], readOnly: [] })) };
    const store = fsBlobStore(guarded, join(dir, "store"));
    await expect(store.put("a", bytes("x"))).rejects.toMatchObject({ code: PATH_REFUSED });
    await expect(store.list("")).rejects.toMatchObject({ code: PATH_REFUSED });
    expect(existsSync(join(dir, "store"))).toBe(false);
  });

  test("a symlink inside the store is not followed out of it by list", async () => {
    const outside = temp();
    try {
      writeFileSync(join(outside, "secret.json"), "{}");
      mkdirSync(join(dir, "meta/v1/events"), { recursive: true });
      require("node:fs").symlinkSync(outside, join(dir, "meta/v1/events/link"));
      const listed = await fsBlobStore(io, dir).list("");
      expect(listed.ok && listed.value).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("blob-fs event mirror", () => {
  let home: string;
  beforeEach(() => {
    home = temp();
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const STORE_ID = ulid(900, (b) => b);

  test("openEventMirror creates <cache>/plainport/<store id> through the io and returns a store on it", async () => {
    const paths = resolvePaths({ HOME: home });
    if (!paths.ok) throw new Error(paths.finding.message);
    const mirror = await openEventMirror(io, paths.value, STORE_ID);
    if (!mirror.ok) throw new Error(mirror.finding.message);
    expect(existsSync(join(home, ".cache/plainport", STORE_ID))).toBe(true);
    expect((await mirror.value.put("events/x.json", bytes("{}"))).ok).toBe(true);
    expect(readFileSync(join(home, ".cache/plainport", STORE_ID, "events/x.json"), "utf8")).toBe("{}");
    // Opening it again is fine.
    expect((await openEventMirror(io, paths.value, STORE_ID)).ok).toBe(true);
  });

  test("a cache folder that cannot be made is store.failed naming the cache, never 'mount the disk'", async () => {
    writeFileSync(join(home, ".cache"), "a file where the folder should be");
    const paths = resolvePaths({ HOME: home });
    if (!paths.ok) throw new Error(paths.finding.message);
    const mirror = await openEventMirror(io, paths.value, STORE_ID);
    expect(mirror).toMatchObject({ ok: false, finding: { code: "store.failed" } });
    expect(mirror.ok || mirror.finding.message).toContain(`.cache/plainport/${STORE_ID}`);
    expect(mirror.ok || mirror.finding.fix).not.toContain("mount");
  });
});

describe("blob-fs carries the catalog", () => {
  let dir: string;
  beforeEach(() => {
    dir = temp();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const idAt = (ms: number) => ulid(ms, (b) => b);
  const event = (n: number): CatalogEvent => ({
    v: 1,
    id: idAt(1000 + n),
    type: "offloaded",
    device: idAt(3),
    at: "2026-10-03T12:00:00.000Z",
    op: idAt(500 + n),
    project: idAt(1),
    root: idAt(2),
    path: "web",
    snapshot: idAt(500 + n),
    ...(n > 1 ? { base: idAt(500 + n - 1) } : {}),
    stored: { ssd: "ef".repeat(32) },
    stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
  });

  test("events land at <store>/meta/v1/events/<ulid>.json, fold to state, and mirror to the cache", async () => {
    const storeRoot = join(dir, "ssd");
    mkdirSync(storeRoot);
    const store = fsBlobStore(io, storeRoot);
    const STORE_ID = ulid(900, (b) => b);
    const identity = await ensureStoreIdentity(store, () => STORE_ID);
    expect(identity.ok && identity.value.id).toBe(STORE_ID);
    expect(JSON.parse(readFileSync(join(storeRoot, "meta/v1/store.json"), "utf8"))).toEqual({
      v: 1,
      id: STORE_ID,
    });
    for (const n of [1, 2]) expect((await appendEvent(storeEventLog(store), event(n))).ok).toBe(true);
    expect(readdirSync(join(storeRoot, "meta/v1/events")).sort()).toEqual([
      `${event(1).id}.json`,
      `${event(2).id}.json`,
    ]);

    const paths = resolvePaths({ HOME: dir });
    if (!paths.ok) throw new Error(paths.finding.message);
    const opened = await openEventMirror(io, paths.value, STORE_ID);
    if (!opened.ok) throw new Error(opened.finding.message);
    const mirror = opened.value;
    const mirrorRoot = join(dir, ".cache", "plainport", STORE_ID);
    const now = new Date("2026-10-03T12:00:00.000Z");

    const online = await loadCatalog({ store, mirror, storeId: STORE_ID, now });
    if (!online.ok) throw new Error(online.finding.message);
    expect(online.value).toMatchObject({ stale: false, source: "store", syncedAt: now.toISOString() });
    expect(online.value.state.projects[idAt(1)]).toMatchObject({ status: "shelved", head: idAt(502) });
    // D45: a read never writes to the store.
    expect(readdirSync(join(storeRoot, "meta/v1")).sort()).toEqual(["events", "store.json"]);
    expect(existsSync(join(mirrorRoot, "state.json"))).toBe(true);
    expect(readdirSync(join(mirrorRoot, "events")).length).toBe(2);
    const offlineEvents = await readEvents(mirrorEventLog(mirror));
    expect(offlineEvents.ok && offlineEvents.value.events).toEqual([event(1), event(2)]);

    // The disk is unplugged: the same state comes from the mirror, marked stale.
    rmSync(storeRoot, { recursive: true, force: true });
    const offline = await loadCatalog({ store, mirror, storeId: STORE_ID, now: new Date() });
    if (!offline.ok) throw new Error(offline.finding.message);
    expect(offline.value).toMatchObject({
      stale: true,
      source: "mirror",
      state: online.value.state,
      syncedAt: now.toISOString(),
    });
  });
});

describe("a store folder on a network mount that hangs (D32)", () => {
  /** A stat that never returns, as on a hung SMB or NFS mount. */
  const hung: LocalIo = { ...io, fs: { ...io.fs, stat: () => new Promise(() => {}) } };
  /** A fake scheduler whose timers fire at once, recording the deadline each was given. */
  const deadlines: number[] = [];
  const atOnce: Scheduler = {
    setTimer: (fire, ms) => {
      deadlines.push(ms);
      queueMicrotask(fire);
      return undefined;
    },
    clearTimer: () => {},
  };

  test("every call's root probe fails as store.unreachable at the deadline, 10 seconds by default", async () => {
    const dir = temp();
    try {
      const store = fsBlobStore(hung, dir, { scheduler: atOnce });
      const results = await Promise.all([
        store.get("meta/x"),
        store.list("meta/"),
        store.put("meta/y", new Uint8Array()),
      ]);
      for (const result of results)
        expect(result.ok ? "ok" : [result.finding.code, result.finding.message]).toEqual([
          "store.unreachable",
          expect.stringContaining("did not answer within 10 seconds"),
        ]);
      expect(deadlines).toEqual([STORE_PROBE_DEADLINE_MS, STORE_PROBE_DEADLINE_MS, STORE_PROBE_DEADLINE_MS]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
