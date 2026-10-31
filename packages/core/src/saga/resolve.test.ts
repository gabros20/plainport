// plainport resolve --keep (M2 Task 25; DESIGN.md "Catalog and data model" → Resolution, "Conflict at step 7"): two
// devices in process on one fake format-2 store fork the project, then settle it with the saga. Every resolved event
// it writes is judged by Task 12's fold (R2-2): valid, complete and active once written.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "@plainport/contract";
import { allEvents, type FakeDevice, fakeDevices } from "../../../../test/support/fake-devices.ts";
import type { CatalogEvent } from "../catalog/events.ts";
import { foldCatalog } from "../catalog/fold.ts";
import { ConfigLoader } from "../config/load.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import { projectViews } from "../status/projects.ts";
import { testHost } from "../testing/host.ts";
import { type SemanticBlobStore, semanticBlobStore } from "../testing/semantic-blob-store.ts";
import type { OffloadConflict } from "./release.ts";
import type { ResolveOutcome } from "./resolve.ts";

let devices: FakeDevice[] = [];
afterEach(async () => {
  for (const d of devices) await d.box.cleanupSettled();
  devices = [];
});

/**
 * The fake store, with a hook that runs before each write (to stage a race: another device acts between this device's
 * read and its append) and a switch that takes it down.
 */
const racing = (fake: SemanticBlobStore) => {
  let down = false;
  const hook: { beforePut?: (key: string, data: Uint8Array) => Promise<void> } = {};
  const gone = () =>
    Promise.resolve({
      ok: false as const,
      exitCode: 9 as const,
      finding: {
        code: "store.unreachable",
        severity: "block" as const,
        message: "the store is down",
        allowable: false,
      },
    });
  const store: SemanticBlobStore & { hook: typeof hook; setDown(on: boolean): void } = {
    ...fake,
    get: (key) => (down ? gone() : fake.get(key)),
    list: (prefix) => (down ? gone() : fake.list(prefix)),
    stat: (key) => (down ? gone() : fake.stat(key)),
    put: async (key, data, opts) => {
      if (down) return gone();
      const before = hook.beforePut;
      if (before !== undefined) await before(key, data);
      return fake.put(key, data, opts);
    },
    hook,
    setDown: (on) => {
      down = on;
    },
  };
  return store;
};

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};
const journalsOf = (d: FakeDevice) =>
  existsSync(d.box.paths.journalDir)
    ? readdirSync(d.box.paths.journalDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(d.box.paths.journalDir, f), "utf8")) as { step: string })
    : [];
const settled = async (d: FakeDevice) => {
  const busy = () =>
    existsSync(join(d.box.home, "work/.plainport-trash")) ||
    journalsOf(d).some((j) => j.step === "offload.release.delete");
  for (let i = 0; i < 400 && busy(); i++) await Bun.sleep(25);
};

/** Both devices onloaded from one head, each with an edit of its own. */
const world = async (format: 1 | 2 = 2) => {
  const store = racing(semanticBlobStore());
  devices = await fakeDevices(store, ["dev-a", "dev-b"], { format });
  const [a, b] = devices as [FakeDevice, FakeDevice];
  a.box.file("work/web/package.json", `${JSON.stringify({ name: "web" })}\n`);
  a.box.file("work/web/src/main.ts", "export const main = 0;\n");
  value(await a.offload());
  await settled(a);
  value(await b.onload());
  value(await a.onload());
  writeFileSync(join(a.dir(), "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(b.dir(), "src/b.ts"), "export const b = 1;\n");
  const first = (await allEvents(store)).find((e) => e.type === "offloaded");
  if (first?.type !== "offloaded") throw new Error("no first offload");
  return { store, a, b, project: first.project, base: first.snapshot };
};
type World = Awaited<ReturnType<typeof world>>;

/**
 * The fork: dev-b offloads to its end while dev-a uploads, so dev-b is released (its stub names its snapshot) and
 * dev-a's commit finds the head moved and keeps its folder on its own snapshot (F1).
 */
const fork = async (w: World) => {
  w.a.engine.hooks.duringSnapshot = async () => {
    w.a.engine.hooks.duringSnapshot = undefined;
    value(await w.b.offload());
  };
  const byA = await w.a.offload();
  expect(byA.ok ? "released" : [byA.exitCode, byA.finding.code]).toEqual([8, "catalog.head-moved"]);
  await settled(w.b);
  const aSnap = (byA.ok ? undefined : (byA.data as OffloadConflict))?.snapshot as string;
  const project = await foldOf(w);
  const bSnap = project?.heads.find((s) => s !== aSnap) as string;
  expect([project?.status, [...(project?.heads ?? [])].sort()]).toEqual([
    "conflicted",
    [aSnap, bSnap].sort(),
  ]);
  expect((await w.a.entry())?.base).toBe(aSnap);
  expect(existsSync(w.a.dir())).toBe(true);
  expect(existsSync(w.b.dir())).toBe(false);
  return { aSnap, bSnap };
};

const foldOf = async (w: World) => foldCatalog(await allEvents(w.store)).projects[w.project];
const resolvedEvents = async (w: World) =>
  (await allEvents(w.store)).filter(
    (e): e is Extract<CatalogEvent, { type: "resolved" }> => e.type === "resolved",
  );

/** R2-2: the event the run wrote passes Task 12's validation: valid, complete, and active in the fold. */
const expectValid = async (w: World, done: ResolveOutcome) => {
  expect(done.outcome).toBe("resolved");
  const project = await foldOf(w);
  expect(project?.invalid).toEqual([]);
  expect(project?.missing).toEqual([]);
  expect(project?.resolutions).toContain(done.event as string);
};

describe("resolve: the gate and the rules", () => {
  test("resolve --keep on A, then B's onload gets the kept snapshot; a re-run is a no-op", async () => {
    const w = await world();
    const { aSnap, bSnap } = await fork(w);

    const done = value(await w.a.resolve(aSnap));
    expect([done.keep, done.over, done.supersedes, done.head, done.project]).toEqual([
      aSnap,
      [bSnap],
      [],
      aSnap,
      "work:web",
    ]);
    await expectValid(w, done);
    const [event] = await resolvedEvents(w);
    expect(event).toMatchObject({
      id: done.event,
      device: w.a.device.id,
      project: w.project,
      keep: aSnap,
      over: [bSnap],
      supersedes: [],
    });
    expect((await foldOf(w))?.head).toBe(aSnap);

    // A re-run: nothing to resolve, nothing written.
    const again = value(await w.a.resolve(aSnap));
    expect([again.outcome, again.head, again.event]).toEqual(["nothing-to-resolve", aSnap, undefined]);
    expect(await resolvedEvents(w)).toHaveLength(1);

    // dev-b, shelved by its own offload, onloads the kept snapshot: dev-a's edit, not its own.
    const onloaded = value(await w.b.onload());
    expect(onloaded.snapshot).toBe(aSnap);
    expect(readFileSync(join(w.b.dir(), "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(existsSync(join(w.b.dir(), "src/b.ts"))).toBe(false);
    // The rejected snapshot stays in the store and the catalog.
    expect((await foldOf(w))?.rejected).toEqual([bSnap]);
    expect((await foldOf(w))?.snapshots[bSnap]).toBeDefined();
  });

  test("restore --snapshot <rejected> still reads the rejected copy side by side", async () => {
    const w = await world();
    const { aSnap, bSnap } = await fork(w);
    await expectValid(w, value(await w.a.resolve(aSnap)));
    const to = join(w.b.box.home, "old-b");
    const restored = value(await w.b.restore(bSnap, to));
    expect(restored.snapshot).toBe(bSnap);
    expect(readFileSync(join(to, "src/b.ts"), "utf8")).toBe("export const b = 1;\n");
  });

  test("a project that is not conflicted: exit 0, nothing to resolve, nothing written", async () => {
    const w = await world();
    const done = value(await w.b.resolve(w.base));
    expect([done.outcome, done.head, done.event]).toEqual(["nothing-to-resolve", w.base, undefined]);
    expect(await resolvedEvents(w)).toEqual([]);
    // A requested snapshot that is not the head is not echoed as kept (review r2 M5).
    const other = value(await w.b.resolve("01JZZZZZZZZZZZZZZZZZZZZZZZ"));
    expect([other.outcome, other.keep, other.head]).toEqual(["nothing-to-resolve", undefined, w.base]);
  });

  test("a copy here on no live tip: copy-here's fix is offload --fork, and the fork then resolves (D114)", async () => {
    const store = racing(semanticBlobStore());
    devices = await fakeDevices(store, ["dev-a", "dev-b", "dev-c"], { format: 2 });
    const [a, b, c] = devices as [FakeDevice, FakeDevice, FakeDevice];
    a.box.file("work/web/package.json", `${JSON.stringify({ name: "web" })}\n`);
    a.box.file("work/web/src/main.ts", "export const main = 0;\n");
    value(await a.offload());
    await settled(a);
    for (const d of [b, c, a]) value(await d.onload());
    for (const d of [a, b, c])
      writeFileSync(join(d.dir(), `src/${d.name}.ts`), `export const x = "${d.name}";\n`);
    // dev-a and dev-b fork; dev-c's copy stays on the first snapshot, which is no live tip.
    a.engine.hooks.duringSnapshot = async () => {
      a.engine.hooks.duringSnapshot = undefined;
      value(await b.offload());
    };
    const byA = await a.offload();
    const aSnap = (byA.ok ? undefined : (byA.data as OffloadConflict))?.snapshot as string;
    const refused = await c.resolve(aSnap);
    expect(refused.ok ? "resolved" : refused.finding.code).toBe("resolve.copy-here");
    expect(refused.ok ? "" : refused.finding.fix).toContain("plainport offload work:web --fork --yes");
    // Following the fix: the copy becomes a fork, a live tip, and resolve keeps it.
    const forked = await c.offload("web", undefined, { fork: true });
    expect(forked.ok ? "released" : forked.finding.code).toBe("catalog.head-moved");
    const cSnap = (forked.ok ? undefined : (forked.data as OffloadConflict))?.snapshot as string;
    expect((await c.entry())?.base).toBe(cSnap);
    const done = value(await c.resolve(cSnap));
    expect([done.outcome, done.keep, done.head, done.conflicted]).toEqual(["resolved", cSnap, cSnap, false]);
    expect(readFileSync(join(c.dir(), "src/dev-c.ts"), "utf8")).toBe('export const x = "dev-c";\n');
  });

  test("resolve runs alongside a held journal of the project, and names the held trash it rejects (M7)", async () => {
    const w = await world();
    w.a.configure('[offload]\nconflictGrace = "15m"');
    // dev-b offloads during dev-a's upload: dev-a forks; then dev-a onloads nothing, dev-b's copy is shelved. Instead:
    // dev-a offloads with the grace first (its trash held), then dev-b's copy forks with --fork.
    const held = value(await w.a.offload());
    expect(held.held).toBe(true);
    const byB = await w.b.offload("web", undefined, { fork: true });
    expect(byB.ok ? "released" : byB.finding.code).toBe("catalog.head-moved");
    const bSnap = (byB.ok ? undefined : (byB.data as OffloadConflict))?.snapshot as string;
    expect(journalsOf(w.a).map((j) => j.step)).toEqual(["offload.release.held"]);
    // dev-a holds no working copy (its folder is in the held trash): it resolves keeping dev-b's, past its own journal.
    const done = value(await w.a.resolve(bSnap));
    expect([done.outcome, done.head, done.over]).toEqual(["resolved", bSnap, [held.snapshot]]);
    expect(done.heldRejected?.map((h) => h.snapshot)).toEqual([held.snapshot]);
    expect(journalsOf(w.a).map((j) => j.step)).toEqual(["offload.release.held"]);
  });

  test("a copy whose root is not mounted cannot be told apart from none: resolve refuses (root.path-missing)", async () => {
    const w = await world();
    const { bSnap } = await fork(w);
    const root = join(w.a.box.home, "work");
    const away = join(w.a.box.home, "work-away");
    renameSync(root, away);
    try {
      const refused = await w.a.resolve(bSnap);
      expect(refused.ok ? "resolved" : [refused.exitCode, refused.finding.code]).toEqual([
        6,
        "root.path-missing",
      ]);
      expect(await resolvedEvents(w)).toEqual([]);
    } finally {
      renameSync(away, root);
    }
  });

  test("a format-1 store refuses with store upgrade as the fix, and writes nothing", async () => {
    const w = await world(1);
    const { aSnap } = await fork(w);
    const refused = await w.a.resolve(aSnap);
    expect(refused.ok ? "resolved" : [refused.exitCode, refused.finding.code]).toEqual([
      6,
      "store.needs-upgrade",
    ]);
    expect(refused.ok ? "" : refused.finding.fix).toContain(
      "plainport store upgrade ssd --others-stopped --yes",
    );
    expect(await resolvedEvents(w)).toEqual([]);
  });

  test("--keep naming another device's snapshot while a copy is here refuses, and the fix is exact", async () => {
    const w = await world();
    const { aSnap, bSnap } = await fork(w);
    const refused = await w.a.resolve(bSnap);
    expect(refused.ok ? "resolved" : [refused.exitCode, refused.finding.code]).toEqual([
      6,
      "resolve.copy-here",
    ]);
    expect(refused.ok ? "" : refused.finding.fix).toStartWith(
      `plainport resolve work:web --keep ${aSnap} --yes`,
    );
    expect(refused.ok ? [] : refused.finding.paths).toEqual([w.a.dir()]);
    expect(await resolvedEvents(w)).toEqual([]);
    // dev-b holds no copy (its stub): it may keep either side.
    await expectValid(w, value(await w.b.resolve(bSnap)));
    expect((await foldOf(w))?.head).toBe(bSnap);
  });

  test("--keep must name a live tip: an older snapshot refuses with the tips, an unknown one is not found", async () => {
    const w = await world();
    const { aSnap, bSnap } = await fork(w);
    const older = await w.b.resolve(w.base);
    expect(older.ok ? "resolved" : [older.exitCode, older.finding.code]).toEqual([6, "resolve.not-live-tip"]);
    expect(older.ok ? "" : older.finding.message).toContain([aSnap, bSnap].sort().join(", "));
    const unknown = await w.b.resolve("01JZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(unknown.ok ? "resolved" : [unknown.exitCode, unknown.finding.code]).toEqual([
      4,
      "snapshot.not-found",
    ]);
    expect(await resolvedEvents(w)).toEqual([]);
  });

  test("an unfinished journal refuses (journal.pending, fix: recover); the store unreachable refuses", async () => {
    const w = await world();
    const { aSnap } = await fork(w);
    // A fresh read or nothing: the store down refuses, it never resolves from the mirror.
    w.store.setDown(true);
    const down = await w.a.resolve(aSnap);
    expect(down.ok ? "resolved" : [down.exitCode, down.finding.code]).toEqual([9, "store.unreachable"]);
    w.store.setDown(false);
    // dev-b onloads the kept head and offloads; the store goes down right after its commit, so its journal stays open.
    await expectValid(w, value(await w.a.resolve(aSnap)));
    value(await w.b.onload());
    writeFileSync(join(w.b.dir(), "src/b2.ts"), "export const b2 = 2;\n");
    const byB = await w.b.offload("web", {
      onStep: (step) => {
        if (step === "offload.committed") w.store.setDown(true);
      },
    });
    expect(byB.ok ? "released" : byB.finding.code).toBe("store.unreachable");
    w.store.setDown(false);
    const pending = await w.b.resolve(aSnap);
    expect(pending.ok ? "resolved" : [pending.exitCode, pending.finding.code]).toEqual([
      6,
      "journal.pending",
    ]);
    expect(pending.ok ? "" : pending.finding.fix).toContain("plainport recover");
  });

  test("competing resolutions on A and B stay conflicted until a superseding one", async () => {
    const w = await world();
    const { aSnap, bSnap } = await fork(w);
    // dev-a reads, and before its append lands dev-b reads and appends its own: neither saw the other's.
    let raced: Promise<void> | undefined;
    w.store.hook.beforePut = async (key) => {
      if (raced !== undefined || !key.includes("events/")) return;
      raced = (async () => {
        await expectValid(w, value(await w.b.resolve(bSnap)));
      })();
      await raced;
    };
    const byA = value(await w.a.resolve(aSnap));
    w.store.hook.beforePut = undefined;
    expect(byA.supersedes).toEqual([]);
    // Read again after its append: still conflicted, so no head is reported (review r2 M5).
    expect([byA.head, byA.conflicted]).toEqual([null, true]);
    const project = await foldOf(w);
    expect(project?.status).toBe("conflicted");
    expect(project?.head).toBeNull();
    expect(project?.resolutions).toHaveLength(2);
    expect(project?.rejected).toEqual([]);
    expect([...(project?.heads ?? [])].sort()).toEqual([aSnap, bSnap].sort());

    // A third, from a fresh read, supersedes both.
    const settles = value(await w.a.resolve(aSnap));
    await expectValid(w, settles);
    expect(settles.supersedes).toEqual([...(project?.resolutions ?? [])].sort());
    expect([(await foldOf(w))?.head, (await foldOf(w))?.status]).toEqual([aSnap, "shelved"]);
  });

  test("status lists each head of a conflicted project: its device, time, size and base", async () => {
    const w = await world();
    const { aSnap, bSnap } = await fork(w);
    const viewsOf = async (d: FakeDevice) =>
      value(
        await projectViews({
          io: testHost(),
          paths: d.box.paths,
          env: { HOME: d.box.home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
          device: d.device,
          loader: new ConfigLoader(testHost(), d.box.paths),
          opener: {
            open: async () => ({ ok: true, value: { blob: w.store as BlobStore, engine: d.engine } }),
          },
          openMirror: async () => ({ ok: true, value: d.mirror }),
        }),
      ).projects.find((p) => p.address === "work:web");
    const view = await viewsOf(w.a);
    expect(view?.state).toBe("conflicted");
    expect(view?.heads?.map((h) => [h.snapshot, h.device, h.base, h.here])).toEqual(
      [
        [aSnap, w.a.device.id, w.base, true],
        [bSnap, w.b.device.id, w.base, false],
      ].sort((x, y) => ((x[0] as string) < (y[0] as string) ? -1 : 1)),
    );
    for (const h of view?.heads ?? []) {
      expect(h.bytes).toBeGreaterThan(0);
      expect(Date.parse(h.at)).not.toBeNaN();
    }
    expect(view?.next?.command).toBe(`plainport resolve work:web --keep ${aSnap}`);
    // dev-b holds no copy: the next step names the command, the snapshot left to choose.
    expect((await viewsOf(w.b))?.next?.command).toBe("plainport resolve work:web --keep <snapshot>");
    // Once resolved, no heads list.
    await expectValid(w, value(await w.a.resolve(aSnap)));
    expect((await viewsOf(w.a))?.heads).toBeUndefined();
  });
});
