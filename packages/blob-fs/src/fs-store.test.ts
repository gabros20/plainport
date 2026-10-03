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
  loadCatalogState,
  mirrorEventLog,
  readEvents,
  storeEventLog,
  syncMirror,
  ulid,
} from "@plainport/core";
import { blobStoreContract } from "../../core/src/testing/blob-store-contract.ts";
import { fsBlobStore } from "./index.ts";

const temp = () => mkdtempSync(join(tmpdir(), "plainport-blob-fs-"));

blobStoreContract("blob-fs", () => {
  const dir = temp();
  return { store: fsBlobStore(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
});

const bytes = (text: string) => new TextEncoder().encode(text);

describe("blob-fs on disk", () => {
  let dir: string;
  beforeEach(() => {
    dir = temp();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("reports create-if-absent, and no replace-if-match", () => {
    expect(fsBlobStore(dir).capabilities()).toEqual({ createIfAbsent: true, replaceIfMatch: false });
    expect(() => fsBlobStore(dir).put("a", bytes("x"), { ifMatch: "etag" })).toThrow();
  });

  test("keys are paths under the store root, and writes leave no temporary files behind", async () => {
    const store = fsBlobStore(dir);
    expect((await store.put("meta/v1/events/01.json", bytes("one"), { ifNotExists: true })).ok).toBe(true);
    expect((await store.put("meta/v1/events/01.json", bytes("two"), { ifNotExists: true })).ok).toBe(false);
    expect((await store.put("meta/v1/state.json", bytes("s1"))).ok).toBe(true);
    expect((await store.put("meta/v1/state.json", bytes("s2"))).ok).toBe(true);
    expect(readFileSync(join(dir, "meta/v1/events/01.json"), "utf8")).toBe("one");
    expect(readFileSync(join(dir, "meta/v1/state.json"), "utf8")).toBe("s2");
    expect(readdirSync(join(dir, "meta/v1/events"))).toEqual(["01.json"]);
    expect(readdirSync(join(dir, "meta/v1")).sort()).toEqual(["events", "state.json"]);
  });

  test("a temporary file a crashed writer left is not listed as a key", async () => {
    mkdirSync(join(dir, "meta/v1/events"), { recursive: true });
    writeFileSync(join(dir, "meta/v1/events/01.json.4242.abcdef012345.tmp"), "half");
    writeFileSync(join(dir, "meta/v1/events/02.json"), "whole");
    const listed = await fsBlobStore(dir).list("meta/v1/events/");
    expect(listed.ok && listed.value.map((e) => e.key)).toEqual(["meta/v1/events/02.json"]);
  });

  test("an unmounted store is store.unreachable, and a write never creates its root", async () => {
    const gone = join(dir, "Volumes", "Archive", "plainport");
    const store = fsBlobStore(gone);
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
    expect(await fsBlobStore(join(dir, "file")).list("")).toMatchObject({
      ok: false,
      finding: { code: "store.unreachable" },
    });
  });

  test("a key whose parent is a file is store.failed, with the path", async () => {
    const store = fsBlobStore(dir);
    await store.put("a", bytes("file"));
    const result = await store.put("a/b", bytes("x"));
    expect(result).toMatchObject({ ok: false, finding: { code: "store.failed" } });
  });

  test("a symlink inside the store is not followed out of it by list", async () => {
    const outside = temp();
    try {
      writeFileSync(join(outside, "secret.json"), "{}");
      mkdirSync(join(dir, "meta/v1/events"), { recursive: true });
      require("node:fs").symlinkSync(outside, join(dir, "meta/v1/events/link"));
      const listed = await fsBlobStore(dir).list("");
      expect(listed.ok && listed.value).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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
    const store = fsBlobStore(storeRoot);
    for (const n of [1, 2]) expect((await appendEvent(storeEventLog(store), event(n))).ok).toBe(true);
    expect(readdirSync(join(storeRoot, "meta/v1/events")).sort()).toEqual([
      `${event(1).id}.json`,
      `${event(2).id}.json`,
    ]);

    const state = await loadCatalogState(store);
    if (!state.ok) throw new Error(state.finding.message);
    expect(state.value.state.projects[idAt(1)]).toMatchObject({ status: "shelved", head: idAt(502) });
    expect(existsSync(join(storeRoot, "meta/v1/state.json"))).toBe(true);

    const mirrorRoot = join(dir, "cache", "plainport", "ssd");
    mkdirSync(mirrorRoot, { recursive: true });
    const mirror = fsBlobStore(mirrorRoot);
    const synced = await syncMirror(storeEventLog(store), mirrorEventLog(mirror));
    expect(synced.ok && synced.value.copied).toBe(2);
    expect(readdirSync(join(mirrorRoot, "events")).length).toBe(2);
    const offline = await readEvents(mirrorEventLog(mirror));
    expect(offline.ok && offline.value.events).toEqual([event(1), event(2)]);
  });
});
