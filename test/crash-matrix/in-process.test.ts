// The crash matrix, in-process variant (T0; ADR-0017, DESIGN.md "Testing and fault injection"): for every row the
// matrix enumerates (matrix.ts), run the saga against a sandboxed home, an in-memory store and the fake engine, crash
// it with the host's faultAt seam (an InjectedFault) at the row's step or seam, run recover, and check the row
// (checks.ts): recover's outcome, invariants 1–6, no work lost, a second recover with nothing to do.
//
// An InjectedFault unwinds the saga's own process, so it cannot leave the project's lock held the way a dead process
// does (Task 12); the subprocess variant (subprocess.test.ts) crashes every row with a real SIGKILL for that.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fail, finding, ok, type Result } from "../../packages/contract/src/index.ts";
import type { CatalogPolicy } from "../../packages/core/src/catalog/codec.ts";
import { parseStoreIdentity } from "../../packages/core/src/catalog/identity.ts";
import { appendEvent, storeEventLog } from "../../packages/core/src/catalog/index.ts";
import { looksSealed } from "../../packages/core/src/catalog/seal.ts";
import { ConfigLoader } from "../../packages/core/src/config/load.ts";
import { type Device, ensureDevice } from "../../packages/core/src/device.ts";
import { type HostPorts, InjectedFault } from "../../packages/core/src/ports/host.ts";
import type { StoreOpener } from "../../packages/core/src/ports/store.ts";
import { type RecoverDeps, type RecoveryReport, recover } from "../../packages/core/src/recover/recover.ts";
import { readRegistry } from "../../packages/core/src/registry.ts";
import { resolveProject } from "../../packages/core/src/roots/address.ts";
import { type OffloadDeps, runOffload } from "../../packages/core/src/saga/offload.ts";
import { type OnloadDeps, runOnload } from "../../packages/core/src/saga/onload.ts";
import { setUpStore } from "../../packages/core/src/store.ts";
import { quietChecks } from "../../packages/core/src/testing/checks.ts";
import { type FakeEngine, fakeEngine } from "../../packages/core/src/testing/fake-engine.ts";
import { testHost } from "../../packages/core/src/testing/host.ts";
import { captureTree, type TreeCapture } from "../../packages/core/src/testing/invariants.ts";
import { type MemoryBlobStore, memoryBlobStore } from "../../packages/core/src/testing/memory-blob-store.ts";
import { makeSandbox, type Sandbox } from "../../packages/core/src/testing/sandbox.ts";
import { ulid } from "../../packages/core/src/ulid.ts";
import { nodePlugin } from "../../packages/eco-node/src/index.ts";
import {
  crashCopyProblems,
  crashedOperation,
  DAMAGE_MODE,
  damage,
  journalSteps,
  laterHeadProblems,
  rowProblems,
  settleJournals,
  snapshotIds,
  type World,
} from "./checks.ts";
import {
  copyProject,
  EXTRA_MODE,
  hashEntry,
  hashTree,
  makeProjectTemplate,
  type ProjectTemplate,
  type TreeHash,
} from "./fixture.ts";
import {
  ALL_ROWS,
  MATRIX_POINTS,
  type OFFLOAD_BRANCH_KINDS,
  OFFLOAD_ROWS,
  type ONLOAD_BRANCH_KINDS,
  ONLOAD_ROWS,
  plainRowAt,
  type Row,
  type Saga,
  type ScenarioOf,
} from "./matrix.ts";

const PATH = process.env.PATH ?? "/usr/bin:/bin";

let template: ProjectTemplate;
beforeAll(() => {
  template = makeProjectTemplate();
});
afterAll(() => template.cleanup());

let box: Sandbox;
let device: Device;
let store: MemoryBlobStore;
let mirror: MemoryBlobStore;
let engine: FakeEngine;
let dir: string;
let released: TreeCapture | undefined;
/** The project before the run, plus the scenario's own edits (noteEdit): what no crash may change. */
let reference: TreeHash;
const noteEdit = (path: string) => reference.set(path, hashEntry(dir, path));

/** At the start of release (live or resumed by recover), the folder as it stands: invariant 1's capture. */
const capture = (step: string) => {
  if (step === "offload.release.trash" && existsSync(dir)) released = captureTree(dir);
};

/** The store's catalog policy: plain, or sealed for the sealed rows (Task 11). */
let catalog: CatalogPolicy | undefined;
/** A sealed policy is bound to its store (review r1 I4): each row's store has its own id. */
const sealedFor = (store: MemoryBlobStore): CatalogPolicy => {
  const identity = parseStoreIdentity(store.data.get("meta/v1/store.json") as Uint8Array);
  if (identity === undefined) throw new Error("the row's store has no identity");
  return { seal: "sealed", storeId: identity.id, key: new Uint8Array(32).fill(5) };
};

/** While set, every store call fails with store.unreachable: a store down (the re-read rows). */
let storeDown = false;
const reachable = (blob: MemoryBlobStore): MemoryBlobStore => {
  const gone = () => Promise.resolve(fail(finding("store.unreachable", { message: "the store is down" })));
  return {
    ...blob,
    get: (key) => (storeDown ? gone() : blob.get(key)),
    list: (prefix) => (storeDown ? gone() : blob.list(prefix)),
    stat: (key) => (storeDown ? gone() : blob.stat(key)),
    put: (key, data, opts) => (storeDown ? gone() : blob.put(key, data, opts)),
  };
};

const opener: StoreOpener = {
  open: async () => ({
    ok: true,
    value: { blob: reachable(store), engine, ...(catalog === undefined ? {} : { catalog }) },
  }),
};

const config = (extra = "") =>
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
      extra,
    ].join("\n"),
  );

beforeEach(async () => {
  box = makeSandbox("plainport-crash-");
  config();
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
  dir = join(box.home, "work/web");
  copyProject(template, dir);
  released = undefined;
  heldDelete = undefined;
  catalog = undefined;
  storeDown = false;
  unseen = undefined;
  reference = hashTree(dir);
});

afterEach(async () => {
  try {
    chmodSync(join(dir, "src/extra.ts"), EXTRA_MODE);
  } catch {}
  // A failed row may leave a detached delete running in the sandbox: let it finish before the sandbox goes.
  await settleJournals(box.paths).catch(() => {});
  await box.cleanupSettled();
});

const env = () => ({ HOME: box.home, PATH, PLAINPORT_STORE_PASSWORD: "pw" });

const offloadDeps = (host: HostPorts): OffloadDeps => ({
  host,
  checks: quietChecks,
  plugins: [nodePlugin],
  paths: box.paths,
  device,
  env: env(),
  loader: new ConfigLoader(host, box.paths),
  opener,
  openMirror: async () => ({ ok: true, value: mirror }),
  emit: () => {},
  log: () => {},
});

const onloadDeps = (host: HostPorts): OnloadDeps => ({
  host,
  plugins: [nodePlugin],
  paths: box.paths,
  device,
  env: env(),
  loader: new ConfigLoader(host, box.paths),
  opener,
  openMirror: async () => ({ ok: true, value: mirror }),
  emit: () => {},
  log: () => {},
});

const recoverDeps = (): RecoverDeps => {
  const host = testHost({ faults: { onStep: capture } });
  return {
    host,
    paths: box.paths,
    device,
    env: env(),
    loader: new ConfigLoader(host, box.paths),
    opener,
    openMirror: async () => ({ ok: true, value: mirror }),
    log: () => {},
  };
};

const ref = async () => {
  const resolved = await resolveProject(testHost(), box.paths, "work:web", {
    cwd: box.home,
    env: { HOME: box.home },
    device: "mbp",
  });
  if (!resolved.ok) throw new Error(resolved.finding.message);
  return resolved.value;
};

const reportOf = (result: Result<RecoveryReport>): RecoveryReport => {
  if (result.ok) return result.value;
  if (result.data === undefined) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.data as RecoveryReport;
};

const projectId = async (): Promise<string | undefined> => {
  const registry = await readRegistry(testHost(), box.paths);
  if (!registry.ok) return undefined;
  return Object.entries(registry.value.projects).find(([, e]) => e.path === "web")?.[0];
};

/** The detached delete a crash at MATRIX_POINTS.raced started, held until the crash has been looked at. */
let heldDelete: (() => Promise<unknown>) | undefined;

const offload = async (faults: { at?: string; occurrence?: number } = {}) => {
  const real = testHost({ faults: { ...faults, onStep: capture } });
  // Past the detached delete's start the real delete races the test: on a fast disk it removes the journal before
  // the crash is read. So for that crash it is held, reported as started, and run once the crash has been read.
  const host: HostPorts =
    faults.at !== MATRIX_POINTS.raced
      ? real
      : {
          ...real,
          deleteTrashDetached: async (trash, journal, device, context) => {
            heldDelete = () => real.deleteTrashDetached(trash, journal, device, context);
            return ok({ pid: process.pid });
          },
        };
  return runOffload(offloadDeps(host), { project: await ref() });
};

const crashOffload = async (row: Row) =>
  expect(offload({ at: row.point, occurrence: row.occurrence })).rejects.toBeInstanceOf(InjectedFault);

const crashOnload = async (point: string) => {
  const host = testHost({ faults: { at: point } });
  await expect(runOnload(onloadDeps(host), { project: await ref(), hydrate: false })).rejects.toBeInstanceOf(
    InjectedFault,
  );
};

/** Offloads the project and waits for its detached delete, so an onload has a shelved project to restore. */
const shelve = async () => {
  const done = await offload();
  if (!done.ok) throw new Error(`${done.finding.code}: ${done.finding.message}`);
  await settleJournals(box.paths);
};

/** Registers the project and its root with a first offload that fails, so another copy's event can name them. */
const registerFirst = async () => {
  engine.hooks.failNext = {
    snapshot: fail(finding("internal.unexpected", { message: "the first try fails" })),
  };
  expect((await offload()).ok).toBe(false);
};

/** Another copy offloads the project while this upload runs: the head moves. */
const otherCopyDuringUpload = async () => {
  const id = (await projectId()) as string;
  const registry = await readRegistry(testHost(), box.paths);
  const rootId = registry.ok ? registry.value.roots?.work : undefined;
  engine.hooks.duringSnapshot = async () => {
    engine.hooks.duringSnapshot = undefined;
    const s = ulid();
    const appended = await appendEvent(storeEventLog(store, catalog), {
      v: 1,
      id: s,
      op: s,
      type: "offloaded",
      device: ulid(),
      at: "2026-10-03T00:00:00.000Z",
      project: id,
      root: rootId as string,
      path: "web",
      snapshot: s,
      stored: { ssd: "c".repeat(64) },
      stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
    });
    if (!appended.ok) throw new Error(appended.finding.message);
  };
};

type Scenario = (row: Row) => Promise<void>;

/** How each offload scenario crashes at a row; the project's own edits (a retry's) are part of what it must keep. */
const OFFLOAD_SCENARIOS: Record<ScenarioOf<typeof OFFLOAD_BRANCH_KINDS>, Scenario> = {
  plain: crashOffload,
  discarded: async (row) => {
    engine.hooks.duringSnapshot = () => chmodSync(join(dir, "src/extra.ts"), 0o000);
    try {
      await crashOffload(row);
    } finally {
      chmodSync(join(dir, "src/extra.ts"), EXTRA_MODE);
    }
  },
  diverged: async (row) => {
    await registerFirst();
    await otherCopyDuringUpload();
    await crashOffload(row);
  },
  retry: async (row) => {
    engine.hooks.duringSnapshot = (_input, attempt) => {
      if (attempt !== 1) return;
      writeFileSync(join(dir, "notes/todo.txt"), "edited during the upload\n");
      noteEdit("notes/todo.txt");
    };
    await crashOffload(row);
  },
  held: async (row) => {
    // A grace short enough that recover's checked read is taken after it, so the held trash settles (Q16).
    config('[offload]\nconflictGrace = "1s"');
    await crashOffload(row);
    await Bun.sleep(1_100);
  },
};

const ONLOAD_SCENARIOS: Record<ScenarioOf<typeof ONLOAD_BRANCH_KINDS>, Scenario> = {
  plain: async (row) => {
    await shelve();
    await crashOnload(row.point);
  },
  reuse: async (row) => {
    config('[offload]\nkeepLocalFor = "1h"');
    const done = await offload();
    if (!done.ok) throw new Error(`${done.finding.code}: ${done.finding.message}`);
    await crashOnload(row.point);
  },
  resume: async (row) => {
    await shelve();
    // The first onload stops before its swap; the second takes it over and crashes at the row's point.
    await crashOnload(MATRIX_POINTS.resumeFrom);
    await crashOnload(row.point);
  },
};

const SCENARIOS: { readonly [S in Saga]: Readonly<Record<string, Scenario>> } = {
  offload: OFFLOAD_SCENARIOS,
  onload: ONLOAD_SCENARIOS,
};

interface RowOptions {
  /** A crash of the row's own, instead of its scenario's. */
  crash?: Scenario;
  /** Harm done after recover, which the row's checks must then report (the damage mode and its standing test). */
  damage?: (world: World) => void;
  /** Recover starts with this device's event mirror empty: it must read the store itself, through the codec. */
  emptyMirror?: boolean;
}

/** Runs a row's crash, recover twice, and the row's checks. */
const runRow = async (row: Row, options: RowOptions = {}) => {
  const crash = options.crash ?? SCENARIOS[row.saga][row.scenario];
  if (crash === undefined) throw new Error(`no ${row.saga} scenario ${row.scenario}`);
  const seen = await snapshotIds(engine);
  const before = journalSteps(box.paths);
  await crash(row);
  for (const id of await snapshotIds(engine)) seen.add(id);
  const steps = journalSteps(box.paths);
  const crashedOp = crashedOperation(before, steps);
  const crashedStep = crashedOp === undefined ? undefined : steps.get(crashedOp);
  const crashLeft = crashCopyProblems(row, world(), reference);
  if (heldDelete !== undefined) {
    const started = await heldDelete();
    heldDelete = undefined;
    if (!(started as Result<unknown>).ok) throw new Error("the held detached delete did not start");
    await settleJournals(box.paths);
  }
  const journalAtRecover = crashedOp !== undefined && journalSteps(box.paths).has(crashedOp);
  if (options.emptyMirror) mirror.data.clear();
  const report = reportOf(await recover(recoverDeps()));
  // A finished release hands its trash to a detached delete, which holds it (trash-kept) until it is done.
  await settleJournals(box.paths);
  const again = reportOf(await recover(recoverDeps()));
  options.damage?.(world());
  const problems = await rowProblems(row, world(), {
    crashedStep,
    crashedOp,
    journalAtRecover,
    report,
    again,
    reference,
    ...(released === undefined ? {} : { released }),
    seen,
    projectId: await projectId(),
  });
  return { problems: [...crashLeft, ...problems], crashedOp };
};

/** A row's test: green when its checks find nothing, or, in the damage mode, when they find the harm done. */
const rowTest = (row: Row) => async () => {
  const { problems } = await runRow(row, DAMAGE_MODE ? { damage } : {});
  if (DAMAGE_MODE) expect(problems.length).toBeGreaterThan(0);
  else expect(problems).toEqual([]);
};

/** Events the crashed release's catalog read could not have seen (Q16's residual), for invariant 1. */
let unseen: string[] | undefined;

const world = (): World => ({
  paths: box.paths,
  device: device.id,
  dir,
  root: join(box.home, "work"),
  store: { name: "ssd", blob: store, engine, ...(catalog === undefined ? {} : { catalog }) },
  ...(unseen === undefined ? {} : { unseen }),
});

// A sealed store's catalog (Task 11): at every boundary where recover decides from the store's events whether the
// operation committed, a crash then recover with an empty mirror settles exactly as on a plain store: the same row,
// the same checks. The store's event files are sealed, so a recover that read them without the codec would find
// no event, and roll back an operation that committed.
const CATALOG_STEPS = /commit|snapshot\.(done|verified|discarded)|diverged/;
const catalogRows = ALL_ROWS.filter((row) => CATALOG_STEPS.test(row.step));

for (const kind of ["plain", "sealed"] as const)
  describe(`crash matrix, in-process: recover from the store alone, ${kind} catalog (${catalogRows.length} rows)`, () => {
    for (const row of catalogRows)
      test(row.name, async () => {
        if (kind === "sealed") catalog = sealedFor(store);
        const { problems } = await runRow(row, { emptyMirror: true });
        expect(problems).toEqual([]);
        const events = [...store.data].filter(([key]) => key.startsWith("meta/v1/events/"));
        expect(events.length).toBeGreaterThan(0);
        expect(events.every(([, data]) => looksSealed(data) === (kind === "sealed"))).toBe(true);
      }, 30_000);
  });

describe(`crash matrix, in-process: offload (${OFFLOAD_ROWS.length} rows)`, () => {
  for (const row of OFFLOAD_ROWS) test(row.name, rowTest(row), 30_000);
});

describe(`crash matrix, in-process: onload (${ONLOAD_ROWS.length} rows)`, () => {
  for (const row of ONLOAD_ROWS) test(row.name, rowTest(row), 30_000);
});

// A crash while the upload itself runs, not at a step: here the fake engine's snapshot dies part-way through its walk
// (in-process there is no restic process group to kill; the subprocess variant kills both). The journal stays at
// offload.snapshot.start, so the row is that step's, with its extra demands.
describe("crash matrix, in-process: a crash while the upload runs", () => {
  test("offload.snapshot.start · mid-upload: recover rolls back, the folder is untouched, a later offload is the head", async () => {
    const row = plainRowAt(MATRIX_POINTS.upload);
    const { problems, crashedOp } = await runRow(row, {
      crash: async () => {
        engine.hooks.duringSnapshot = () => {
          throw new InjectedFault("offload.upload");
        };
        await expect(offload()).rejects.toBeInstanceOf(InjectedFault);
        engine.hooks.duringSnapshot = undefined;
      },
    });
    expect(problems).toEqual([]);
    const later = await offload();
    expect(later.ok ? later.value.op : later.finding.code).not.toBe(crashedOp);
    expect(await laterHeadProblems(world(), await projectId(), crashedOp, reference, "none")).toEqual([]);
  }, 30_000);

  // restic finished its snapshot, and plainport died before it journaled offload.snapshot.done: the journal still says
  // offload.snapshot.start, whose rule rolls back; the snapshot stays in the repository, named by no event, never the
  // head (DESIGN "Journal steps", D28 (d)).
  test("offload.snapshot.start · restic committed, plainport died before journaling it: rolled back, the snapshot an orphan", async () => {
    const row = plainRowAt(MATRIX_POINTS.upload);
    const { problems, crashedOp } = await runRow(row, {
      crash: async () => {
        const real = engine.snapshot;
        engine.snapshot = async (input, ctx) => {
          const made = await real(input, ctx);
          engine.snapshot = real;
          if (!made.ok) throw new Error(`the snapshot failed: ${made.finding.message}`);
          throw new InjectedFault("offload.upload.committed");
        };
        await expect(offload()).rejects.toBeInstanceOf(InjectedFault);
      },
    });
    expect(problems).toEqual([]);
    const later = await offload();
    expect(later.ok ? later.value.op : later.finding.code).not.toBe(crashedOp);
    expect(await laterHeadProblems(world(), await projectId(), crashedOp, reference, "kept")).toEqual([]);
  }, 30_000);
});

// The swap's rename landed but its onload.swap.start write was lost (D24, N3): the journal still says the step
// before it, onload.verified (restore) or onload.begin (reuse). recover must ask the world, as at swap.start, and
// finish the onload: the folder in place, the stub gone, the onloaded event written, never a roll-back that leaves a
// stub beside a folder.
describe("crash matrix, in-process: a lost onload.swap.start write (N3)", () => {
  /** Crashes right after the rename, then puts the journal back at the step before swap.start, as a lost write would. */
  const lostSwapStart = (before: "onload.verified" | "onload.begin") => async () => {
    await crashOnload("onload.swap.renamed");
    const names = readdirSync(box.paths.journalDir).filter((n) => n.endsWith(".json"));
    const onload = names
      .map((n) => join(box.paths.journalDir, n))
      .find((f) => JSON.parse(readFileSync(f, "utf8")).kind === "onload");
    if (onload === undefined) throw new Error("the crash left no onload journal");
    const journal = JSON.parse(readFileSync(onload, "utf8"));
    expect(journal.step).toBe("onload.swap.start");
    writeFileSync(onload, `${JSON.stringify({ ...journal, step: before }, null, 2)}\n`);
  };

  test("onload.verified · the rename landed, swap.start lost: recover finishes the onload", async () => {
    const row = plainRowAt("onload.verified");
    const { problems, crashedOp } = await runRow(row, {
      crash: async () => {
        await shelve();
        await lostSwapStart("onload.verified")();
      },
    });
    expect(problems).toEqual([]);
    expect(existsSync(`${dir}.plainport`)).toBe(false);
    expect(existsSync(join(dir, "src"))).toBe(true);
    expect(crashedOp).toBeDefined();
  }, 30_000);

  test("onload.begin · reuse: the trash renamed back, swap.start lost: recover finishes the onload", async () => {
    // onload.begin is one step for both modes, so its row is the plain one; the crash is the reuse run's.
    const row = plainRowAt("onload.begin");
    const { problems } = await runRow(row, {
      crash: async () => {
        config('[offload]\nkeepLocalFor = "1h"');
        const done = await offload();
        if (!done.ok) throw new Error(`${done.finding.code}: ${done.finding.message}`);
        await lostSwapStart("onload.begin")();
      },
    });
    expect(problems).toEqual([]);
    expect(existsSync(`${dir}.plainport`)).toBe(false);
    expect(existsSync(join(box.home, "work/.plainport-trash"))).toBe(false);
  }, 30_000);
});

// The release's catalog read (M2 Task 23, the fork table's F2 and F3): killed between the re-read and the rename, the
// store unreachable at the re-read, and a lost release.moved write. Recover decides from the world: a folder still in
// place is read again (a fork keeps it, F2), one already in the trash is never moved back (F3).
describe("crash matrix, in-process: the release's re-read (forks)", () => {
  /** Another copy's first offload of the project: with this one's, two first offloads are a fork. */
  const forkNow = async () => {
    const id = (await projectId()) as string;
    const registry = await readRegistry(testHost(), box.paths);
    const rootId = registry.ok ? (registry.value.roots?.work as string) : "";
    const s = ulid();
    const appended = await appendEvent(storeEventLog(store, catalog), {
      v: 1,
      id: s,
      op: s,
      type: "offloaded",
      device: ulid(),
      at: new Date().toISOString(),
      project: id,
      root: rootId,
      path: "web",
      snapshot: s,
      stored: { ssd: "c".repeat(64) },
      stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
    });
    if (!appended.ok) throw new Error(appended.finding.message);
    return s;
  };

  test("offload.release.reread · killed between the re-read and the rename, then a fork: recover keeps the folder (F2)", async () => {
    const row = plainRowAt("offload.release.reread");
    const { problems, crashedOp } = await runRow(row, {
      crash: async (r) => {
        await crashOffload(r);
        await forkNow();
      },
    });
    expect(problems).toEqual([]);
    expect(existsSync(`${dir}.plainport`)).toBe(false);
    const registry = await readRegistry(testHost(), box.paths);
    expect(registry.ok ? registry.value.projects[(await projectId()) as string]?.base : undefined).toBe(
      crashedOp,
    );
  }, 30_000);

  test("offload.release.trash · the store unreachable at the re-read: nothing moves, recover waits, then releases", async () => {
    const row = plainRowAt("offload.release.trash");
    const { problems } = await runRow(row, {
      crash: async () => {
        const real = testHost({
          faults: {
            onStep: (step) => {
              capture(step);
              if (step === "offload.release.trash") storeDown = true;
            },
          },
        });
        const ran = await runOffload(offloadDeps(real), { project: await ref() });
        expect(ran.ok ? "released" : [ran.exitCode, ran.finding.code]).toEqual([9, "store.unreachable"]);
        expect(existsSync(join(dir, "src"))).toBe(true);
        // Recover with the store still down: pending, the folder never moved.
        const held = reportOf(await recover(recoverDeps()));
        expect(held.operations.map((o) => [o.step, o.outcome])).toEqual([
          ["offload.release.trash", "pending"],
        ]);
        expect(existsSync(join(dir, "src"))).toBe(true);
        storeDown = false;
      },
    });
    expect(problems).toEqual([]);
  }, 30_000);

  test("offload.release.renamed · release.moved lost, then a fork: recover goes on from the trash (F3)", async () => {
    const row = plainRowAt("offload.release.renamed");
    const { problems } = await runRow(row, {
      crash: async (r) => {
        await crashOffload(r);
        unseen = [await forkNow()];
      },
    });
    expect(problems).toEqual([]);
    expect(existsSync(`${dir}.plainport`)).toBe(true);
  }, 30_000);

  test("offload.release.trash · the rename not done, then a fork: the re-read decides F2", async () => {
    const row = plainRowAt("offload.release.trash");
    const { problems } = await runRow(row, {
      crash: async (r) => {
        await crashOffload(r);
        await forkNow();
      },
    });
    expect(problems).toEqual([]);
    expect(existsSync(`${dir}.plainport`)).toBe(false);
  }, 30_000);
});

// The standing proof that the row checks bite (the damage mode, PLAINPORT_CRASH_MATRIX_DAMAGE=1, runs it on every row
// of both variants): harm done after recover, which a weakened check would let through.
describe("crash matrix, in-process: the checks catch damage", () => {
  const cases: [string, string, (w: World) => void, string][] = [
    [
      "offload.begin",
      "a deleted .env",
      (w) => rmSync(join(w.dir, ".env")),
      "not the project as it stood before the run: .env",
    ],
    [
      "offload.begin",
      "an exec bit lost",
      (w) => chmodSync(join(w.dir, "bin/run.sh"), 0o644),
      "not the project as it stood before the run: bin/run.sh",
    ],
    [
      "offload.begin",
      "a symlink retargeted",
      (w) => {
        rmSync(join(w.dir, "main-link"));
        symlinkSync("src/extra.ts", join(w.dir, "main-link"));
      },
      "not the project as it stood before the run: main-link",
    ],
    [
      "offload.release.stub",
      "a missing stub",
      (w) => rmSync(`${w.dir}.plainport`),
      "invariant 2: the stub is missing",
    ],
  ];
  for (const [point, harm, done, expected] of cases)
    test(`${point}: ${harm} is reported`, async () => {
      const { problems } = await runRow(plainRowAt(point), { damage: done });
      expect(problems.some((p) => p.includes(expected))).toBe(true);
    });
});
