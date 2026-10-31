// The fork state machine (M2 Task 23; DESIGN.md "Conflict at step 7"): two devices in process on one fake store, each
// stage of the table asserted device by device (folder, stub, registry base, journal) after the live run and after
// recover. F1: the fork is seen at the commit's head check. F2: after the commit and before the rename, by release's
// re-read or recover's. F3: after the rename, which is never undone (Task 24 holds the trash with a conflict grace; without one it is
// released as before).

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, finding, type Result } from "@plainport/contract";
import { allEvents, type FakeDevice, fakeDevices } from "../../../../test/support/fake-devices.ts";
import { encodePlain, storeEventKey } from "../catalog/codec.ts";
import type { CatalogEvent } from "../catalog/events.ts";
import { foldCatalog, resolutionFor } from "../catalog/fold.ts";
import { appendEvent, storeEventLog } from "../catalog/log.ts";
import { ConfigLoader } from "../config/load.ts";
import type { RecoveryReport } from "../recover/recover.ts";
import { projectViews } from "../status/projects.ts";
import { StubSchema } from "../stub.ts";
import { testHost } from "../testing/host.ts";
import { catalogInvariantViolations, invariantViolations } from "../testing/invariants.ts";
import { type SemanticBlobStore, semanticBlobStore } from "../testing/semantic-blob-store.ts";
import { ulid } from "../ulid.ts";
import type { OffloadConflict } from "./release.ts";

let devices: FakeDevice[] = [];
afterEach(async () => {
  for (const d of devices) await d.box.cleanupSettled();
  devices = [];
});

/** A store that can be taken down and brought back: every call fails with store.unreachable while it is down. */
const downable = (fake: SemanticBlobStore) => {
  let down = false;
  const gone = () => Promise.resolve(fail(finding("store.unreachable", { message: "the store is down" })));
  const store: SemanticBlobStore & { setDown(on: boolean): void } = {
    ...fake,
    get: (key) => (down ? gone() : fake.get(key)),
    list: (prefix) => (down ? gone() : fake.list(prefix)),
    stat: (key) => (down ? gone() : fake.stat(key)),
    put: (key, data, opts) => (down ? gone() : fake.put(key, data, opts)),
    setDown: (on) => {
      down = on;
    },
  };
  return store;
};

/** Both devices on one shelved project, both onloaded from its one head, each with an edit of its own. */
const world = async () => {
  const store = downable(semanticBlobStore());
  devices = await fakeDevices(store, ["dev-a", "dev-b"]);
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
  return {
    store,
    a,
    b,
    project: first.project,
    root: first.root,
    base: first.snapshot,
    before: { events: await allEvents(store), snapshots: snapshotsOf(a) },
  };
};
type World = Awaited<ReturnType<typeof world>>;

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};
const reportOf = (result: Result<RecoveryReport>): RecoveryReport => {
  if (result.ok) return result.value;
  if (result.data === undefined) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.data as RecoveryReport;
};
const snapshotsOf = (d: FakeDevice) => d.engine.repository.snapshots.map((s) => s.info.id);
const journalsOf = (d: FakeDevice) =>
  existsSync(d.box.paths.journalDir)
    ? readdirSync(d.box.paths.journalDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(d.box.paths.journalDir, f), "utf8")) as { step: string })
    : [];
/** Waits until the detached delete ran: no trash left under the device's root, and its journal removed after it. */
const settled = async (d: FakeDevice) => {
  const busy = () =>
    existsSync(join(d.box.home, "work/.plainport-trash")) ||
    journalsOf(d).some((j) => j.step === "offload.release.delete");
  for (let i = 0; i < 400 && busy(); i++) await Bun.sleep(25);
};

/** Another copy's offload of the project on the same base, as a stranger device wrote it: a fork. */
const forkOf = (w: World, base = w.base): Extract<CatalogEvent, { type: "offloaded" }> => {
  const id = ulid();
  return {
    v: 1,
    id,
    op: id,
    type: "offloaded",
    device: ulid(),
    at: new Date().toISOString(),
    project: w.project,
    root: w.root,
    path: "web",
    base,
    snapshot: id,
    stored: { ssd: "c".repeat(64) },
    stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
  };
};
/** Puts an event on the store at once, from a synchronous crash seam: the bytes land between two of a saga's steps. */
const landNow = (w: World, event: CatalogEvent) =>
  w.store.data.set(storeEventKey(event.id), encodePlain(event));

/** A device's local row of the fork table: its folder, stub, registry base and open journals. */
const rowOf = async (d: FakeDevice) => {
  const stub = `${d.dir()}.plainport`;
  return {
    folder: existsSync(d.dir()),
    stub: existsSync(stub) ? StubSchema.parse(JSON.parse(readFileSync(stub, "utf8"))).snapshot : null,
    base: (await d.entry())?.base,
    journals: journalsOf(d).map((j) => j.step),
  };
};

/**
 * Invariants 1–3 on each device and 4–6 on the store. What each device's release could not have seen (Q16's residual)
 * is derived from what its re-read listed, never written by hand.
 */
const expectInvariants = async (w: World) => {
  for (const d of [w.a, w.b]) {
    await settled(d);
    expect({
      device: d.name,
      problems: await invariantViolations({
        now: new Date(),
        paths: d.box.paths,
        device: d.device.id,
        project: { id: w.project, dir: d.dir() },
        roots: [join(d.box.home, "work")],
        store: { name: "ssd", blob: w.store, engine: d.engine },
        ...(d.released === undefined ? {} : { released: d.released }),
        stripped: ["node_modules"],
        unseen: await d.unseen(),
      }),
    }).toEqual({ device: d.name, problems: [] });
  }
  expect(
    catalogInvariantViolations({
      events: await allEvents(w.store),
      eventsBefore: w.before.events,
      snapshotsBefore: w.before.snapshots,
      snapshotsNow: snapshotsOf(w.a),
    }),
  ).toEqual([]);
};

const foldOf = async (w: World) => foldCatalog(await allEvents(w.store)).projects[w.project];
const ownEvent = async (w: World, d: FakeDevice, snapshot: string) =>
  (await allEvents(w.store)).find(
    (e) => e.type === "offloaded" && e.snapshot === snapshot && e.device === d.device.id,
  );

describe("forks F1: the fork is seen at the commit's head check", () => {
  test("live: the folder stays, no stub, the base is its own snapshot, the journal closed; exit 8 kind fork", async () => {
    const w = await world();
    // dev-b offloads while dev-a uploads: dev-a passed its early head check, and its commit's finds the head moved.
    w.a.engine.hooks.duringSnapshot = async () => {
      w.a.engine.hooks.duringSnapshot = undefined;
      value(await w.b.offload());
    };
    const byA = await w.a.offload();
    expect(byA.ok ? "released" : [byA.exitCode, byA.finding.code]).toEqual([8, "catalog.head-moved"]);
    const data = (byA.ok ? undefined : byA.data) as OffloadConflict;
    expect([data.kind, data.detail]).toEqual(["fork", undefined]);
    expect(await rowOf(w.a)).toEqual({ folder: true, stub: null, base: data.snapshot, journals: [] });
    expect(readFileSync(join(w.a.dir(), "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    // dev-b released: its stub names its snapshot.
    const project = await foldOf(w);
    expect(project?.status).toBe("conflicted");
    const bSnap = project?.conflicts.flat().find((s) => s !== data.snapshot) as string;
    await settled(w.b);
    expect(await rowOf(w.b)).toEqual({ folder: false, stub: bSnap, base: bSnap, journals: [] });
    // dev-b released before dev-a's fork was appended: Q16's residual for dev-b.
    await expectInvariants(w);
  });

  test("after recover: a crash after the fork's event leaves the journal at diverged; recover keeps the same row", async () => {
    const w = await world();
    w.a.engine.hooks.duringSnapshot = async () => {
      w.a.engine.hooks.duringSnapshot = undefined;
      value(await w.b.offload());
    };
    await expect(w.a.offload("web", { at: "offload.diverged.appended" })).rejects.toThrow();
    expect(journalsOf(w.a).map((j) => j.step)).toEqual(["offload.diverged"]);
    const [op] = reportOf(await w.a.recover()).operations;
    expect([op?.outcome, op?.state]).toEqual(["forked", "conflicted"]);
    expect(await rowOf(w.a)).toEqual({ folder: true, stub: null, base: op?.snapshot, journals: [] });
    await expectInvariants(w);
  });
});

describe("forks F2: the fork is seen after the commit, before the rename", () => {
  test("live: release's re-read finds it; the folder stays, no stub, the base is its own snapshot, the journal closed; exit 8 fork after-commit", async () => {
    const w = await world();
    const fork = forkOf(w);
    const byA = await w.a.offload("web", {
      onStep: (step) => {
        if (step === "offload.committed") landNow(w, fork);
      },
    });
    expect(byA.ok ? "released" : [byA.exitCode, byA.finding.code]).toEqual([8, "catalog.head-moved"]);
    const data = (byA.ok ? undefined : byA.data) as OffloadConflict;
    expect([data.exitCode, data.kind, data.detail, data.project]).toEqual([
      8,
      "fork",
      "after-commit",
      "work:web",
    ]);
    expect(await rowOf(w.a)).toEqual({ folder: true, stub: null, base: data.snapshot, journals: [] });
    expect(readFileSync(join(w.a.dir(), "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    // Committed: its event is on the store, and the fold names it in the fork.
    expect(await ownEvent(w, w.a, data.snapshot)).toBeDefined();
    expect((await foldOf(w))?.conflicts).toEqual([[data.snapshot, fork.snapshot].sort()]);
    await expectInvariants(w);
  });

  test("a fork appended after the re-read is not seen: the release goes on (Q16's residual)", async () => {
    const w = await world();
    const fork = forkOf(w);
    const byA = value(
      await w.a.offload("web", {
        onStep: (step) => {
          if (step === "offload.release.reread") landNow(w, fork);
        },
      }),
    );
    await settled(w.a);
    expect(await rowOf(w.a)).toMatchObject({ folder: false, stub: byA.snapshot, base: byA.snapshot });
    await expectInvariants(w);
  });

  test("the invariant catches a release that went on although the fork was there to see", async () => {
    const w = await world();
    const fork = forkOf(w);
    value(
      await w.a.offload("web", {
        onStep: (step) => {
          if (step === "offload.release.reread") landNow(w, fork);
        },
      }),
    );
    await settled(w.a);
    const problems = await invariantViolations({
      now: new Date(),
      paths: w.a.box.paths,
      device: w.a.device.id,
      project: { id: w.project, dir: w.a.dir() },
      roots: [join(w.a.box.home, "work")],
      store: { name: "ssd", blob: w.store, engine: w.a.engine },
      ...(w.a.released === undefined ? {} : { released: w.a.released }),
      stripped: ["node_modules"],
    });
    expect(problems.some((p) => p.includes("invariant 1") && p.includes(fork.id))).toBe(true);
  });

  for (const at of ["offload.committed", "offload.release.trash", "offload.release.reread"])
    test(`after recover: a crash at ${at}, then a fork; recover's re-read keeps the same row`, async () => {
      const w = await world();
      await expect(w.a.offload("web", { at })).rejects.toThrow();
      const step = at === "offload.release.reread" ? "offload.release.trash" : at;
      expect(journalsOf(w.a).map((j) => j.step)).toEqual([step]);
      const fork = forkOf(w);
      value(await appendEvent(storeEventLog(w.store), fork));
      const report = await w.a.recover();
      const [op] = reportOf(report).operations;
      expect([op?.step, op?.outcome, op?.state]).toEqual([step, "forked", "conflicted"]);
      expect([op?.conflict?.kind, op?.conflict?.detail]).toEqual(["fork", "after-commit"]);
      expect(await rowOf(w.a)).toEqual({ folder: true, stub: null, base: op?.snapshot, journals: [] });
      await expectInvariants(w);
    });

  test("a re-read that leaves out an event it cannot read cannot tell: nothing moves, the journal stays (catalog.head-uncertain)", async () => {
    const w = await world();
    const torn = ulid();
    const byA = await w.a.offload("web", {
      onStep: (step) => {
        if (step === "offload.committed")
          w.store.data.set(storeEventKey(torn), new TextEncoder().encode("{ not an event\n"));
      },
    });
    expect(byA.ok ? "released" : byA.finding.code).toBe("catalog.head-uncertain");
    expect(await rowOf(w.a)).toMatchObject({ folder: true, stub: null, journals: ["offload.release.trash"] });
    const [held] = reportOf(await w.a.recover()).operations;
    expect([held?.outcome, held?.finding?.code]).toEqual(["pending", "catalog.head-uncertain"]);
    // Once the event reads (here: it is gone), recover finishes the release.
    w.store.data.delete(storeEventKey(torn));
    const [done] = reportOf(await w.a.recover()).operations;
    expect(done?.outcome).toBe("finished");
    await expectInvariants(w);
  });

  test("the store unreachable at the re-read: nothing moves, the journal stays; recover waits for the store, then releases", async () => {
    const w = await world();
    const byA = await w.a.offload("web", {
      onStep: (step) => {
        if (step === "offload.release.trash") w.store.setDown(true);
      },
    });
    expect(byA.ok ? "released" : [byA.exitCode, byA.finding.code]).toEqual([9, "store.unreachable"]);
    expect(await rowOf(w.a)).toMatchObject({ folder: true, stub: null, journals: ["offload.release.trash"] });
    // Recover with the store still down: pending, never released.
    const [held] = reportOf(await w.a.recover()).operations;
    expect([held?.outcome, held?.finding?.code]).toEqual(["pending", "store.unreachable"]);
    expect(await rowOf(w.a)).toMatchObject({ folder: true, stub: null, journals: ["offload.release.trash"] });
    w.store.setDown(false);
    const [done] = reportOf(await w.a.recover()).operations;
    expect(done?.outcome).toBe("finished");
    expect(await rowOf(w.a)).toEqual({
      folder: false,
      stub: done?.snapshot ?? null,
      base: done?.snapshot,
      journals: expect.any(Array),
    });
    await expectInvariants(w);
  });
});

/** Makes a device's registry.json unreadable from a synchronous seam, and gives back a way to restore it. */
const breakRegistry = (d: FakeDevice) => {
  const file = d.box.paths.registryFile;
  const kept = readFileSync(file, "utf8");
  writeFileSync(file, "{ not a registry\n");
  return () => writeFileSync(file, kept);
};

describe("forks: the base write that names the fork (review r1 #11)", () => {
  test("F1: a registry write that fails keeps the journal at diverged; recover writes the base, then closes it", async () => {
    const w = await world();
    w.a.engine.hooks.duringSnapshot = async () => {
      w.a.engine.hooks.duringSnapshot = undefined;
      value(await w.b.offload());
    };
    let restore = () => {};
    const byA = await w.a.offload("web", {
      onStep: (step) => {
        if (step === "offload.diverged.appended") restore = breakRegistry(w.a);
      },
    });
    expect(byA.ok ? "released" : byA.finding.code).toBe("registry.invalid");
    expect(journalsOf(w.a).map((j) => j.step)).toEqual(["offload.diverged"]);
    restore();
    const [op] = reportOf(await w.a.recover()).operations;
    expect([op?.outcome, op?.state]).toEqual(["forked", "conflicted"]);
    expect(await rowOf(w.a)).toEqual({ folder: true, stub: null, base: op?.snapshot, journals: [] });
    await expectInvariants(w);
  });

  test("F1: a crash right after the base write (offload.diverged.based) leaves the journal at diverged; recover keeps the row", async () => {
    const w = await world();
    w.a.engine.hooks.duringSnapshot = async () => {
      w.a.engine.hooks.duringSnapshot = undefined;
      value(await w.b.offload());
    };
    await expect(w.a.offload("web", { at: "offload.diverged.based" })).rejects.toThrow();
    expect(journalsOf(w.a).map((j) => j.step)).toEqual(["offload.diverged"]);
    const [op] = reportOf(await w.a.recover()).operations;
    expect([op?.outcome, op?.state]).toEqual(["forked", "conflicted"]);
    expect(await rowOf(w.a)).toEqual({ folder: true, stub: null, base: op?.snapshot, journals: [] });
    await expectInvariants(w);
  });

  test("F2: a registry write that fails keeps the journal at release.trash with the folder in place; recover writes the base", async () => {
    const w = await world();
    const fork = forkOf(w);
    let restore = () => {};
    const byA = await w.a.offload("web", {
      onStep: (step) => {
        if (step === "offload.committed") landNow(w, fork);
        if (step === "offload.release.trash") restore = breakRegistry(w.a);
      },
    });
    expect(byA.ok ? "released" : byA.finding.code).toBe("registry.invalid");
    restore();
    expect(await rowOf(w.a)).toMatchObject({ folder: true, stub: null, journals: ["offload.release.trash"] });
    const [op] = reportOf(await w.a.recover()).operations;
    expect([op?.outcome, op?.state, op?.conflict?.detail]).toEqual(["forked", "conflicted", "after-commit"]);
    expect(await rowOf(w.a)).toEqual({ folder: true, stub: null, base: op?.snapshot, journals: [] });
    await expectInvariants(w);
  });
});

describe("forks F2: recover labels a fork by the verdict release acted on (review r1 #10)", () => {
  test("a fork found by the sibling rule (its own event not listed yet) is reported conflicted, not local", async () => {
    const w = await world();
    await expect(w.a.offload("web", { at: "offload.committed" })).rejects.toThrow();
    const own = (await allEvents(w.store)).find(
      (e) => e.type === "offloaded" && e.device === w.a.device.id && e.base === w.base,
    );
    if (own === undefined) throw new Error("dev-a's event is not on the store");
    // A store whose listings lag: dev-a's own event is not listed yet (a get still reads it), a sibling made from the
    // same base is.
    const key = storeEventKey(own.id);
    const list = w.store.list;
    w.store.list = async (prefix) => {
      const listed = await list(prefix);
      return listed.ok ? { ...listed, value: listed.value.filter((e) => e.key !== key) } : listed;
    };
    for (const k of [...w.a.mirror.data.keys()]) if (k.includes(own.id)) w.a.mirror.data.delete(k);
    value(await appendEvent(storeEventLog(w.store), forkOf(w)));
    const [op] = reportOf(await w.a.recover()).operations;
    expect([op?.outcome, op?.state]).toEqual(["forked", "conflicted"]);
    expect(await rowOf(w.a)).toEqual({ folder: true, stub: null, base: op?.snapshot, journals: [] });
    w.store.list = list;
    await expectInvariants(w);
  });
});

describe("forks F2: a resolution elsewhere while this device's journal is pending", () => {
  test("rejected by another device's resolution, seen by recover: the folder stays on its own snapshot, the view says rejected-line, and the next offload conflicts again", async () => {
    const w = await world();
    // dev-b starts its upload; meanwhile dev-a commits, and the store goes down before dev-a's re-read.
    w.b.engine.hooks.duringSnapshot = async () => {
      w.b.engine.hooks.duringSnapshot = undefined;
      const byA = await w.a.offload("web", {
        onStep: (step) => {
          if (step === "offload.committed") w.store.setDown(true);
        },
      });
      expect(byA.ok ? "released" : [byA.exitCode, byA.finding.code]).toEqual([9, "store.unreachable"]);
      expect(journalsOf(w.a).map((j) => j.step)).toEqual(["offload.release.trash"]);
      w.store.setDown(false);
    };
    // dev-b forks at its commit (F1), then resolves keeping its own snapshot (resolve --keep, stubbed until Task 25).
    const byB = await w.b.offload();
    expect(byB.ok ? "released" : [byB.exitCode, byB.finding.code]).toEqual([8, "catalog.head-moved"]);
    const bSnap = (byB.ok ? undefined : (byB.data as OffloadConflict))?.snapshot as string;
    expect((await w.b.entry())?.base).toBe(bSnap);
    const project = await foldOf(w);
    const resolution = resolutionFor(project as NonNullable<typeof project>, bSnap);
    if (!resolution.ok) throw new Error(resolution.reason);
    const resolved = ulid();
    value(
      await appendEvent(storeEventLog(w.store), {
        v: 1,
        id: resolved,
        op: resolved,
        type: "resolved",
        device: w.b.device.id,
        at: new Date().toISOString(),
        project: w.project,
        root: w.root,
        path: "web",
        ...resolution.value,
      }),
    );
    const aOp = (await foldOf(w))?.rejected[0] as string;
    expect(aOp).toBeDefined();

    // dev-a's recover, with the store back: F2, its snapshot rejected.
    const [op] = reportOf(await w.a.recover()).operations;
    expect([op?.snapshot, op?.outcome, op?.state]).toEqual([aOp, "forked", "local"]);
    expect(await rowOf(w.a)).toEqual({ folder: true, stub: null, base: aOp, journals: [] });
    const views = value(
      await projectViews({
        io: testHost(),
        paths: w.a.box.paths,
        env: { HOME: w.a.box.home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
        device: w.a.device,
        loader: new ConfigLoader(testHost(), w.a.box.paths),
        opener: { open: async () => ({ ok: true, value: { blob: w.store, engine: w.a.engine } }) },
        openMirror: async () => ({ ok: true, value: w.a.mirror }),
      }),
    );
    const view = views.projects.find((p) => p.address === "work:web");
    expect(view?.conditions).toContain("rejected-line");
    expect(view?.next?.command).toBe("plainport offload work:web --yes");
    await expectInvariants(w);

    // Its next offload is live work on the rejected line: uploaded, and a fork at the commit (F1) that conflicts again.
    writeFileSync(join(w.a.dir(), "src/a2.ts"), "export const a2 = 2;\n");
    const again = await w.a.offload();
    expect(
      again.ok ? "released" : [again.exitCode, again.finding.code, (again.data as OffloadConflict).kind],
    ).toEqual([8, "catalog.head-moved", "fork"]);
    const next = (again.ok ? undefined : (again.data as OffloadConflict))?.snapshot as string;
    const after = await foldOf(w);
    expect(after?.status).toBe("conflicted");
    expect(after?.heads.sort()).toEqual([bSnap, next].sort());
    expect(await rowOf(w.a)).toEqual({ folder: true, stub: null, base: next, journals: [] });
    await expectInvariants(w);
  });
});

describe("forks F3: the fork is seen after the rename, which is never undone", () => {
  test("live: a fork after the rename; the release goes on, the stub is written", async () => {
    const w = await world();
    const fork = forkOf(w);
    const byA = value(
      await w.a.offload("web", {
        onStep: (step) => {
          if (step === "offload.release.renamed") landNow(w, fork);
        },
      }),
    );
    expect(await rowOf(w.a)).toEqual({
      folder: false,
      stub: byA.snapshot,
      base: byA.snapshot,
      journals: expect.any(Array),
    });
    expect((await foldOf(w))?.status).toBe("conflicted");
    await expectInvariants(w);
  });

  test("after recover: the release.moved write lost, the folder in the trash; recover decides from the world and goes on", async () => {
    const w = await world();
    await expect(w.a.offload("web", { at: "offload.release.renamed" })).rejects.toThrow();
    expect(journalsOf(w.a).map((j) => j.step)).toEqual(["offload.release.trash"]);
    expect(existsSync(w.a.dir())).toBe(false);
    const fork = forkOf(w);
    value(await appendEvent(storeEventLog(w.store), fork));
    const [op] = reportOf(await w.a.recover()).operations;
    expect([op?.outcome, op?.state]).toEqual(["finished", "shelved"]);
    expect(await rowOf(w.a)).toEqual({
      folder: false,
      stub: op?.snapshot ?? null,
      base: op?.snapshot,
      journals: expect.any(Array),
    });
    await expectInvariants(w);
  });

  test("after recover: the rename not done (release.trash on the journal, the folder in place): the re-read decides F2", async () => {
    const w = await world();
    await expect(w.a.offload("web", { at: "offload.release.trash" })).rejects.toThrow();
    expect(existsSync(w.a.dir())).toBe(true);
    value(await appendEvent(storeEventLog(w.store), forkOf(w)));
    const [op] = reportOf(await w.a.recover()).operations;
    expect(op?.outcome).toBe("forked");
    expect(await rowOf(w.a)).toEqual({ folder: true, stub: null, base: op?.snapshot, journals: [] });
    await expectInvariants(w);
  });
});

describe("forks: the full sequence on both devices", () => {
  test("fork → recover → compare → resolve --keep → edit → offload → onload on the other", async () => {
    const w = await world();
    // dev-a offloads and releases while dev-b uploads; dev-b's commit finds the fork and dies right after its event.
    w.b.engine.hooks.duringSnapshot = async () => {
      w.b.engine.hooks.duringSnapshot = undefined;
      value(await w.a.offload());
    };
    await expect(w.b.offload("web", { at: "offload.diverged.appended" })).rejects.toThrow();
    await settled(w.a);
    const [op] = reportOf(await w.b.recover()).operations;
    expect([op?.outcome, op?.state]).toEqual(["forked", "conflicted"]);
    const bSnap = op?.snapshot as string;
    expect(await rowOf(w.b)).toEqual({ folder: true, stub: null, base: bSnap, journals: [] });

    // compare (stubbed until Task 26): both sides of the fork are in the store, readable side by side.
    const project = (await foldOf(w)) as NonNullable<Awaited<ReturnType<typeof foldOf>>>;
    expect(project.status).toBe("conflicted");
    const aSnap = project.conflicts.flat().find((s) => s !== bSnap) as string;
    for (const s of [aSnap, bSnap]) expect(project.snapshots[s]).toBeDefined();

    // resolve --keep (stubbed until Task 25): dev-b keeps its working copy's recorded snapshot, its registry base.
    expect((await w.b.entry())?.base).toBe(bSnap);
    const resolution = resolutionFor(project, bSnap);
    if (!resolution.ok) throw new Error(resolution.reason);
    const id = ulid();
    value(
      await appendEvent(storeEventLog(w.store), {
        v: 1,
        id,
        op: id,
        type: "resolved",
        device: w.b.device.id,
        at: new Date().toISOString(),
        project: w.project,
        root: w.root,
        path: "web",
        ...resolution.value,
      }),
    );
    expect((await foldOf(w))?.head).toBe(bSnap);

    // dev-b edits and offloads on top of its kept snapshot: released.
    writeFileSync(join(w.b.dir(), "src/b2.ts"), "export const b2 = 2;\n");
    const byB = value(await w.b.offload());
    expect((await foldOf(w))?.head).toBe(byB.snapshot);
    await settled(w.b);
    expect(await rowOf(w.b)).toEqual({ folder: false, stub: byB.snapshot, base: byB.snapshot, journals: [] });

    // dev-a onloads dev-b's head: its edits and dev-b's later one.
    value(await w.a.onload());
    expect(readFileSync(join(w.a.dir(), "src/b.ts"), "utf8")).toBe("export const b = 1;\n");
    expect(readFileSync(join(w.a.dir(), "src/b2.ts"), "utf8")).toBe("export const b2 = 2;\n");
    expect(existsSync(join(w.a.dir(), "src/a.ts"))).toBe(false);
    expect(await rowOf(w.a)).toMatchObject({ folder: true, stub: null, base: byB.snapshot });
    // dev-a's released snapshot stays in the store, rejected; dev-b's fork event came after dev-a's release.
    expect((await foldOf(w))?.rejected).toEqual([aSnap]);
    await expectInvariants(w);
  });
});
