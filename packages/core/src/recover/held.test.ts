// The held-trash state machine (M2 Task 24; DESIGN.md "Offload process" → "Held trash", Q16, Q21): two devices in
// process on one fake store, with a conflict grace, each row of the table asserted device by device (folder, trash,
// stub, journal) on a stepped clock, through every delete entrance (recover, gc, gc --now, housekeeping, the detached
// delete) and with crashes at the checked read and at each transition.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, finding, type Result } from "@plainport/contract";
import { allEvents, type FakeDevice, fakeDevices } from "../../../../test/support/fake-devices.ts";
import { storeEventKey } from "../catalog/codec.ts";
import { foldCatalog, resolutionFor } from "../catalog/fold.ts";
import { appendEvent, storeEventLog } from "../catalog/log.ts";
import { ConfigLoader } from "../config/load.ts";
import { InjectedFault } from "../ports/host.ts";
import { projectViews } from "../status/projects.ts";
import { testHost } from "../testing/host.ts";
import { catalogInvariantViolations, invariantViolations } from "../testing/invariants.ts";
import { MEMORY_SEMANTICS } from "../testing/memory-blob-store.ts";
import { type SemanticBlobStore, semanticBlobStore } from "../testing/semantic-blob-store.ts";
import { ulid } from "../ulid.ts";
import type { RecoveryReport } from "./recover.ts";
import type { GcReport } from "./trash.ts";

const GRACE_MS = 15 * 60_000;
const GRACE = '[offload]\nconflictGrace = "15m"';

let devices: FakeDevice[] = [];
afterEach(async () => {
  for (const d of devices) await d.box.cleanupSettled();
  devices = [];
});

/** A store that can be taken down, and whose profile a test can replace. */
const controllable = (fake: SemanticBlobStore) => {
  let down = false;
  let profile: ReturnType<SemanticBlobStore["semantics"]> | undefined;
  const gone = () => Promise.resolve(fail(finding("store.unreachable", { message: "the store is down" })));
  const store: SemanticBlobStore & {
    setDown(on: boolean): void;
    setProfile(p: ReturnType<SemanticBlobStore["semantics"]>): void;
  } = {
    ...fake,
    semantics: () => profile ?? fake.semantics(),
    get: (key) => (down ? gone() : fake.get(key)),
    list: (prefix) => (down ? gone() : fake.list(prefix)),
    stat: (key) => (down ? gone() : fake.stat(key)),
    put: (key, data, opts) => (down ? gone() : fake.put(key, data, opts)),
    setDown: (on) => {
      down = on;
    },
    setProfile: (p) => {
      profile = p;
    },
  };
  return store;
};

/** Both devices with a conflict grace, onloaded from one head, each with an edit of its own. */
const world = async () => {
  const store = controllable(semanticBlobStore());
  devices = await fakeDevices(store, ["dev-a", "dev-b"]);
  const [a, b] = devices as [FakeDevice, FakeDevice];
  a.box.file("work/web/package.json", `${JSON.stringify({ name: "web" })}\n`);
  a.box.file("work/web/src/main.ts", "export const main = 0;\n");
  // The first offload, with no grace: released at once.
  value(await a.offload());
  await settled(a);
  value(await b.onload());
  value(await a.onload());
  for (const d of [a, b]) d.configure(GRACE);
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
    before: { events: await allEvents(store), snapshots: snapshotsOf(a) },
  };
};
type World = Awaited<ReturnType<typeof world>>;

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};
const reportOf = <T>(result: Result<T>): T => {
  if (result.ok) return result.value;
  if (result.data === undefined) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.data as T;
};
const snapshotsOf = (d: FakeDevice) => d.engine.repository.snapshots.map((s) => s.info.id);
const journalsOf = (d: FakeDevice) =>
  existsSync(d.box.paths.journalDir)
    ? readdirSync(d.box.paths.journalDir)
        .filter((f) => f.endsWith(".json"))
        .map(
          (f) =>
            JSON.parse(readFileSync(join(d.box.paths.journalDir, f), "utf8")) as {
              op: string;
              step: string;
              keepUntil?: string;
            },
        )
    : [];
const settled = async (d: FakeDevice) => {
  const busy = () =>
    existsSync(join(d.box.home, "work/.plainport-trash")) ||
    journalsOf(d).some((j) => j.step === "offload.release.delete");
  for (let i = 0; i < 400 && busy(); i++) await Bun.sleep(25);
};
/** Sets a device's offload.conflictGrace to 0. */
const noGrace = (d: FakeDevice) => {
  const file = join(d.box.home, ".config/plainport/config.toml");
  writeFileSync(file, readFileSync(file, "utf8").replace('conflictGrace = "15m"', 'conflictGrace = "0"'));
};
/** A clock `ms` from now. */
const after = (ms: number) => {
  const at = Date.now() + ms;
  return () => new Date(at);
};
const trashOf = (d: FakeDevice, op: string) => join(d.box.home, "work/.plainport-trash", op, "web");
/** A device's row: its folder, its trash, its stub, its open journals and their deadline. */
const rowOf = (d: FakeDevice, op: string) => ({
  folder: existsSync(d.dir()),
  trash: existsSync(trashOf(d, op)),
  stub: existsSync(`${d.dir()}.plainport`),
  journals: journalsOf(d).map((j) => [j.step, j.keepUntil === undefined ? "none" : "deadline"]),
});
/** dev-a's view of the project, as status shows it. */
const viewOf = async (w: World) =>
  value(
    await projectViews({
      io: testHost(),
      paths: w.a.box.paths,
      env: { HOME: w.a.box.home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
      device: w.a.device,
      loader: new ConfigLoader(testHost(), w.a.box.paths),
      opener: { open: async () => ({ ok: true, value: { blob: w.store, engine: w.a.engine } }) },
      openMirror: async () => ({ ok: true, value: w.a.mirror }),
    }),
  ).projects.find((p) => p.address === "work:web");
const foldOf = async (w: World) => foldCatalog(await allEvents(w.store)).projects[w.project];

/** dev-a offloads into a held trash; its snapshot. */
const heldOffload = async (w: World): Promise<string> => {
  const done = value(await w.a.offload());
  expect([done.localCopy, done.held, done.freedBy]).toEqual(["kept", true, "plainport gc"]);
  // The deadline is the commit plus the grace.
  const committed = (await allEvents(w.store)).find(
    (e) => e.type === "offloaded" && e.snapshot === done.snapshot,
  );
  expect(Date.parse(done.keepUntil as string) - Date.parse(committed?.at as string)).toBeGreaterThanOrEqual(
    GRACE_MS - 1_000,
  );
  expect(Date.parse(done.keepUntil as string) - Date.parse(committed?.at as string)).toBeLessThanOrEqual(
    GRACE_MS + 1_000,
  );
  expect(rowOf(w.a, done.snapshot)).toEqual({
    folder: false,
    trash: true,
    stub: true,
    journals: [["offload.release.held", "deadline"]],
  });
  return done.snapshot;
};

/**
 * dev-b uploads from the same base while dev-a offloads into a held trash (its re-read sees no fork yet): dev-b's commit
 * then sees dev-a's event, a fork (F1), its folder kept. Both snapshots, dev-a's first.
 */
const heldThenForked = async (w: World, aOffload: () => Promise<string> = () => heldOffload(w)) => {
  let op = "";
  w.b.engine.hooks.duringSnapshot = async () => {
    w.b.engine.hooks.duringSnapshot = undefined;
    op = await aOffload();
  };
  const bSnap = await forkByB(w);
  return [op, bSnap] as const;
};

/** dev-b's offload, which forks at its commit (F1): its snapshot. */
const forkByB = async (w: World): Promise<string> => {
  const byB = await w.b.offload();
  expect(byB.ok ? "released" : byB.finding.code).toBe("catalog.head-moved");
  return (byB.ok ? "" : (byB.data as { snapshot: string }).snapshot) as string;
};

/** A resolution that keeps `keep`, written by dev-b (resolve --keep, stubbed until Task 25). */
const resolve = async (w: World, keep: string): Promise<string> => {
  const project = (await foldOf(w)) as NonNullable<Awaited<ReturnType<typeof foldOf>>>;
  const resolution = resolutionFor(project, keep);
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
  return id;
};

const expectInvariants = async (w: World, now: Date, unseen: Record<string, string[]> = {}) => {
  for (const d of [w.a, w.b]) {
    expect({
      device: d.name,
      problems: await invariantViolations({
        now,
        paths: d.box.paths,
        device: d.device.id,
        project: { id: w.project, dir: d.dir() },
        roots: [join(d.box.home, "work")],
        store: { name: "ssd", blob: w.store, engine: d.engine, conflictGraceMs: GRACE_MS },
        ...(d.released === undefined ? {} : { released: d.released }),
        stripped: ["node_modules"],
        ...(unseen[d.name] === undefined ? {} : { unseen: unseen[d.name] as string[] }),
        settleMs: 0,
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

describe("held(grace): before the deadline every entrance keeps the trash", () => {
  test("recover, gc, gc --now and housekeeping keep it; the detached delete refuses it", async () => {
    const w = await world();
    const op = await heldOffload(w);
    const soon = after(GRACE_MS - 60_000);
    const recovered = reportOf<RecoveryReport>(await w.a.recover(undefined, soon));
    expect(recovered.operations.map((o) => [o.step, o.outcome])).toEqual([
      ["offload.release.held", "trash-kept"],
    ]);
    for (const early of [false, true]) {
      const gc = reportOf<GcReport>(await w.a.gc({ early, now: soon }));
      expect([gc.deleted.length, gc.kept.map((k) => k.op)]).toEqual([0, [op]]);
    }
    const kept = await w.a.housekeeping({ now: soon });
    expect(kept.started).toEqual([]);
    expect(rowOf(w.a, op)).toEqual({
      folder: false,
      trash: true,
      stub: true,
      journals: [["offload.release.held", "deadline"]],
    });
  });

  test("the deadline is honoured under a stepped clock: kept a minute before it, deleted a minute after", async () => {
    const w = await world();
    const op = await heldOffload(w);
    const journal = journalsOf(w.a)[0];
    const deadline = Date.parse(journal?.keepUntil as string);
    const before = () => new Date(deadline - 60_000);
    expect(reportOf<GcReport>(await w.a.gc({ now: before })).deleted).toEqual([]);
    expect(rowOf(w.a, op).trash).toBe(true);
    const past = () => new Date(deadline + 60_000);
    expect(reportOf<GcReport>(await w.a.gc({ now: past })).deleted.map((d) => d.op)).toEqual([op]);
    expect(rowOf(w.a, op)).toEqual({ folder: false, trash: false, stub: true, journals: [] });
    await expectInvariants(w, past());
  });
});

describe("held(grace) → release.delete: the checked read finds no fork and Q21's proof holds", () => {
  for (const entrance of ["gc", "recover", "housekeeping"] as const)
    test(`by ${entrance}`, async () => {
      const w = await world();
      const op = await heldOffload(w);
      const now = after(GRACE_MS + 60_000);
      if (entrance === "gc")
        expect(reportOf<GcReport>(await w.a.gc({ now })).deleted.map((d) => d.op)).toEqual([op]);
      else if (entrance === "recover")
        expect(
          reportOf<RecoveryReport>(await w.a.recover(undefined, now)).operations.map((o) => o.outcome),
        ).toEqual(["trash-deleted"]);
      else {
        expect((await w.a.housekeeping({ now })).started.map((s) => s.op)).toEqual([op]);
        await settled(w.a);
      }
      expect(rowOf(w.a, op)).toEqual({ folder: false, trash: false, stub: true, journals: [] });
      await expectInvariants(w, now());
    });

  test("with keepLocalFor, the trash leaves the hold for keepLocalFor's deadline, and onload can still rename it back", async () => {
    const w = await world();
    w.a.configure('keepLocalFor = "1h"');
    const op = await heldOffload(w);
    const gc = reportOf<GcReport>(await w.a.gc({ now: after(GRACE_MS + 60_000) }));
    expect([gc.deleted, gc.kept.map((k) => k.op)]).toEqual([[], [op]]);
    expect(rowOf(w.a, op).journals).toEqual([["offload.release.delete", "deadline"]]);
    expect(reportOf<GcReport>(await w.a.gc({ now: after(2 * 3_600_000) })).deleted.map((d) => d.op)).toEqual([
      op,
    ]);
  });

  test("a read command's housekeeping only names a held trash past its grace; it reads nothing and deletes nothing", async () => {
    const w = await world();
    const op = await heldOffload(w);
    const kept = await w.a.housekeeping({ deleteDue: false, now: after(GRACE_MS + 60_000) });
    expect(kept.started).toEqual([]);
    expect(
      kept.notices.some((n) => n.includes("past its conflict grace") && n.includes("plainport gc")),
    ).toBe(true);
    expect(rowOf(w.a, op).journals).toEqual([["offload.release.held", "deadline"]]);
  });
});

describe("held(grace) → held(conflict): the checked read finds a fork naming the snapshot", () => {
  test("B's append within the grace keeps A's trash, conflict-retained, through every entrance", async () => {
    const w = await world();
    const [op, bSnap] = await heldThenForked(w);
    const now = after(GRACE_MS + 60_000);
    const gc = reportOf<GcReport>(await w.a.gc({ now }));
    expect(gc.deleted).toEqual([]);
    expect(gc.kept[0]?.reason).toContain("a fork names its snapshot");
    // held(conflict): the deadline is gone.
    expect(rowOf(w.a, op)).toEqual({
      folder: false,
      trash: true,
      stub: true,
      journals: [["offload.release.held", "none"]],
    });
    for (const early of [false, true])
      expect(reportOf<GcReport>(await w.a.gc({ early, now: after(10 * GRACE_MS) })).deleted).toEqual([]);
    const recovered = reportOf<RecoveryReport>(await w.a.recover(undefined, after(10 * GRACE_MS)));
    expect(recovered.operations.map((o) => [o.outcome, o.state, o.finding?.code])).toEqual([
      ["trash-kept", "conflicted", "trash.conflict-retained"],
    ]);
    const kept = await w.a.housekeeping({ now: after(10 * GRACE_MS) });
    expect(kept.started).toEqual([]);
    expect(kept.notices.some((n) => n.includes("a fork names its snapshot"))).toBe(true);
    expect(rowOf(w.a, op).trash).toBe(true);
    // The view shows it.
    const views = await viewOf(w);
    expect(views?.trash.map((t) => [t.op, t.held, t.due])).toEqual([[op, "conflict-retained", false]]);
    expect(bSnap).not.toBe(op);
    await expectInvariants(w, new Date(), { "dev-a": [] });
  });

  test("a view shows conflict-retained as soon as its catalog names the fork, before any checked read", async () => {
    const w = await world();
    const [op] = await heldThenForked(w);
    const views = await viewOf(w);
    expect(views?.trash.map((t) => [t.op, t.held])).toEqual([[op, "conflict-retained"]]);
  });
});

describe("held(conflict) → held(grace) → …: a resolution settles the fork", () => {
  test("resolve --keep of the retained snapshot, allowed with the held journal open: a fresh deadline, and onload renames the trash back", async () => {
    const w = await world();
    const [op] = await heldThenForked(w);
    reportOf<GcReport>(await w.a.gc({ now: after(GRACE_MS + 60_000) }));
    expect(rowOf(w.a, op).journals).toEqual([["offload.release.held", "none"]]);
    await resolve(w, op);
    expect((await foldOf(w))?.head).toBe(op);
    const at = Date.now() + 2 * GRACE_MS;
    const gc = reportOf<GcReport>(await w.a.gc({ now: () => new Date(at) }));
    expect(gc.deleted).toEqual([]);
    const fresh = journalsOf(w.a)[0]?.keepUntil as string;
    expect(Date.parse(fresh)).toBe(at + GRACE_MS);
    // While it waits, onload of that head reuses the trash and closes the journal (M1's rename-back).
    const back = value(await w.a.onload());
    expect(back.restored).toBe("reuse");
    expect(readFileSync(join(w.a.dir(), "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(rowOf(w.a, op)).toEqual({ folder: true, trash: false, stub: false, journals: [] });
  });

  test("a resolution that rejects the snapshot: a fresh grace, then deleted; the snapshot stays in the store, restorable", async () => {
    const w = await world();
    const [op, bSnap] = await heldThenForked(w);
    reportOf<GcReport>(await w.a.gc({ now: after(GRACE_MS + 60_000) }));
    await resolve(w, bSnap);
    expect((await foldOf(w))?.rejected).toEqual([op]);
    const at = Date.now() + 2 * GRACE_MS;
    expect(reportOf<GcReport>(await w.a.gc({ now: () => new Date(at) })).deleted).toEqual([]);
    expect(rowOf(w.a, op).journals).toEqual([["offload.release.held", "deadline"]]);
    const later = () => new Date(at + GRACE_MS + 60_000);
    expect(reportOf<GcReport>(await w.a.gc({ now: later })).deleted.map((d) => d.op)).toEqual([op]);
    expect(rowOf(w.a, op)).toEqual({ folder: false, trash: false, stub: true, journals: [] });
    // restore --snapshot reads the rejected snapshot: it is in the repository, and restores whole.
    const made = (await foldOf(w))?.snapshots[op];
    const stored = Object.values(made?.stored ?? {})[0] as string;
    const target = join(w.a.box.home, "copy");
    value(await w.a.engine.restore(stored, target, { op: ulid() }));
    expect(readFileSync(join(target, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    await expectInvariants(w, later());
  });
});

describe("any held: unchanged while the store does not answer or Q21's proof finds data missing", () => {
  test("the store unreachable: gc skips it with the finding, recover leaves it pending; both retry later", async () => {
    const w = await world();
    const op = await heldOffload(w);
    w.store.setDown(true);
    const now = after(GRACE_MS + 60_000);
    const gc = await w.a.gc({ now });
    expect(gc.ok ? "" : gc.finding.code).toBe("store.unreachable");
    expect(reportOf<GcReport>(gc).skipped.map((s) => s.op)).toEqual([op]);
    const recovered = reportOf<RecoveryReport>(await w.a.recover(undefined, now));
    expect(recovered.operations.map((o) => o.outcome)).toEqual(["pending"]);
    expect(rowOf(w.a, op).journals).toEqual([["offload.release.held", "deadline"]]);
    w.store.setDown(false);
    expect(reportOf<GcReport>(await w.a.gc({ now })).deleted.map((d) => d.op)).toEqual([op]);
  });

  test("the commit's event gone from the store: store.lost-write, the trash kept; recover then puts it back, as the fix says, and it offloads again (D115)", async () => {
    const w = await world();
    const base = (await w.a.entry())?.base;
    const op = await heldOffload(w);
    const event = (await allEvents(w.store)).find((e) => e.type === "offloaded" && e.snapshot === op);
    w.store.data.delete(storeEventKey(event?.id as string));
    const now = after(GRACE_MS + 60_000);
    const gc = await w.a.gc({ now });
    expect(gc.ok ? "" : gc.finding.code).toBe("store.lost-write");
    expect(rowOf(w.a, op).trash).toBe(true);
    // The fix, as printed: recover puts the folder back, then offload it again.
    expect(gc.ok ? "" : gc.finding.fix).toContain(`plainport recover puts the folder back at ${w.a.dir()}`);
    const recovered = reportOf<RecoveryReport>(await w.a.recover(undefined, now));
    expect(recovered.operations.map((o) => [o.outcome, o.state, o.finding?.code])).toEqual([
      ["rolled-back", "local", "store.lost-write"],
    ]);
    expect(recovered.operations[0]?.finding?.fix).toBe("offload it again: plainport offload work:web --yes");
    expect(rowOf(w.a, op)).toEqual({ folder: true, trash: false, stub: false, journals: [] });
    expect(existsSync(join(w.a.box.home, "work/.plainport-trash"))).toBe(false);
    expect(readFileSync(join(w.a.dir(), "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect((await w.a.entry())?.base).toBe(base);
    const again = value(await w.a.offload());
    expect(again.held).toBe(true);
    expect((await foldOf(w))?.head).toBe(again.snapshot);
  });

  test("recover <project> --restore-held puts a held trash back with the store gone for good (D115)", async () => {
    const w = await world();
    const base = (await w.a.entry())?.base;
    const op = await heldOffload(w);
    w.store.setDown(true);
    const calls = { ...w.store.calls };
    const restored = reportOf<RecoveryReport>(
      await w.a.recover(undefined, undefined, { restoreHeld: w.project }),
    );
    expect(restored.operations.map((o) => [o.op, o.outcome, o.state])).toEqual([
      [op, "rolled-back", "local"],
    ]);
    expect(rowOf(w.a, op)).toEqual({ folder: true, trash: false, stub: false, journals: [] });
    expect((await w.a.entry())?.base).toBe(base);
    expect(w.store.calls).toEqual(calls);
  });

  test("--restore-held never writes over a folder that stands at the project's place (path.occupied)", async () => {
    const w = await world();
    const op = await heldOffload(w);
    w.a.box.file("work/web/other.txt", "not the project\n");
    const kept = await w.a.recover(undefined, undefined, { restoreHeld: w.project });
    expect(reportOf<RecoveryReport>(kept).operations.map((o) => [o.outcome, o.finding?.code])).toEqual([
      ["pending", "path.occupied"],
    ]);
    expect(rowOf(w.a, op)).toMatchObject({ trash: true, journals: [["offload.release.held", "deadline"]] });
  });

  test("the restic snapshot gone from the repository: store.lost-write, the trash kept", async () => {
    const w = await world();
    const op = await heldOffload(w);
    const repo = w.a.engine.repository;
    repo.snapshots = repo.snapshots.filter((s) => !s.info.tags.includes(`plainport:op=${op}`));
    const gc = await w.a.gc({ now: after(GRACE_MS + 60_000) });
    expect(gc.ok ? "" : gc.finding.code).toBe("store.lost-write");
    expect(rowOf(w.a, op).trash).toBe(true);
  });
});

describe("a store whose profile cannot release a folder (Task 17 M7's carry-over)", () => {
  test("durability unknown: the offload commits, keeps the trash and says why; gc keeps refusing until it is asserted", async () => {
    const w = await world();
    w.store.setProfile({ ...MEMORY_SEMANTICS, durability: "unknown" });
    const done = value(await w.a.offload());
    expect([done.localCopy, done.held, done.releaseRefused?.code]).toEqual([
      "kept",
      true,
      "store.semantics-unknown",
    ]);
    expect(done.releaseRefused?.message).toContain("durability is unknown");
    expect(done.releaseRefused?.fix).toContain('semantics.durability = "durable"');
    expect((await foldOf(w))?.head).toBe(done.snapshot);
    const gc = await w.a.gc({ now: after(GRACE_MS + 60_000) });
    expect(gc.ok ? "" : gc.finding.code).toBe("store.semantics-unknown");
    expect(rowOf(w.a, done.snapshot).trash).toBe(true);
    w.store.setProfile({ ...MEMORY_SEMANTICS, durability: { value: "durable", evidence: "asserted" } });
    expect(reportOf<GcReport>(await w.a.gc({ now: after(GRACE_MS + 60_000) })).deleted).toHaveLength(1);
  });

  test("acked-unsynced with no grace: held for the 15-minute floor, the raise reported, deleted after it once Q21's proof holds (D115)", async () => {
    const w = await world();
    noGrace(w.a);
    w.store.setProfile({
      ...MEMORY_SEMANTICS,
      durability: { value: "acked-unsynced", evidence: "measured" },
    });
    w.a.findings.length = 0;
    const done = value(await w.a.offload());
    expect([done.held, done.releaseRefused]).toEqual([true, undefined]);
    expect(w.a.findings.filter((f) => f.code === "offload.grace-raised").map((f) => f.severity)).toEqual([
      "warn",
    ]);
    const committed = (await allEvents(w.store)).find(
      (e) => e.type === "offloaded" && e.snapshot === done.snapshot,
    );
    expect(Date.parse(done.keepUntil as string) - Date.parse(committed?.at as string)).toBeGreaterThanOrEqual(
      GRACE_MS - 1_000,
    );
    // A second after the acknowledgement proves nothing against a store that may still lose it: kept.
    expect(reportOf<GcReport>(await w.a.gc({ now: after(1_000) })).deleted).toEqual([]);
    expect(rowOf(w.a, done.snapshot).trash).toBe(true);
    expect(
      reportOf<GcReport>(await w.a.gc({ now: after(GRACE_MS + 60_000) })).deleted.map((d) => d.op),
    ).toEqual([done.snapshot]);
  });
});

describe("two trashes of one project, one held and one released (review r2 M3)", () => {
  test("a rejected snapshot's trash stays held while the kept head is onloaded, edited and offloaded again", async () => {
    const w = await world();
    const [op, bSnap] = await heldThenForked(w);
    await resolve(w, bSnap);
    // dev-a onloads the kept head beside its held trash: restored from the store, the trash untouched.
    const back = value(await w.a.onload());
    expect(back.restored).toBe("restore");
    expect(rowOf(w.a, op)).toMatchObject({ folder: true, trash: true });
    writeFileSync(join(w.a.dir(), "src/a3.ts"), "export const a3 = 3;\n");
    noGrace(w.a);
    const again = value(await w.a.offload());
    expect(again.snapshot).not.toBe(op);
    // Its detached delete runs; the held trash keeps the holder, so wait on the second journal only.
    for (let i = 0; i < 400 && journalsOf(w.a).some((j) => j.op === again.snapshot); i++) await Bun.sleep(25);
    // The second offload's trash is released; the first one is still held, its folder as it was.
    expect(rowOf(w.a, op).trash).toBe(true);
    expect(rowOf(w.a, again.snapshot).trash).toBe(false);
    expect(journalsOf(w.a).map((j) => [j.op, j.step])).toEqual([[op, "offload.release.held"]]);
    expect(readFileSync(join(trashOf(w.a, op), "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    // Past the grace the rejected snapshot's trash goes; the snapshot stays in the store.
    const gc = reportOf<GcReport>(await w.a.gc({ now: after(GRACE_MS + 60_000) }));
    expect(gc.deleted.map((d) => d.op)).toEqual([op]);
    expect(snapshotsOf(w.a)).toHaveLength(4);
    expect(Object.keys((await foldOf(w))?.snapshots ?? {})).toEqual(
      expect.arrayContaining([op, again.snapshot]),
    );
  });
});

describe("housekeeping stays local for a held trash whose last checked read failed (review r2 M1)", () => {
  test("the store away: after gc's failed read, a write command's housekeeping names it and reaches nothing", async () => {
    const w = await world();
    const op = await heldOffload(w);
    const now = after(GRACE_MS + 60_000);
    w.store.setDown(true);
    const gc = await w.a.gc({ now });
    expect(gc.ok ? "" : gc.finding.code).toBe("store.unreachable");
    w.store.setDown(false);
    const calls = { ...w.store.calls };
    const kept = await w.a.housekeeping({ now });
    expect(kept.started).toEqual([]);
    expect(kept.notices.some((n) => n.includes(`held trash`) && n.includes("store is down"))).toBe(true);
    expect(w.store.calls).toEqual(calls);
    expect(rowOf(w.a, op).trash).toBe(true);
    // gc reads again, finds the store back, and deletes it; the note goes with the trash.
    expect(reportOf<GcReport>(await w.a.gc({ now })).deleted.map((d) => d.op)).toEqual([op]);
    expect(existsSync(join(w.a.box.home, "work/.plainport-trash"))).toBe(false);
  });

  test("a profile that cannot release refuses before the catalog is read or Q21's proof is taken", async () => {
    const w = await world();
    w.store.setProfile({ ...MEMORY_SEMANTICS, durability: "unknown" });
    const done = value(await w.a.offload());
    const lists = w.store.calls.list;
    const gc = await w.a.gc({ now: after(GRACE_MS + 60_000) });
    expect(gc.ok ? "" : gc.finding.code).toBe("store.semantics-unknown");
    expect(w.store.calls.list).toBe(lists);
    expect(rowOf(w.a, done.snapshot).trash).toBe(true);
  });
});

describe("a crash past the rename: recover's release reads the profile and holds as the live run does (review r2 I1)", () => {
  for (const durability of ["acked-unsynced", "unknown"] as const)
    test(`killed at offload.release.moved with grace 0 on a ${durability} store: recover holds the trash, never deletes it`, async () => {
      const w = await world();
      noGrace(w.a);
      w.store.setProfile({
        ...MEMORY_SEMANTICS,
        durability: durability === "unknown" ? "unknown" : { value: durability, evidence: "measured" },
      });
      await expect(w.a.offload("web", { at: "offload.release.moved" })).rejects.toBeInstanceOf(InjectedFault);
      const op = journalsOf(w.a)[0]?.op as string;
      const recovered = reportOf<RecoveryReport>(await w.a.recover());
      expect(recovered.operations.map((o) => o.outcome)).toEqual(["finished"]);
      expect(rowOf(w.a, op)).toEqual({
        folder: false,
        trash: true,
        stub: true,
        journals: [["offload.release.held", "deadline"]],
      });
      // And the next gc a second later keeps it too.
      await w.a.gc({ now: after(1_000) });
      expect(rowOf(w.a, op).trash).toBe(true);
    });
});

describe("crashes at the checked read and at each transition", () => {
  test("killed at trash.delete.checked (the read allowed it, nothing moved): recover reads again and deletes", async () => {
    const w = await world();
    const op = await heldOffload(w);
    const now = after(GRACE_MS + 60_000);
    await expect(w.a.recover({ at: "trash.delete.checked" }, now)).rejects.toBeInstanceOf(InjectedFault);
    expect(rowOf(w.a, op).journals).toEqual([["offload.release.held", "deadline"]]);
    expect(
      reportOf<RecoveryReport>(await w.a.recover(undefined, now)).operations.map((o) => o.outcome),
    ).toEqual(["trash-deleted"]);
    expect(rowOf(w.a, op).trash).toBe(false);
  });

  test("killed right after the move to release.delete: the next recover deletes it as any released trash", async () => {
    const w = await world();
    const op = await heldOffload(w);
    const now = after(GRACE_MS + 60_000);
    await expect(w.a.recover({ at: "offload.release.delete" }, now)).rejects.toBeInstanceOf(InjectedFault);
    expect(rowOf(w.a, op).journals).toEqual([["offload.release.delete", "none"]]);
    expect(
      reportOf<RecoveryReport>(await w.a.recover(undefined, now)).operations.map((o) => o.outcome),
    ).toEqual(["trash-deleted"]);
  });

  test("killed right after held(grace) → held(conflict): the trash stays, and the next read keeps it", async () => {
    const w = await world();
    const [op] = await heldThenForked(w);
    const now = after(GRACE_MS + 60_000);
    await expect(w.a.recover({ at: "offload.release.held" }, now)).rejects.toBeInstanceOf(InjectedFault);
    expect(rowOf(w.a, op).journals).toEqual([["offload.release.held", "none"]]);
    expect(
      reportOf<RecoveryReport>(await w.a.recover(undefined, now)).operations.map((o) => o.outcome),
    ).toEqual(["trash-kept"]);
    expect(rowOf(w.a, op).trash).toBe(true);
  });

  test("crash after the rename on the same device, a competing append, recover (held(conflict)), resolve --keep, onload reuses the trash", async () => {
    const w = await world();
    // dev-a crashes right after its rename while dev-b uploads; dev-b's commit then appends a fork of the same base.
    const [op] = await heldThenForked(w, async () => {
      await expect(w.a.offload("web", { at: "offload.release.moved" })).rejects.toBeInstanceOf(InjectedFault);
      return journalsOf(w.a)[0]?.op as string;
    });
    expect(rowOf(w.a, op)).toMatchObject({ folder: false, trash: true });
    // recover finishes the release into the hold (F3: the rename is never undone), then reads it past the grace.
    const first = reportOf<RecoveryReport>(await w.a.recover());
    expect(first.operations.map((o) => o.outcome)).toEqual(["finished"]);
    const second = reportOf<RecoveryReport>(await w.a.recover(undefined, after(GRACE_MS + 60_000)));
    expect(second.operations.map((o) => [o.outcome, o.finding?.code])).toEqual([
      ["trash-kept", "trash.conflict-retained"],
    ]);
    expect(rowOf(w.a, op)).toEqual({
      folder: false,
      trash: true,
      stub: true,
      journals: [["offload.release.held", "none"]],
    });
    await resolve(w, op);
    const back = value(await w.a.onload());
    expect(back.restored).toBe("reuse");
    expect(rowOf(w.a, op)).toEqual({ folder: true, trash: false, stub: false, journals: [] });
    expect(readFileSync(join(w.a.dir(), "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
  });
});
