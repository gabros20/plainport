// plainport recover against a sandboxed home, an in-memory store and the fake engine (T0): every journal step of both
// sagas, and every after-effect seam (D52), left by a crash (an injected fault) or written by hand where only a lost
// write reaches the state (D24, D50), resolves to the right stable state, and invariants 1–3 hold afterwards. The
// crash matrix (Task 15) repeats this with a killed process.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";
import { nodePlugin } from "../../../eco-node/src/index.ts";
import { appendEvent, type CatalogEvent, foldCatalog, readEvents, storeEventLog } from "../catalog/index.ts";
import { ConfigLoader } from "../config/load.ts";
import { type Device, ensureDevice } from "../device.ts";
import {
  type Journal,
  JournalSchema,
  journalFile,
  type OffloadJournal,
  type OnloadJournal,
  readJournals,
  writeJournal,
} from "../journal/index.ts";
import { acquireLock } from "../lock.ts";
import type { HostPorts } from "../ports/host.ts";
import { InjectedFault } from "../ports/host.ts";
import type { StoreOpener } from "../ports/store.ts";
import { readRegistry } from "../registry.ts";
import { type ProjectRef, resolveProject } from "../roots/address.ts";
import { openSaga } from "../saga/journaled.ts";
import {
  OFFLOAD_AFTER_EFFECT,
  OFFLOAD_STEPS,
  type OffloadDeps,
  type OffloadRequest,
  runOffload,
} from "../saga/offload.ts";
import { ONLOAD_AFTER_EFFECT, ONLOAD_STEPS, type OnloadDeps, runOnload } from "../saga/onload.ts";
import { releaseOffload } from "../saga/release.ts";
import { runRestore } from "../saga/restore.ts";
import { projectViews, type ViewDeps } from "../status/projects.ts";
import { setUpStore } from "../store.ts";
import { StubSchema } from "../stub.ts";
import { quietChecks } from "../testing/checks.ts";
import { type FakeEngine, fakeEngine } from "../testing/fake-engine.ts";
import { testHost } from "../testing/host.ts";
import { captureTree, invariantViolations, type TreeCapture } from "../testing/invariants.ts";
import { type MemoryBlobStore, memoryBlobStore } from "../testing/memory-blob-store.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { ulid } from "../ulid.ts";
import { type RecoverDeps, type RecoveryReport, recover } from "./recover.ts";
import { stagingJsonSchemas } from "./staging.ts";
import { collectTrash, housekeeping, type TrashDeps } from "./trash.ts";

const PATH = process.env.PATH ?? "/usr/bin:/bin";

let box: Sandbox;
let device: Device;
let store: MemoryBlobStore;
let mirror: MemoryBlobStore;
let engine: FakeEngine;
let dir: string;
/** The folder as it stood when release began: what invariant 1 checks the committed snapshot against. */
let released: TreeCapture | undefined;
const capture = (step: string) => {
  // A release resumed after the rename reaches the step with the folder already in the trash.
  if (step === "offload.release.trash" && existsSync(dir)) released = captureTree(dir);
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
  box = makeSandbox("plainport-recover-");
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
  box.file("work/web/package.json", `${JSON.stringify({ name: "web" })}\n`);
  box.file("work/web/package-lock.json", `${JSON.stringify({ lockfileVersion: 3 })}\n`);
  box.file("work/web/src/main.ts", "export const main = 1;\n");
  box.file("work/web/.env", "TOKEN=op://vault/item\n");
  box.file("work/web/node_modules/dep/index.js", "x".repeat(400));
  symlinkSync("src/main.ts", join(box.home, "work/web/main-link"));
  dir = join(box.home, "work/web");
  released = undefined;
});

afterEach(() => {
  try {
    chmodSync(join(dir, "src/main.ts"), 0o644);
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

const recoverDeps = (over: Partial<RecoverDeps> = {}): RecoverDeps => {
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
    ...over,
  };
};

const ref = async (input = "work:web"): Promise<ProjectRef> => {
  const resolved = await resolveProject(testHost(), box.paths, input, {
    cwd: box.home,
    env: { HOME: box.home },
    device: "mbp",
  });
  if (!resolved.ok) throw new Error(resolved.finding.message);
  return resolved.value;
};

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

/** The report, whether recover succeeded or failed with it as data. */
const reportOf = (result: Result<RecoveryReport>): RecoveryReport => {
  if (result.ok) return result.value;
  if (result.data === undefined) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.data as RecoveryReport;
};

const storeEvents = async (): Promise<CatalogEvent[]> => value(await readEvents(storeEventLog(store))).events;

const projectId = async (): Promise<string | undefined> =>
  Object.entries(value(await readRegistry(testHost(), box.paths)).projects).find(
    ([, e]) => e.path === "web",
  )?.[0];

const journals = async (): Promise<Journal[]> => (await readJournals(testHost(), box.paths)).journals;

const onlyJournal = <J extends Journal>(): J => {
  const names = readdirSync(box.paths.journalDir).filter((n) => n.endsWith(".json"));
  expect(names).toHaveLength(1);
  return JournalSchema.parse(
    JSON.parse(readFileSync(join(box.paths.journalDir, names[0] as string), "utf8")),
  ) as J;
};

const rewrite = async (journal: Journal) => writeJournal(testHost(), box.paths, journal);

const expectInvariants = async (settleMs?: number) =>
  expect(
    await invariantViolations({
      paths: box.paths,
      device: device.id,
      project: { id: await projectId(), dir },
      roots: [join(box.home, "work")],
      store: { name: "ssd", blob: store, engine },
      ...(released === undefined ? {} : { released }),
      stripped: ["node_modules"],
      ...(settleMs === undefined ? {} : { settleMs }),
    }),
  ).toEqual([]);

/** Runs an offload that crashes at `point` (a step or an after-effect seam). */
const crashOffloadAt = async (point: string, req: Partial<OffloadRequest> = {}, occurrence = 1) => {
  const host = testHost({ faults: { at: point, occurrence, onStep: capture } });
  await expect(runOffload(offloadDeps(host), { project: await ref(), ...req })).rejects.toBeInstanceOf(
    InjectedFault,
  );
};

const offloadNow = async () => {
  const host = testHost({ faults: { onStep: capture } });
  return runOffload(offloadDeps(host), { project: await ref() });
};

/** The detached delete removes the trash, then the journal, after the call returns. */
const waitJournalsGone = async () => {
  for (let i = 0; i < 400 && readdirSync(box.paths.journalDir).length > 0; i++) await Bun.sleep(25);
};

/** The trash folders under the root's holder. */
const trashes = (): string[] => {
  const holder = join(box.home, "work/.plainport-trash");
  return existsSync(holder) ? readdirSync(holder) : [];
};

const expectLocalUntouched = async () => {
  expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe("export const main = 1;\n");
  expect(existsSync(`${dir}.plainport`)).toBe(false);
  expect(await journals()).toEqual([]);
};

const expectShelved = async () => {
  expect(existsSync(dir)).toBe(false);
  const stub = StubSchema.parse(JSON.parse(readFileSync(`${dir}.plainport`, "utf8")));
  const id = (await projectId()) as string;
  expect(foldCatalog(await storeEvents()).projects[id]?.head).toBe(stub.snapshot);
  expect(value(await readRegistry(testHost(), box.paths)).projects[id]?.base).toBe(stub.snapshot);
};

describe("recover: an offload, at every journal step", () => {
  const ROLLED_BACK = [
    "offload.begin",
    "offload.preflight.done",
    "offload.scan.done",
    "offload.strip.done",
    "offload.planned",
    "offload.snapshot.start",
    "offload.snapshot.done",
    "offload.verified",
    "offload.commit.start",
  ];
  for (const step of ROLLED_BACK) {
    test(`a crash at ${step} rolls back: the folder stays, no event, no journal`, async () => {
      await crashOffloadAt(step);
      const report = reportOf(await recover(recoverDeps()));
      expect(report.operations.map((o) => [o.step, o.outcome, o.state])).toEqual([
        [step, "rolled-back", "local"],
      ]);
      await expectLocalUntouched();
      expect((await storeEvents()).filter((e) => e.type === "offloaded")).toEqual([]);
      await expectInvariants();
    });
  }

  for (const step of [
    "offload.committed",
    "offload.release.trash",
    "offload.release.moved",
    "offload.release.stub",
  ] as const) {
    test(`a crash at ${step} finishes the release: folder in the trash, stub, base`, async () => {
      await crashOffloadAt(step);
      const result = await recover(recoverDeps());
      expect(result.ok).toBe(true);
      const [op] = reportOf(result).operations;
      expect([op?.outcome, op?.state]).toEqual(["finished", "shelved"]);
      await expectShelved();
      await expectInvariants();
    });
  }

  test("a crash at offload.release.delete deletes the trash and closes the journal", async () => {
    await crashOffloadAt("offload.release.delete");
    expect(trashes()).toHaveLength(1);
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect([op?.outcome, op?.state]).toEqual(["trash-deleted", "shelved"]);
    expect(trashes()).toEqual([]);
    expect(await journals()).toEqual([]);
    await expectShelved();
    await expectInvariants();
  });

  test("a crash at offload.snapshot.discarded writes the snapshot-discarded event, then rolls back (D28)", async () => {
    engine.hooks.duringSnapshot = () => chmodSync(join(dir, "src/main.ts"), 0o000);
    await crashOffloadAt("offload.snapshot.discarded");
    chmodSync(join(dir, "src/main.ts"), 0o644);
    const journal = onlyJournal<OffloadJournal>();
    expect((await storeEvents()).filter((e) => e.type === "snapshot-discarded")).toEqual([]);
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect(op?.outcome).toBe("rolled-back");
    const discarded = (await storeEvents()).filter((e) => e.type === "snapshot-discarded");
    expect(discarded.map((e) => e.id)).toEqual([journal.discarded?.event as string]);
    expect(discarded[0]).toMatchObject({
      snapshot: journal.op,
      stored: { ssd: journal.discarded?.snapshot },
    });
    await expectLocalUntouched();
    await expectInvariants();
  });

  const otherCopyDuringUpload = async () => {
    const id = (await projectId()) as string;
    const rootId = value(await readRegistry(testHost(), box.paths)).roots?.work as string;
    engine.hooks.duringSnapshot = async () => {
      engine.hooks.duringSnapshot = undefined;
      const s = ulid();
      value(
        await appendEvent(storeEventLog(store), {
          v: 1,
          id: s,
          op: s,
          type: "offloaded",
          device: ulid(),
          at: "2026-10-02T00:00:00.000Z",
          project: id,
          root: rootId,
          path: "web",
          snapshot: s,
          stored: { ssd: "c".repeat(64) },
          stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
        }),
      );
    };
  };

  /** Registers the project and its root first, so the fork's other event can name them. */
  const registerFirst = async () => {
    engine.hooks.failNext = {
      snapshot: fail(finding("internal.unexpected", { message: "the first try fails" })),
    };
    const first = await offloadNow();
    expect(first.ok).toBe(false);
  };

  test("a crash at offload.diverged appends the fork event the store lacks; the folder stays (conflicted)", async () => {
    await registerFirst();
    await otherCopyDuringUpload();
    await crashOffloadAt("offload.diverged");
    const journal = onlyJournal<OffloadJournal>();
    expect((await storeEvents()).some((e) => e.id === journal.event)).toBe(false);
    const result = await recover(recoverDeps());
    const [op] = reportOf(result).operations;
    expect([op?.outcome, op?.state]).toEqual(["forked", "conflicted"]);
    const fork = (await storeEvents()).find((e) => e.id === journal.event);
    expect(fork).toMatchObject({
      type: "offloaded",
      snapshot: journal.op,
      stored: { ssd: journal.verified },
    });
    expect(foldCatalog(await storeEvents()).projects[journal.project.id]?.status).toBe("conflicted");
    await expectLocalUntouched();
    await expectInvariants();
  });

  test("a crash after the fork event was appended (offload.diverged.appended) keeps the folder (conflicted)", async () => {
    await registerFirst();
    await otherCopyDuringUpload();
    await crashOffloadAt("offload.diverged.appended");
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect([op?.outcome, op?.state]).toEqual(["forked", "conflicted"]);
    expect((await storeEvents()).filter((e) => e.type === "offloaded")).toHaveLength(2);
    await expectLocalUntouched();
    await expectInvariants();
  });
});

describe("recover: an offload, at every after-effect seam (D52)", () => {
  const FINISHED: Record<string, "finished" | "trash-deleted"> = {
    "offload.commit.appended": "finished",
    "offload.release.renamed": "finished",
    "offload.release.stub-placed": "finished",
    "offload.release.registry-updated": "finished",
    "offload.release.detached": "trash-deleted",
  };
  for (const [point, outcome] of Object.entries(FINISHED)) {
    test(`a crash at ${point} (journal at ${OFFLOAD_AFTER_EFFECT[point as keyof typeof OFFLOAD_AFTER_EFFECT]}) ends shelved`, async () => {
      await crashOffloadAt(point);
      const [op] = reportOf(await recover(recoverDeps())).operations;
      expect([op?.outcome, op?.state]).toEqual([outcome, "shelved"]);
      await expectShelved();
      await expectInvariants();
    });
  }

  test("a crash at offload.root-created (journal at offload.begin) rolls back; the root event stays", async () => {
    await crashOffloadAt("offload.root-created");
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect(op?.outcome).toBe("rolled-back");
    expect((await storeEvents()).map((e) => e.type)).toEqual(["root-created"]);
    await expectLocalUntouched();
    await expectInvariants();
  });

  test("a crash at offload.snapshot.discarded.appended rolls back without a second event", async () => {
    engine.hooks.duringSnapshot = () => chmodSync(join(dir, "src/main.ts"), 0o000);
    await crashOffloadAt("offload.snapshot.discarded.appended");
    chmodSync(join(dir, "src/main.ts"), 0o644);
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect(op?.outcome).toBe("rolled-back");
    expect((await storeEvents()).filter((e) => e.type === "snapshot-discarded")).toHaveLength(1);
    await expectLocalUntouched();
    await expectInvariants();
  });

  test("every after-effect seam and every step has a test above", () => {
    expect(Object.keys(OFFLOAD_AFTER_EFFECT).sort()).toEqual(
      [
        ...Object.keys(FINISHED),
        "offload.root-created",
        "offload.snapshot.discarded.appended",
        "offload.diverged.appended",
      ].sort(),
    );
    expect(OFFLOAD_STEPS.length).toBe(16);
  });
});

describe("recover: an offload in a state only a lost write leaves (D24, D50)", () => {
  test("verified on the journal, the event on the store as the head (commit.start lost): finished", async () => {
    await crashOffloadAt("offload.commit.appended");
    const journal = onlyJournal<OffloadJournal>();
    const { event: _e, ...rest } = journal;
    await rewrite({ ...rest, step: "offload.verified" });
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect([op?.outcome, op?.state]).toEqual(["finished", "shelved"]);
    await expectShelved();
    await expectInvariants();
  });

  test("snapshot.done on the journal, the event on the store as the head (verified and commit.start lost): finished", async () => {
    await crashOffloadAt("offload.commit.appended");
    const journal = onlyJournal<OffloadJournal>();
    const { event: _e, verified: _v, ...rest } = journal;
    await rewrite({ ...rest, step: "offload.snapshot.done" });
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect(op?.outcome).toBe("finished");
    await expectShelved();
    await expectInvariants();
  });

  test("verified on the journal, the event on the store but forked (diverged lost): the folder stays", async () => {
    await crashOffloadAt("offload.commit.appended");
    const journal = onlyJournal<OffloadJournal>();
    // Another copy's first offload: two first offloads are a fork.
    const s = ulid();
    value(
      await appendEvent(storeEventLog(store), {
        v: 1,
        id: s,
        op: s,
        type: "offloaded",
        device: ulid(),
        at: "2026-10-02T00:00:00.000Z",
        project: journal.project.id,
        root: journal.project.rootId,
        path: "web",
        snapshot: s,
        stored: { ssd: "d".repeat(64) },
        stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
      }),
    );
    const { event: _e, ...rest } = journal;
    await rewrite({ ...rest, step: "offload.verified" });
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect([op?.outcome, op?.state]).toEqual(["forked", "conflicted"]);
    await expectLocalUntouched();
    await expectInvariants();
  });

  test("committed with no trash (release.trash lost) and the folder already in it: the trash is derived", async () => {
    await crashOffloadAt("offload.release.renamed");
    const journal = onlyJournal<OffloadJournal>();
    const { trash: _t, ...rest } = journal;
    await rewrite({ ...rest, step: "offload.committed" });
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect(op?.outcome).toBe("finished");
    await expectShelved();
    await expectInvariants();
  });

  test("a stub written but the registry not updated (release.stub reached): the registry is finished", async () => {
    await crashOffloadAt("offload.release.stub");
    const id = (await projectId()) as string;
    expect(value(await readRegistry(testHost(), box.paths)).projects[id]?.base).toBeDefined();
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect(op?.outcome).toBe("finished");
    await expectShelved();
    await expectInvariants();
  });
});

describe("recover: releaseOffload's guards (Task 12 quality r3)", () => {
  test("a resume refuses to run a stage for a saga that is not committed", async () => {
    await crashOffloadAt("offload.committed");
    const journal = onlyJournal<OffloadJournal>();
    const host = testHost();
    const saga = openSaga(
      { io: host, paths: box.paths, faultAt: () => {}, clock: () => new Date(), log: () => {} },
      journal,
    );
    await expect(
      releaseOffload(
        { host, paths: box.paths, saga, clock: () => new Date(), log: () => {} },
        { at: new Date().toISOString(), bytes: 1 },
      ),
    ).rejects.toThrow(/committed/);
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
  });

  test("an edit after the crash (at offload.committed) keeps the folder: diverged-after-commit, exit 8, no stub", async () => {
    await crashOffloadAt("offload.committed");
    const journal = onlyJournal<OffloadJournal>();
    writeFileSync(join(dir, "src/main.ts"), "export const main = 2;\n");
    const result = await recover(recoverDeps());
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([
      8,
      "offload.diverged-after-commit",
    ]);
    const [op] = reportOf(result).operations;
    expect([op?.outcome, op?.state, op?.conflict?.kind]).toEqual([
      "diverged-after-commit",
      "local",
      "diverged-after-commit",
    ]);
    expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe("export const main = 2;\n");
    expect(existsSync(`${dir}.plainport`)).toBe(false);
    expect(await journals()).toEqual([]);
    expect(value(await readRegistry(testHost(), box.paths)).projects[journal.project.id]?.base).toBe(
      journal.op,
    );
    await expectInvariants();
  });

  test("a folder at the project's place while the journal says it was moved: refused, no stub beside it", async () => {
    await crashOffloadAt("offload.release.moved");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/new.ts"), "new\n");
    const result = await recover(recoverDeps());
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "path.occupied"]);
    expect([reportOf(result).operations[0]?.outcome]).toEqual(["pending"]);
    expect(existsSync(`${dir}.plainport`)).toBe(false);
    expect(readFileSync(join(dir, "src/new.ts"), "utf8")).toBe("new\n");
    expect(await journals()).toHaveLength(1);
  });

  test("the folder both at its place and in the trash (journal at release.trash): refused, both kept", async () => {
    await crashOffloadAt("offload.release.renamed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "other.txt"), "x\n");
    const result = await recover(recoverDeps());
    expect(result.ok ? 0 : result.finding.code).toBe("path.occupied");
    expect(existsSync(`${dir}.plainport`)).toBe(false);
    expect(trashes()).toHaveLength(1);
    expect(existsSync(join(dir, "other.txt"))).toBe(true);
  });

  test("a crash at offload.commit.start with the event never appended rolls back; with it appended, finishes", async () => {
    await crashOffloadAt("offload.commit.start");
    expect(reportOf(await recover(recoverDeps())).operations[0]?.outcome).toBe("rolled-back");
    await expectLocalUntouched();
    await expectInvariants();
    await crashOffloadAt("offload.commit.appended");
    expect(reportOf(await recover(recoverDeps())).operations[0]?.outcome).toBe("finished");
    await expectShelved();
    await expectInvariants();
  });
});

describe("recover: keepLocalFor, locks and an unreachable store", () => {
  test("a released trash kept by keepLocalFor waits for its deadline, then goes", async () => {
    config('[offload]\nkeepLocalFor = "1h"');
    value(await offloadNow());
    const [journal] = (await journals()) as OffloadJournal[];
    expect(journal?.keepUntil).toBeDefined();
    const early = reportOf(await recover(recoverDeps()));
    expect(early.operations.map((o) => [o.outcome, o.keepUntil])).toEqual([
      ["trash-kept", journal?.keepUntil],
    ]);
    expect(trashes()).toHaveLength(1);
    await expectInvariants();
    const later = new Date(Date.parse(journal?.keepUntil as string) + 1000);
    const late = reportOf(await recover(recoverDeps({ now: () => later })));
    expect(late.operations.map((o) => o.outcome)).toEqual(["trash-deleted"]);
    expect(trashes()).toEqual([]);
    expect(await journals()).toEqual([]);
    await expectInvariants();
  });

  test("a project whose lock a live process holds is left pending (project.locked, 11)", async () => {
    await crashOffloadAt("offload.committed");
    const journal = onlyJournal<OffloadJournal>();
    const held = value(
      await acquireLock(testHost(), join(box.paths.locksDir, `${journal.project.id}.lock`), {
        timeoutMs: 0,
        held: () => finding("project.locked", { message: "held" }),
      }),
    );
    try {
      const result = await recover(recoverDeps());
      expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([11, "project.locked"]);
      expect(reportOf(result).operations.map((o) => o.outcome)).toEqual(["pending"]);
      expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    } finally {
      await held.release();
    }
    expect(reportOf(await recover(recoverDeps())).operations[0]?.outcome).toBe("finished");
    await expectInvariants();
  });

  test("an unreachable store at offload.commit.start leaves the journal and the folder (store.unreachable, 9)", async () => {
    await crashOffloadAt("offload.commit.appended");
    const unreachable = {
      ok: false as const,
      exitCode: 9 as const,
      finding: {
        code: "store.unreachable",
        severity: "block" as const,
        message: "the disk is not mounted",
        allowable: false,
      },
    };
    const gone: StoreOpener = {
      open: async () => ({
        ok: true,
        value: {
          blob: {
            ...store,
            get: async () => unreachable,
            stat: async () => unreachable,
            list: async () => unreachable,
          },
          engine,
        },
      }),
    };
    const result = await recover(recoverDeps({ opener: gone }));
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([9, "store.unreachable"]);
    expect(reportOf(result).operations.map((o) => [o.outcome, o.state])).toEqual([["pending", "offloading"]]);
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    expect(await journals()).toHaveLength(1);
    expect(reportOf(await recover(recoverDeps())).operations[0]?.outcome).toBe("finished");
    await expectInvariants();
  });

  test("nothing to recover: an empty report, exit 0", async () => {
    expect(await recover(recoverDeps())).toEqual({ ok: true, value: { operations: [], unreadable: [] } });
  });

  test("a journal this version cannot read is reported and left alone (journal.pending, 6)", async () => {
    mkdirSync(box.paths.journalDir, { recursive: true });
    const path = journalFile(box.paths, ulid());
    writeFileSync(path, "{ not json");
    const result = await recover(recoverDeps());
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "journal.pending"]);
    expect(reportOf(result).unreadable).toEqual([path]);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});

describe("recover: an onload, at every journal step and after-effect seam", () => {
  /** Offloads the project (its trash deleted), so an onload has something to restore. */
  const shelve = async () => {
    value(await offloadNow());
    // The detached delete removes the trash, then the offload's journal.
    for (let i = 0; i < 400 && (trashes().length > 0 || (await journals()).length > 0); i++)
      await Bun.sleep(25);
  };

  const crashOnloadAt = async (point: string) => {
    const host = testHost({ faults: { at: point } });
    await expect(
      runOnload(onloadDeps(host), { project: await ref(), hydrate: false }),
    ).rejects.toBeInstanceOf(InjectedFault);
  };

  const stagings = (): string[] => {
    const holder = join(box.home, "work/.plainport-staging");
    return existsSync(holder) ? readdirSync(holder) : [];
  };

  for (const step of [
    "onload.begin",
    "onload.restore.start",
    "onload.restored",
    "onload.verified",
    "onload.swap.start",
  ]) {
    test(`a crash at ${step} rolls back: staging removed, the stub stays (shelved)`, async () => {
      await shelve();
      await crashOnloadAt(step);
      const [op] = reportOf(await recover(recoverDeps())).operations;
      expect([op?.kind, op?.step, op?.outcome, op?.state]).toEqual([
        "onload",
        step,
        "rolled-back",
        "shelved",
      ]);
      expect(stagings()).toEqual([]);
      expect(await journals()).toEqual([]);
      await expectShelved();
      await expectInvariants();
    });
  }

  const FINISHED = [
    "onload.swap.renamed",
    "onload.swapped",
    "onload.stub.removed",
    "onload.commit.start",
    "onload.commit.appended",
    "onload.committed",
    "onload.registry-updated",
  ];
  for (const point of FINISHED) {
    test(`a crash at ${point} finishes the onload: restored-unhydrated, no stub, the onloaded event`, async () => {
      await shelve();
      await crashOnloadAt(point);
      const report = reportOf(await recover(recoverDeps()));
      const settled = report.operations.filter((o) => o.kind === "onload");
      // registry-updated is past the last journal write but one: the journal is still open there.
      expect(settled.map((o) => [o.outcome, o.state])).toEqual([["finished", "restored-unhydrated"]]);
      expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe("export const main = 1;\n");
      expect(existsSync(`${dir}.plainport`)).toBe(false);
      const id = (await projectId()) as string;
      const state = foldCatalog(await storeEvents()).projects[id];
      expect(state?.status).toBe("local");
      expect((await storeEvents()).filter((e) => e.type === "onloaded")).toHaveLength(1);
      expect(value(await readRegistry(testHost(), box.paths)).projects[id]?.unhydrated).toBe(true);
      expect(await journals()).toEqual([]);
      await expectInvariants();
    });
  }

  test("a crash at onload.reuse.cleared (a renamed-back trash, keepLocalFor) finishes as local", async () => {
    config('[offload]\nkeepLocalFor = "1h"');
    value(await offloadNow());
    await crashOnloadAt("onload.reuse.cleared");
    const [op] = reportOf(await recover(recoverDeps())).operations.filter((o) => o.kind === "onload");
    expect([op?.outcome, op?.state]).toEqual(["finished", "local"]);
    expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe("export const main = 1;\n");
    expect(existsSync(join(dir, "node_modules/dep/index.js"))).toBe(true);
    expect(await journals()).toEqual([]);
    await expectInvariants();
  });

  test("every onload step and seam has a test above", () => {
    const covered = [
      "onload.begin",
      "onload.restore.start",
      "onload.restored",
      "onload.verified",
      "onload.swap.start",
      ...FINISHED,
      "onload.reuse.cleared",
    ];
    for (const s of [...ONLOAD_STEPS, ...Object.keys(ONLOAD_AFTER_EFFECT)]) expect(covered).toContain(s);
  });

  test("an onload whose store cannot be reached after its swap stays pending; the files are in place", async () => {
    await shelve();
    await crashOnloadAt("onload.swapped");
    const journal = onlyJournal<OnloadJournal>();
    const unreachable = {
      ok: false as const,
      exitCode: 9 as const,
      finding: {
        code: "store.unreachable",
        severity: "block" as const,
        message: "the disk is not mounted",
        allowable: false,
      },
    };
    const gone: StoreOpener = {
      open: async () => ({
        ok: true,
        value: {
          blob: {
            ...store,
            get: async () => unreachable,
            stat: async () => unreachable,
            list: async () => unreachable,
          },
          engine,
        },
      }),
    };
    const result = await recover(recoverDeps({ opener: gone }));
    expect(result.ok ? 0 : result.exitCode).toBe(9);
    expect(reportOf(result).operations.map((o) => [o.outcome, o.state])).toEqual([["pending", "onloading"]]);
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    expect((await journals()).map((j) => j.op)).toEqual([journal.op]);
  });
});

describe("gc: kept trash (keepLocalFor)", () => {
  const trashDeps = (over: Partial<TrashDeps> = {}): TrashDeps => ({
    host: testHost(),
    paths: box.paths,
    env: env(),
    log: () => {},
    ...over,
  });
  const keptOffload = async () => {
    config('[offload]\nkeepLocalFor = "1h"');
    value(await offloadNow());
    const [journal] = (await journals()) as OffloadJournal[];
    return journal as OffloadJournal;
  };
  const after = (journal: OffloadJournal) => new Date(Date.parse(journal.keepUntil as string) + 1000);

  test("a trash past its deadline is deleted with its journal; one before it is kept", async () => {
    const journal = await keptOffload();
    const early = value(await collectTrash(trashDeps(), { early: false }));
    expect(early.deleted).toEqual([]);
    expect(early.kept.map((k) => [k.op, k.keepUntil])).toEqual([[journal.op, journal.keepUntil]]);
    expect(trashes()).toHaveLength(1);
    const late = value(await collectTrash(trashDeps({ now: () => after(journal) }), { early: false }));
    expect(late.deleted.map((d) => d.op)).toEqual([journal.op]);
    expect(late.freedBytes).toBeGreaterThan(400);
    expect(trashes()).toEqual([]);
    expect(await journals()).toEqual([]);
    await expectShelved();
    await expectInvariants();
  });

  test("--now (early) deletes a kept trash before its deadline", async () => {
    await keptOffload();
    const report = value(await collectTrash(trashDeps(), { early: true }));
    expect(report.deleted).toHaveLength(1);
    expect(trashes()).toEqual([]);
    await expectInvariants();
  });

  test("gc takes the project's lock: a held one deletes nothing (project.locked, 11)", async () => {
    const journal = await keptOffload();
    const held = value(
      await acquireLock(testHost(), join(box.paths.locksDir, `${journal.project.id}.lock`), {
        timeoutMs: 0,
        held: () => finding("project.locked", { message: "held" }),
      }),
    );
    try {
      const result = await collectTrash(trashDeps(), { early: true });
      expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([11, "project.locked"]);
      expect(trashes()).toHaveLength(1);
    } finally {
      await held.release();
    }
  });

  test("a trash an interrupted onload is renaming back is never deleted", async () => {
    await keptOffload();
    const host = testHost({ faults: { at: "onload.begin" } });
    await expect(
      runOnload(onloadDeps(host), { project: await ref(), hydrate: false }),
    ).rejects.toBeInstanceOf(InjectedFault);
    const report = value(await collectTrash(trashDeps(), { early: true }));
    expect(report.deleted).toEqual([]);
    expect(report.kept[0]?.reason).toContain("onload");
    expect(trashes()).toHaveLength(1);
  });

  test("a released trash with no deadline (its detached delete died) is deleted", async () => {
    await crashOffloadAt("offload.release.delete");
    const report = value(await collectTrash(trashDeps(), { early: false }));
    expect(report.deleted).toHaveLength(1);
    expect(trashes()).toEqual([]);
    await expectInvariants();
  });
});

describe("housekeeping at the start of a command (D59)", () => {
  const trashDeps = (over: Partial<TrashDeps> = {}): TrashDeps => ({
    host: testHost(),
    paths: box.paths,
    env: env(),
    log: () => {},
    ...over,
  });

  test("a trash past its deadline gets a detached delete; one before it is left alone", async () => {
    config('[offload]\nkeepLocalFor = "1h"');
    value(await offloadNow());
    const [journal] = (await journals()) as OffloadJournal[];
    expect(await housekeeping(trashDeps())).toEqual({ started: [], notices: [] });
    expect(trashes()).toHaveLength(1);
    const later = new Date(Date.parse(journal?.keepUntil as string) + 1000);
    const done = await housekeeping(trashDeps({ now: () => later }));
    expect(done.started.map((s) => s.op)).toEqual([journal?.op as string]);
    for (let i = 0; i < 400 && (trashes().length > 0 || (await journals()).length > 0); i++)
      await Bun.sleep(25);
    expect(trashes()).toEqual([]);
    expect(await journals()).toEqual([]);
    await expectInvariants();
  });

  test("an interrupted operation gets a notice naming plainport recover, and is left as it is", async () => {
    await crashOffloadAt("offload.committed");
    // A killed process: an injected fault leaves this live process's pid in the journal.
    const crashed = onlyJournal<OffloadJournal>();
    await rewrite({ ...crashed, pid: 99_999_999 });
    expect((await housekeeping(trashDeps())).notices).toHaveLength(1);
    await rewrite(crashed);
    expect((await housekeeping(trashDeps())).notices).toEqual([]);
    await rewrite({ ...crashed, pid: 99_999_999 });
    const done = await housekeeping(trashDeps());
    expect(done.started).toEqual([]);
    expect(done.notices).toHaveLength(1);
    expect(done.notices[0]).toContain("work:web");
    expect(done.notices[0]).toContain("offload.committed");
    expect(done.notices[0]).toContain("plainport recover");
    expect(await journals()).toHaveLength(1);
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
  });

  test("nothing open: nothing done, nothing said", async () => {
    expect(await housekeeping(trashDeps())).toEqual({ started: [], notices: [] });
  });
});

describe("status and ls views: every end state the sagas leave", () => {
  const viewDeps = (over: Partial<ViewDeps> = {}): ViewDeps => ({
    io: testHost(),
    paths: box.paths,
    env: env(),
    device,
    loader: new ConfigLoader(testHost(), box.paths),
    opener,
    openMirror: async () => ({ ok: true, value: mirror }),
    ...over,
  });
  const web = async (over: Partial<ViewDeps> = {}) => {
    const views = value(await projectViews(viewDeps(over)));
    const view = views.projects.find((p) => p.address === "work:web");
    if (view === undefined) throw new Error(`no view of work:web in ${JSON.stringify(views)}`);
    return view;
  };
  const unreachableOpener: StoreOpener = {
    open: async () => {
      const gone = fail(finding("store.unreachable", { message: "the disk is not mounted" }));
      return {
        ok: true,
        value: {
          blob: { ...store, get: async () => gone, stat: async () => gone, list: async () => gone },
          engine,
        },
      };
    },
  };
  const registerWeb = async () => {
    engine.hooks.failNext = {
      snapshot: fail(finding("internal.unexpected", { message: "the first try fails" })),
    };
    expect((await offloadNow()).ok).toBe(false);
  };

  test("local: a registered project here, never offloaded", async () => {
    await registerWeb();
    const view = await web();
    expect([view.state, view.conditions, view.here, view.head]).toEqual(["local", [], true, null]);
    expect(view.dir).toBe(dir);
  });

  test("shelved: offloaded, stub here, the head and its size", async () => {
    const done = value(await offloadNow());
    const view = await web();
    expect([view.state, view.here, view.stub, view.head]).toEqual([
      "shelved",
      false,
      `${dir}.plainport`,
      done.snapshot,
    ]);
    expect(view.bytes).toBeGreaterThan(0);
    expect(view.snapshots).toBe(1);
    expect(view.stale).toBe(false);
  });

  test("conflicted: a fork in the catalog", async () => {
    await registerWeb();
    const id = (await projectId()) as string;
    const rootId = value(await readRegistry(testHost(), box.paths)).roots?.work as string;
    value(await offloadNow().then(() => ok(undefined)));
    for (const s of [ulid(), ulid()])
      value(
        await appendEvent(storeEventLog(store), {
          v: 1,
          id: s,
          op: s,
          type: "offloaded",
          device: ulid(),
          at: "2026-10-02T00:00:00.000Z",
          project: id,
          root: rootId,
          path: "web",
          snapshot: s,
          stored: { ssd: "c".repeat(64) },
          stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
        }),
      );
    expect((await web()).state).toBe("conflicted");
  });

  test("restored-unhydrated: onloaded without its dependencies, and local once they are", async () => {
    value(await offloadNow());
    for (let i = 0; i < 400 && (await journals()).length > 0; i++) await Bun.sleep(25);
    value(await runOnload(onloadDeps(testHost()), { project: await ref(), hydrate: false }));
    const view = await web();
    expect([view.state, view.here, view.stub]).toEqual(["restored-unhydrated", true, undefined]);
    expect(view.lease).toMatchObject({ device: device.id, here: true });
  });

  test("incomplete: the catalog names a snapshot it does not hold", async () => {
    value(await offloadNow());
    const id = (await projectId()) as string;
    const rootId = value(await readRegistry(testHost(), box.paths)).roots?.work as string;
    const s = ulid();
    value(
      await appendEvent(storeEventLog(store), {
        v: 1,
        id: s,
        op: s,
        type: "offloaded",
        device: ulid(),
        at: "2026-10-02T00:00:00.000Z",
        project: id,
        root: rootId,
        path: "web",
        base: ulid(),
        snapshot: s,
        stored: { ssd: "c".repeat(64) },
        stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
      }),
    );
    const view = await web();
    expect(view.conditions).toContain("incomplete");
    expect(view.head).toBeNull();
  });

  test("diverged-after-commit: committed, the folder kept with an edit, no stub", async () => {
    await crashOffloadAt("offload.committed");
    writeFileSync(join(dir, "src/main.ts"), "export const main = 2;\n");
    await recover(recoverDeps());
    const view = await web();
    expect([view.state, view.conditions, view.here, view.stub]).toEqual([
      "local",
      ["diverged-after-commit"],
      true,
      undefined,
    ]);
  });

  test("offloading, interrupted: an open journal, its step and plainport recover", async () => {
    await crashOffloadAt("offload.committed");
    await rewrite({ ...onlyJournal<OffloadJournal>(), pid: 99_999_999 });
    const view = await web();
    expect([view.state, view.conditions, view.journal?.step]).toEqual([
      "offloading",
      ["interrupted"],
      "offload.committed",
    ]);
  });

  test("unavailable: the root's volume is not mounted", async () => {
    value(await offloadNow());
    const absent = `/Volumes/plainport-test-absent-${ulid().toLowerCase()}`;
    box.file(
      ".config/plainport/config.toml",
      readFileSync(join(box.home, ".config/plainport/config.toml"), "utf8").replace(
        'on = { mbp = "~/work" }',
        `on = { mbp = "${absent}/work" }`,
      ),
    );
    const view = await web();
    expect([view.state, view.here]).toEqual(["unavailable", false]);
    expect(view.head).not.toBeNull();
  });

  test("stale and never synced: an unreachable store reads the mirror", async () => {
    value(await offloadNow());
    await web();
    const stale = await web({ opener: unreachableOpener });
    expect([stale.state, stale.stale, stale.conditions]).toEqual(["shelved", true, ["stale"]]);
    expect(stale.syncedAt).toBeDefined();
    expect(stale.head).not.toBeNull();
    // A device that never reached the store: an empty mirror.
    const empty = memoryBlobStore({ createIfAbsent: true });
    const never = await web({
      opener: unreachableOpener,
      openMirror: async () => ({ ok: true, value: empty }),
    });
    expect([never.state, never.stale, never.syncedAt, never.conditions]).toEqual([
      "shelved",
      true,
      undefined,
      ["never-synced"],
    ]);
  });

  test("a project offloaded from another device, never here: shelved, listed by its catalog address", async () => {
    value(await offloadNow());
    const id = (await projectId()) as string;
    // This device forgets it: the registry entry and the stub go.
    const registry = value(await readRegistry(testHost(), box.paths));
    const { [id]: _, ...rest } = registry.projects;
    writeFileSync(box.paths.registryFile, JSON.stringify({ ...registry, projects: rest }));
    const view = await web();
    expect([view.id, view.state]).toEqual([id, "shelved"]);
  });
});

describe("trash deleted twice at once (a detached delete still running)", () => {
  /** A host whose first removeTree finds the tree pulled from under it, as a concurrent rm leaves it. */
  const racing = (): HostPorts => {
    const real = testHost();
    let first = true;
    return {
      ...real,
      fs: {
        ...real.fs,
        removeTree: async (path) => {
          if (!first) return real.fs.removeTree(path);
          first = false;
          await real.fs.removeTree(path);
          throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}/x'`), {
            code: "ENOENT",
          });
        },
      },
    };
  };

  test("gc takes a trash that vanished under it as deleted", async () => {
    await crashOffloadAt("offload.release.delete");
    const gc = await collectTrash(
      { host: racing(), paths: box.paths, env: env(), log: () => {} },
      { early: false },
    );
    expect(gc.ok ? gc.value.deleted.length : gc.finding.code).toBe(1);
    expect(trashes()).toEqual([]);
    await expectInvariants();
  });

  test("recover takes a trash that vanished under it as deleted", async () => {
    await crashOffloadAt("offload.release.delete");
    const host = racing();
    const report = reportOf(await recover(recoverDeps({ host, loader: new ConfigLoader(host, box.paths) })));
    expect(report.operations.map((o) => o.outcome)).toEqual(["trash-deleted"]);
    await expectInvariants();
  });
});

describe("recover: what the smoke found", () => {
  test("the report names the step recover found, not the one it reached", async () => {
    await crashOffloadAt("offload.release.renamed");
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect([op?.step, op?.outcome]).toEqual(["offload.release.trash", "finished"]);
  });

  test("a journal write a kill cut short leaves a temporary file; recover removes it with the journal", async () => {
    await crashOffloadAt("offload.release.renamed");
    const journal = onlyJournal<OffloadJournal>();
    const temp = `${journalFile(box.paths, journal.op)}.99999.0123456789ab.tmp`;
    writeFileSync(temp, "{ half a jour");
    await recover(recoverDeps());
    await waitJournalsGone();
    expect(existsSync(temp)).toBe(false);
    expect(readdirSync(box.paths.journalDir)).toEqual([]);
    await expectInvariants();
  });
});

describe("fix wave r1: an event counts only when it validates (Critical)", () => {
  const tornAt = async (journal: OffloadJournal, bytes: string) =>
    value(await store.put(`meta/v1/events/${journal.event}.json`, new TextEncoder().encode(bytes)));

  test("a torn event at commit.start is no commit: the folder stays, recover rolls back and says why", async () => {
    await crashOffloadAt("offload.commit.start");
    const journal = onlyJournal<OffloadJournal>();
    await tornAt(journal, `{"v":1,"id":"${journal.event}","type":"offl`);
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect([op?.outcome, op?.state, op?.finding?.code]).toEqual([
      "rolled-back",
      "local",
      "catalog.event-skipped",
    ]);
    await expectLocalUntouched();
    await expectInvariants();
  });

  test("with stub = false too: a torn event never releases the folder", async () => {
    config("[offload]\nstub = false");
    await crashOffloadAt("offload.commit.start");
    const journal = onlyJournal<OffloadJournal>();
    await tornAt(journal, `{"v":1,"id":"${journal.event}"`);
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect(op?.outcome).toBe("rolled-back");
    expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe("export const main = 1;\n");
  });

  test("a whole event under the journal's id that is another operation's is no commit either", async () => {
    await crashOffloadAt("offload.commit.start");
    const journal = onlyJournal<OffloadJournal>();
    const other = ulid();
    await tornAt(
      journal,
      `${JSON.stringify({
        v: 1,
        id: journal.event,
        type: "offloaded",
        device: device.id,
        at: "2026-10-02T00:00:00.000Z",
        op: other,
        project: journal.project.id,
        root: journal.project.rootId,
        path: "web",
        snapshot: other,
        stored: { ssd: "e".repeat(64) },
        stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
      })}\n`,
    );
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect(op?.outcome).toBe("rolled-back");
    await expectLocalUntouched();
  });
});

describe("fix wave r1: the store's own identity (D45)", () => {
  test("a store whose meta/v1/store.json names another id is not the journal's: pending, nothing touched", async () => {
    await crashOffloadAt("offload.commit.appended");
    value(
      await store.put(
        "meta/v1/store.json",
        new TextEncoder().encode(`${JSON.stringify({ v: 1, id: ulid() })}\n`),
      ),
    );
    const result = await recover(recoverDeps());
    expect(result.ok ? 0 : result.finding.code).toBe("store.identity-changed");
    expect(reportOf(result).operations.map((o) => o.outcome)).toEqual(["pending"]);
    expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe("export const main = 1;\n");
    expect(await journals()).toHaveLength(1);
  });
});

describe("fix wave r1: a missing root is unavailable, never deleted (unmounted volume)", () => {
  const away = () => join(box.home, "work.away");

  test("recover keeps a released offload's journal while its root is gone, and deletes the trash once it is back", async () => {
    await crashOffloadAt("offload.release.delete");
    renameSync(join(box.home, "work"), away());
    const result = await recover(recoverDeps());
    expect(reportOf(result).operations.map((o) => [o.outcome, o.state])).toEqual([
      ["pending", "unavailable"],
    ]);
    expect(result.ok ? 0 : result.finding.code).toBe("root.path-missing");
    expect(await journals()).toHaveLength(1);
    const gc = await collectTrash(
      { host: testHost(), paths: box.paths, env: env(), log: () => {} },
      { early: true },
    );
    expect(gc.ok ? gc.value.deleted : gc.finding.code).toBe("root.path-missing");
    expect(await journals()).toHaveLength(1);
    renameSync(away(), join(box.home, "work"));
    expect(reportOf(await recover(recoverDeps())).operations.map((o) => o.outcome)).toEqual([
      "trash-deleted",
    ]);
    expect(trashes()).toEqual([]);
    await expectInvariants();
  });

  test("an onload's journal stays while its root is gone", async () => {
    value(await offloadNow());
    for (let i = 0; i < 400 && (await journals()).length > 0; i++) await Bun.sleep(25);
    const host = testHost({ faults: { at: "onload.swap.start" } });
    await expect(
      runOnload(onloadDeps(host), { project: await ref(), hydrate: false }),
    ).rejects.toBeInstanceOf(InjectedFault);
    renameSync(join(box.home, "work"), away());
    const report = reportOf(await recover(recoverDeps()));
    expect(report.operations.map((o) => [o.outcome, o.state])).toEqual([["pending", "unavailable"]]);
    expect(await journals()).toHaveLength(1);
    renameSync(away(), join(box.home, "work"));
    expect(reportOf(await recover(recoverDeps())).operations.map((o) => o.outcome)).toEqual(["rolled-back"]);
    await expectShelved();
    await expectInvariants();
  });
});

describe("fix wave r1: a step this version does not know is never replayed", () => {
  test("an onload journal at an unknown step stays pending (journal.pending); the stub stays", async () => {
    value(await offloadNow());
    for (let i = 0; i < 400 && (await journals()).length > 0; i++) await Bun.sleep(25);
    const host = testHost({ faults: { at: "onload.verified" } });
    await expect(
      runOnload(onloadDeps(host), { project: await ref(), hydrate: false }),
    ).rejects.toBeInstanceOf(InjectedFault);
    await rewrite({ ...onlyJournal<OnloadJournal>(), step: "onload.future-step" });
    const result = await recover(recoverDeps());
    expect(result.ok ? 0 : result.finding.code).toBe("journal.pending");
    expect(reportOf(result).operations.map((o) => o.outcome)).toEqual(["pending"]);
    expect(existsSync(`${dir}.plainport`)).toBe(true);
    expect((await storeEvents()).filter((e) => e.type === "onloaded")).toEqual([]);
  });

  test("an offload journal at an unknown step stays pending too", async () => {
    await crashOffloadAt("offload.committed");
    await rewrite({ ...onlyJournal<OffloadJournal>(), step: "offload.future-step" });
    const result = await recover(recoverDeps());
    expect(result.ok ? 0 : result.finding.code).toBe("journal.pending");
    expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe("export const main = 1;\n");
  });
});

describe("fix wave r1: gc removes abandoned staging (D60)", () => {
  const trashDeps = (): TrashDeps => ({ host: testHost(), paths: box.paths, env: env(), log: () => {} });
  const stagings = (holder = join(box.home, "work/.plainport-staging")): string[] =>
    existsSync(holder) ? readdirSync(holder).filter((n) => !n.startsWith(".")) : [];

  test("an onload's staging whose journal is gone (a lost write) is removed", async () => {
    value(await offloadNow());
    for (let i = 0; i < 400 && (await journals()).length > 0; i++) await Bun.sleep(25);
    const host = testHost({ faults: { at: "onload.restored" } });
    await expect(
      runOnload(onloadDeps(host), { project: await ref(), hydrate: false }),
    ).rejects.toBeInstanceOf(InjectedFault);
    expect(stagings()).toHaveLength(1);
    const kept = value(await collectTrash(trashDeps(), { early: false }));
    expect(kept.staging).toEqual([]);
    expect(stagings()).toHaveLength(1);
    rmSync(journalFile(box.paths, onlyJournal<OnloadJournal>().op));
    const done = value(await collectTrash(trashDeps(), { early: false }));
    expect(done.staging).toHaveLength(1);
    expect(stagings()).toEqual([]);
  });

  const crashedRestore = async () => {
    value(await offloadNow());
    engine.hooks.duringRestore = () => {
      throw new InjectedFault("restore");
    };
    await expect(
      runRestore(
        {
          host: testHost(),
          paths: box.paths,
          device,
          env: env(),
          loader: new ConfigLoader(testHost(), box.paths),
          opener,
          openMirror: async () => ({ ok: true, value: mirror }),
          emit: () => {},
          log: () => {},
        },
        { project: await ref(), to: join(box.home, "old/web") },
      ),
    ).rejects.toBeInstanceOf(InjectedFault);
    engine.hooks.duringRestore = undefined;
  };

  test("a crashed restore's staging is removed once no live operation owns it", async () => {
    await crashedRestore();
    const holder = join(box.home, "old/.plainport-staging");
    expect(stagings(holder)).toHaveLength(1);
    const done = value(await collectTrash(trashDeps(), { early: false }));
    expect(done.staging).toHaveLength(1);
    expect(existsSync(holder)).toBe(false);
    expect(existsSync(join(box.home, "old/web"))).toBe(false);
  });

  test("while the project's lock is held (a restore running), its staging stays", async () => {
    await crashedRestore();
    const id = (await projectId()) as string;
    const held = value(
      await acquireLock(testHost(), join(box.paths.locksDir, `${id}.lock`), {
        timeoutMs: 0,
        held: () => finding("project.locked", { message: "held" }),
      }),
    );
    try {
      await collectTrash(trashDeps(), { early: false });
      expect(stagings(join(box.home, "old/.plainport-staging"))).toHaveLength(1);
    } finally {
      await held.release();
    }
  });
});

describe("fix wave r1: housekeeping checks the reused trash under the lock", () => {
  test("an onload that starts renaming the trash back after the first read keeps it", async () => {
    config('[offload]\nkeepLocalFor = "1h"');
    value(await offloadNow());
    const [offload] = (await journals()) as OffloadJournal[];
    const reuseJournal: OnloadJournal = {
      v: 1,
      op: ulid(),
      kind: "onload",
      step: "onload.begin",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: 99_999_999,
      host: "elsewhere",
      project: { ...(offload as OffloadJournal).project },
      store: (offload as OffloadJournal).store,
      snapshot: (offload as OffloadJournal).op,
      stored: (offload as OffloadJournal).verified as string,
      over: (offload as OffloadJournal).op,
      reuse: { op: (offload as OffloadJournal).op, folder: join(trashes()[0] ?? "", "web") },
      history: [],
    };
    const real = testHost();
    let first = true;
    const host: HostPorts = {
      ...real,
      fs: {
        ...real.fs,
        readdir: async (path) => {
          const names = await real.fs.readdir(path);
          if (first && path === box.paths.journalDir) {
            first = false;
            await writeJournal(real, box.paths, reuseJournal);
          }
          return names;
        },
      },
    };
    const later = new Date(Date.parse((offload as OffloadJournal).keepUntil as string) + 1000);
    const done = await housekeeping({ host, paths: box.paths, env: env(), log: () => {}, now: () => later });
    expect(done.started).toEqual([]);
    expect(trashes()).toHaveLength(1);
  });
});

describe("fix wave r1: views with a broken mirror read the store (D45)", () => {
  const broken = async () => fail(finding("store.failed", { message: "the mirror folder is broken" }));
  const viewDeps = (over: Partial<ViewDeps> = {}): ViewDeps => ({
    io: testHost(),
    paths: box.paths,
    env: env(),
    device,
    loader: new ConfigLoader(testHost(), box.paths),
    opener,
    openMirror: broken,
    ...over,
  });

  test("a catalog-only project is still listed, read from the store directly, not stale", async () => {
    value(await offloadNow());
    const id = (await projectId()) as string;
    const registry = value(await readRegistry(testHost(), box.paths));
    const { [id]: _, ...rest } = registry.projects;
    writeFileSync(box.paths.registryFile, JSON.stringify({ ...registry, projects: rest }));
    const views = value(await projectViews(viewDeps()));
    expect(views.projects.map((p) => [p.address, p.state, p.stale])).toEqual([
      ["work:web", "shelved", false],
    ]);
  });

  test("an unreachable store and a broken mirror: the project's catalog is unread, never reported synced", async () => {
    value(await offloadNow());
    const gone: StoreOpener = {
      open: async () => {
        const failure = fail(finding("store.unreachable", { message: "the disk is not mounted" }));
        return {
          ok: true,
          value: {
            blob: {
              ...store,
              get: async () => failure,
              stat: async () => failure,
              list: async () => failure,
            },
            engine,
          },
        };
      },
    };
    const views = value(await projectViews(viewDeps({ opener: gone })));
    const [web] = views.projects;
    expect([web?.stale, web?.conditions]).toEqual([true, ["catalog-unreadable"]]);
  });
});

describe("fix wave r2: every event recovery relies on must validate", () => {
  const torn = async (id: string) =>
    value(await store.put(`meta/v1/events/${id}.json`, new TextEncoder().encode(`{"v":1,"id":"${id}","ty`)));
  const settle = async () => {
    for (let i = 0; i < 400 && (await journals()).length > 0; i++) await Bun.sleep(25);
  };

  test("a torn onloaded event is no record: recover writes a whole one, so the lease is held", async () => {
    value(await offloadNow());
    await settle();
    const host = testHost({ faults: { at: "onload.commit.start" } });
    await expect(
      runOnload(onloadDeps(host), { project: await ref(), hydrate: false }),
    ).rejects.toBeInstanceOf(InjectedFault);
    const journal = onlyJournal<OnloadJournal>();
    await torn(journal.event as string);
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect(op?.outcome).toBe("finished");
    const onloaded = (await storeEvents()).filter((e) => e.type === "onloaded");
    expect(onloaded).toHaveLength(1);
    const id = (await projectId()) as string;
    const state = foldCatalog(await storeEvents()).projects[id];
    expect([state?.status, state?.lease?.device]).toEqual(["local", device.id]);
    await expectInvariants();
  });

  test("a torn snapshot-discarded event is no record: recover writes a whole one before it rolls back (D28)", async () => {
    engine.hooks.duringSnapshot = () => chmodSync(join(dir, "src/main.ts"), 0o000);
    await crashOffloadAt("offload.snapshot.discarded");
    chmodSync(join(dir, "src/main.ts"), 0o644);
    const journal = onlyJournal<OffloadJournal>();
    await torn(journal.discarded?.event as string);
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect(op?.outcome).toBe("rolled-back");
    const id = journal.project.id;
    expect(foldCatalog(await storeEvents()).projects[id]?.discarded).toEqual([journal.op]);
    await expectLocalUntouched();
  });

  test("a torn fork event is no record: recover writes a whole one, so the project shows conflicted", async () => {
    engine.hooks.failNext = {
      snapshot: fail(finding("internal.unexpected", { message: "the first try fails" })),
    };
    expect((await offloadNow()).ok).toBe(false);
    const pid = (await projectId()) as string;
    const rootId = value(await readRegistry(testHost(), box.paths)).roots?.work as string;
    engine.hooks.duringSnapshot = async () => {
      engine.hooks.duringSnapshot = undefined;
      const s = ulid();
      value(
        await appendEvent(storeEventLog(store), {
          v: 1,
          id: s,
          op: s,
          type: "offloaded",
          device: ulid(),
          at: "2026-10-02T00:00:00.000Z",
          project: pid,
          root: rootId,
          path: "web",
          snapshot: s,
          stored: { ssd: "c".repeat(64) },
          stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
        }),
      );
    };
    await crashOffloadAt("offload.diverged");
    const journal = onlyJournal<OffloadJournal>();
    await torn(journal.event as string);
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect([op?.outcome, op?.state]).toEqual(["forked", "conflicted"]);
    expect(foldCatalog(await storeEvents()).projects[pid]?.status).toBe("conflicted");
    await expectLocalUntouched();
  });
});

describe("fix wave r2: a pending operation holds its project's later ones", () => {
  test("a released trash an onload stuck at an unknown step renames back is not deleted", async () => {
    config('[offload]\nkeepLocalFor = "1h"');
    value(await offloadNow());
    const [offload] = (await journals()) as OffloadJournal[];
    const host = testHost({ faults: { at: "onload.begin" } });
    await expect(
      runOnload(onloadDeps(host), { project: await ref(), hydrate: false }),
    ).rejects.toBeInstanceOf(InjectedFault);
    const onload = (await journals()).find((j) => j.kind === "onload") as OnloadJournal;
    expect(onload.reuse?.op).toBe(offload?.op);
    await rewrite({ ...onload, step: "onload.future-step" });
    const later = new Date(Date.parse(offload?.keepUntil as string) + 1000);
    const report = reportOf(await recover(recoverDeps({ now: () => later })));
    expect(report.operations.map((o) => [o.kind, o.outcome])).toEqual([
      ["onload", "pending"],
      ["offload", "pending"],
    ]);
    expect(report.operations[1]?.finding?.message).toContain(onload.op);
    expect(trashes()).toHaveLength(1);
    expect(await journals()).toHaveLength(2);
  });

  test("an interrupted offload whose root is away keeps its journal, even before its snapshot", async () => {
    await crashOffloadAt("offload.planned");
    renameSync(join(box.home, "work"), join(box.home, "work.away"));
    const report = reportOf(await recover(recoverDeps()));
    expect(report.operations.map((o) => [o.outcome, o.state])).toEqual([["pending", "unavailable"]]);
    expect(await journals()).toHaveLength(1);
    renameSync(join(box.home, "work.away"), join(box.home, "work"));
  });
});

describe("fix wave r2: gc never deletes staging it cannot prove unowned, and says what failed", () => {
  const trashDeps = (): TrashDeps => ({ host: testHost(), paths: box.paths, env: env(), log: () => {} });
  const holder = () => join(box.home, "work/.plainport-staging");

  test("an unreadable journal may own any staging: nothing is swept, and gc says why (journal.pending)", async () => {
    mkdirSync(join(holder(), ulid()), { recursive: true });
    mkdirSync(box.paths.journalDir, { recursive: true });
    writeFileSync(journalFile(box.paths, ulid()), "{ not a journal");
    const result = await collectTrash(trashDeps(), { early: false });
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "journal.pending"]);
    expect(readdirSync(holder())).toHaveLength(1);
  });

  test("a staging holder that cannot be read is a coded finding, not an exception", async () => {
    mkdirSync(join(holder(), ulid()), { recursive: true });
    chmodSync(holder(), 0o000);
    try {
      const result = await collectTrash(trashDeps(), { early: false });
      expect(result.ok ? 0 : result.finding.code).toBe("fs.unreadable");
    } finally {
      chmodSync(holder(), 0o755);
    }
  });

  test("a recorded staging folder that cannot be removed fails gc with the finding", async () => {
    value(await offloadNow());
    engine.hooks.duringRestore = () => {
      throw new InjectedFault("restore");
    };
    await expect(
      runRestore(
        {
          host: testHost(),
          paths: box.paths,
          device,
          env: env(),
          loader: new ConfigLoader(testHost(), box.paths),
          opener,
          openMirror: async () => ({ ok: true, value: mirror }),
          emit: () => {},
          log: () => {},
        },
        { project: await ref(), to: join(box.home, "old/web") },
      ),
    ).rejects.toBeInstanceOf(InjectedFault);
    engine.hooks.duringRestore = undefined;
    const real = testHost();
    const failing: HostPorts = {
      ...real,
      fs: {
        ...real.fs,
        removeTree: async (path) => {
          if (path.includes(".plainport-staging"))
            throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
          return real.fs.removeTree(path);
        },
      },
    };
    const result = await collectTrash({ ...trashDeps(), host: failing }, { early: false });
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([1, "fs.write-failed"]);
    expect(readdirSync(join(box.home, "old/.plainport-staging"))).toHaveLength(1);
  });
});

describe("fix wave r2: sizes and the staging record's schema", () => {
  test("a project never offloaded has its folder's size in ls", async () => {
    engine.hooks.failNext = {
      snapshot: fail(finding("internal.unexpected", { message: "the first try fails" })),
    };
    expect((await offloadNow()).ok).toBe(false);
    const views = value(
      await projectViews({
        io: testHost(),
        paths: box.paths,
        env: env(),
        device,
        loader: new ConfigLoader(testHost(), box.paths),
        opener,
        openMirror: async () => ({ ok: true, value: mirror }),
      }),
    );
    expect(views.projects[0]?.bytes).toBeGreaterThan(400);
  });

  test("the staging record is published as a JSON Schema", () => {
    expect(Object.keys(stagingJsonSchemas())).toEqual(["staging-record"]);
    expect(stagingJsonSchemas()["staging-record"]).toMatchObject({ title: "StagingRecord" });
  });
});
