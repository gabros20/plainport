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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fail, finding, type Result } from "@plainport/contract";
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
