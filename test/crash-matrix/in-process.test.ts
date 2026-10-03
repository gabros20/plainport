// The crash matrix, in-process variant (T0; ADR-0017, DESIGN.md "Testing and fault injection"): for every row the
// matrix enumerates (matrix.ts), run the saga against a sandboxed home, an in-memory store and the fake engine, crash
// it with the host's faultAt seam (an InjectedFault) at the row's step or seam, run recover, and check the row
// (checks.ts): recover's outcome, invariants 1–6, no work lost, a second recover with nothing to do.
//
// An InjectedFault unwinds the saga's own process, so it cannot leave the project's lock held the way a dead process
// does (Task 12); the subprocess variant (subprocess.test.ts) crashes every row with a real SIGKILL for that.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, finding, type Result } from "../../packages/contract/src/index.ts";
import { appendEvent, storeEventLog } from "../../packages/core/src/catalog/index.ts";
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
  journalSteps,
  laterHeadProblems,
  rowProblems,
  settleJournals,
  snapshotIds,
  type World,
} from "./checks.ts";
import {
  copyProject,
  hashTree,
  makeProjectTemplate,
  type ProjectTemplate,
  type TreeHash,
  treeDiff,
} from "./fixture.ts";
import {
  type BranchKind,
  type OFFLOAD_BRANCH_KINDS,
  OFFLOAD_ROWS,
  type ONLOAD_BRANCH_KINDS,
  ONLOAD_ROWS,
  type Row,
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
let releasedHash: TreeHash | undefined;

/** At the start of release (live or resumed by recover), the folder as it stands: invariant 1's capture. */
const capture = (step: string) => {
  if (step === "offload.release.trash" && existsSync(dir)) {
    released = captureTree(dir);
    releasedHash = hashTree(dir);
  }
};

const opener: StoreOpener = { open: async () => ({ ok: true, value: { blob: store, engine } }) };

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
  releasedHash = undefined;
});

afterEach(() => {
  try {
    chmodSync(join(dir, "src/extra.ts"), 0o644);
  } catch {}
  box.cleanup();
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

const offload = async (faults: { at?: string; occurrence?: number } = {}) => {
  const host = testHost({ faults: { ...faults, onStep: capture } });
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
  const trash = join(box.home, "work/.plainport-trash");
  for (let i = 0; i < 400; i++) {
    const busy = (existsSync(trash) && readdirSync(trash).length > 0) || journalSteps(box.paths).size > 0;
    if (!busy) break;
    await Bun.sleep(25);
  }
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
    const appended = await appendEvent(storeEventLog(store), {
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

type ScenarioOf<K extends Record<string, BranchKind>> =
  | "plain"
  | { [B in keyof K]: K[B] extends "plain" ? never : B }[keyof K];

/** How each offload scenario crashes at a row; the project's own edits (a retry's) are part of what it must keep. */
const OFFLOAD_SCENARIOS: Record<ScenarioOf<typeof OFFLOAD_BRANCH_KINDS>, (row: Row) => Promise<void>> = {
  plain: crashOffload,
  discarded: async (row) => {
    engine.hooks.duringSnapshot = () => chmodSync(join(dir, "src/extra.ts"), 0o000);
    try {
      await crashOffload(row);
    } finally {
      chmodSync(join(dir, "src/extra.ts"), 0o644);
    }
  },
  diverged: async (row) => {
    await registerFirst();
    await otherCopyDuringUpload();
    await crashOffload(row);
  },
  retry: async (row) => {
    engine.hooks.duringSnapshot = (_input, attempt) => {
      if (attempt === 1) writeFileSync(join(dir, "notes/todo.txt"), "edited during the upload\n");
    };
    await crashOffload(row);
  },
};

const ONLOAD_SCENARIOS: Record<ScenarioOf<typeof ONLOAD_BRANCH_KINDS>, (row: Row) => Promise<void>> = {
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
    await crashOnload("onload.verified");
    await crashOnload(row.point);
  },
};

/** Runs a row's crash (or `crash` instead of its scenario's), recover twice, and the row's checks. */
const runRow = async (row: Row, crash?: (row: Row) => Promise<void>) => {
  const scenarios: Record<string, (row: Row) => Promise<void>> =
    row.saga === "offload" ? OFFLOAD_SCENARIOS : ONLOAD_SCENARIOS;
  crash ??= scenarios[row.scenario];
  if (crash === undefined) throw new Error(`no ${row.saga} scenario ${row.scenario}`);
  const seen = await snapshotIds(engine);
  const before = journalSteps(box.paths);
  await crash(row);
  for (const id of await snapshotIds(engine)) seen.add(id);
  // The crashed operation: the newest journal (an onload's resume or reuse may leave an older one beside it).
  const steps = journalSteps(box.paths);
  const ops = [...steps.keys()].sort();
  const crashedOp = row.saga === "offload" ? ops.at(-1) : ops.filter((o) => !before.has(o)).at(-1);
  const crashedStep = crashedOp === undefined ? undefined : steps.get(crashedOp);
  // The project as the crash left it: an onload's is the shelved project; an offload's folder, or its capture.
  const reference =
    row.saga === "offload" && existsSync(dir) ? hashTree(dir) : (releasedHash ?? hashTree(dir));
  const report = reportOf(await recover(recoverDeps()));
  // A finished release hands its trash to a detached delete, which holds it (trash-kept) until it is done.
  await settleJournals(box.paths);
  const again = reportOf(await recover(recoverDeps()));
  return rowProblems(row, world(), {
    crashedStep,
    crashedOp,
    report,
    again,
    reference,
    ...(released === undefined ? {} : { released }),
    seen,
    projectId: await projectId(),
  }).then((problems) => ({ problems, crashedOp }));
};

const world = (): World => ({
  paths: box.paths,
  device: device.id,
  dir,
  root: join(box.home, "work"),
  store: { name: "ssd", blob: store, engine },
});

describe(`crash matrix, in-process: offload (${OFFLOAD_ROWS.length} rows)`, () => {
  for (const row of OFFLOAD_ROWS)
    test(row.name, async () => expect((await runRow(row)).problems).toEqual([]), 30_000);
});

describe(`crash matrix, in-process: onload (${ONLOAD_ROWS.length} rows)`, () => {
  for (const row of ONLOAD_ROWS)
    test(row.name, async () => expect((await runRow(row)).problems).toEqual([]), 30_000);
});

// A crash while the upload itself runs, not at a step: here the fake engine's snapshot dies part-way through its walk
// (in-process there is no restic process group to kill; the subprocess variant kills both). The journal stays at
// offload.snapshot.start, so the row is that step's, with its extra demands.
describe("crash matrix, in-process: a crash while the upload runs", () => {
  test("offload.snapshot.start · mid-upload: recover rolls back, the folder is untouched, a later offload is the head", async () => {
    const row = OFFLOAD_ROWS.find(
      (r) => r.point === "offload.snapshot.start" && r.scenario === "plain",
    ) as Row;
    const untouched = hashTree(dir);
    const { problems, crashedOp } = await runRow(row, async () => {
      engine.hooks.duringSnapshot = () => {
        throw new InjectedFault("offload.upload");
      };
      await expect(offload()).rejects.toBeInstanceOf(InjectedFault);
      engine.hooks.duringSnapshot = undefined;
    });
    expect(problems).toEqual([]);
    expect(treeDiff(untouched, hashTree(dir))).toEqual([]);
    const later = await offload();
    expect(later.ok ? later.value.op : later.finding.code).not.toBe(crashedOp);
    expect(await laterHeadProblems(world(), await projectId(), crashedOp, untouched)).toEqual([]);
  }, 30_000);
});
