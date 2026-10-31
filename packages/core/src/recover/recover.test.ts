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
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";
import { nodePlugin } from "../../../eco-node/src/index.ts";
import { type CatalogPolicy, encode } from "../catalog/codec.ts";
import { catalogReader } from "../catalog/head.ts";
import { encodeStoreIdentityV2, parseStoreIdentity, STORE_IDENTITY_KEY } from "../catalog/identity.ts";
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
import type { BlobStore } from "../ports/blob-store.ts";
import type { HostPorts } from "../ports/host.ts";
import { InjectedFault } from "../ports/host.ts";
import type { SecretProvider } from "../ports/secrets.ts";
import type { StoreCredentials, StoreOpener } from "../ports/store.ts";
import { readRegistry, updateRegistry } from "../registry.ts";
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
import { type ProjectCondition, projectViews, type ViewDeps } from "../status/projects.ts";
import { setUpStore } from "../store.ts";
import { storeStateFile } from "../stores-state.ts";
import { StubSchema } from "../stub.ts";
import { quietChecks } from "../testing/checks.ts";
import { type FakeEngine, fakeEngine } from "../testing/fake-engine.ts";
import { testHost } from "../testing/host.ts";
import { captureTree, invariantViolations, type TreeCapture } from "../testing/invariants.ts";
import { type MemoryBlobStore, memoryBlobStore } from "../testing/memory-blob-store.ts";
import { makeSandbox, removeSettled, type Sandbox } from "../testing/sandbox.ts";
import { ulid } from "../ulid.ts";
import {
  OFFLOAD_RECOVERY,
  ONLOAD_RECOVERY,
  RECOVER_EXIT_ORDER,
  RECOVERY_RULE_OUTCOMES,
  type RecoverDeps,
  type RecoveryReport,
  recover,
} from "./recover.ts";
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

afterEach(async () => {
  try {
    chmodSync(join(dir, "src/main.ts"), 0o644);
  } catch {}
  // Detached deletes outlive the test that started them and write into the sandbox after it.
  await removeSettled(box.home);
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
      // These runs use the real clock (testHost), so their deadlines are compared with it.
      now: new Date(),
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
/**
 * The trash folders under the root's holder: real folders named by an op, never a `.claim` beside one. A holder that is
 * not there, or goes while it is read (the detached delete removes it once empty, D72), holds none.
 */
const trashes = (): string[] => {
  try {
    return readdirSync(join(box.home, "work/.plainport-trash"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(e.name))
      .map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
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
    // What was stripped is not known any more: the rebuilt event says nothing of it (D73), so it reads as unknown.
    expect(fork?.type === "offloaded" && fork.stats.stripped).toBeUndefined();
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

  test("a crash after F2's base write (offload.release.fork-based, journal at release.trash) keeps the folder (conflicted)", async () => {
    // Another copy's first offload lands after the commit's head check, before release reads the catalog again.
    const otherCopy = async () => {
      const s = ulid();
      value(
        await appendEvent(storeEventLog(store), {
          v: 1,
          id: s,
          op: s,
          type: "offloaded",
          device: ulid(),
          at: new Date().toISOString(),
          project: (await projectId()) as string,
          root: value(await readRegistry(testHost(), box.paths)).roots?.work as string,
          path: "web",
          snapshot: s,
          stored: { ssd: "c".repeat(64) },
          stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
        }),
      );
    };
    const onStep = (step: string) => {
      capture(step);
      if (step !== "offload.committed") return;
      const list = store.list;
      store.list = async (prefix) => {
        store.list = list;
        await otherCopy();
        return list(prefix);
      };
    };
    const host = testHost({ faults: { at: "offload.release.fork-based", onStep } });
    await expect(runOffload(offloadDeps(host), { project: await ref() })).rejects.toBeInstanceOf(
      InjectedFault,
    );
    const journal = onlyJournal<OffloadJournal>();
    expect(journal.step).toBe("offload.release.trash");
    expect(value(await readRegistry(testHost(), box.paths)).projects[journal.project.id]?.base).toBe(
      journal.op,
    );
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect([op?.outcome, op?.state]).toEqual(["forked", "conflicted"]);
    expect(value(await readRegistry(testHost(), box.paths)).projects[journal.project.id]?.base).toBe(
      journal.op,
    );
    await expectLocalUntouched();
    await expectInvariants();
  });

  test("a crash after the fork's base was written (offload.diverged.based) keeps the folder (conflicted)", async () => {
    await registerFirst();
    await otherCopyDuringUpload();
    await crashOffloadAt("offload.diverged.based");
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
    // The release's catalog read (F2), then a crash before the rename: recover reads it again and releases.
    "offload.release.reread": "finished",
    "offload.release.renamed": "finished",
    "offload.release.stub-placed": "finished",
    "offload.release.registry-updated": "finished",
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

  test("a crash at offload.release.detached (journal at offload.release.delete): the live detached delete keeps its claim and finishes (D64)", async () => {
    await crashOffloadAt("offload.release.detached");
    // The detached delete outlives the crash: recover leaves its trash to it while it claims it, or finds it done
    // (trash and claim gone, only the journal left, or nothing left at all).
    const ops = reportOf(await recover(recoverDeps())).operations;
    expect(
      ops.every((o) => ["trash-kept", "trash-deleted"].includes(o.outcome) && o.state === "shelved"),
    ).toBe(true);
    await waitJournalsGone();
    expect(await journals()).toEqual([]);
    await expectShelved();
    await expectInvariants();
  });

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
        "offload.release.detached",
        "offload.root-created",
        "offload.snapshot.discarded.appended",
        "offload.diverged.appended",
        "offload.diverged.based",
        "offload.release.fork-based",
      ].sort(),
    );
    expect(OFFLOAD_STEPS.length).toBe(17);
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
        {
          host,
          paths: box.paths,
          saga,
          clock: () => new Date(),
          log: () => {},
          env: env(),
          stores: async () => ok([]),
        },
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
    expect(await recover(recoverDeps())).toEqual({
      ok: true,
      value: { operations: [], bootstraps: [], unreadable: [] },
    });
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
    // Running: this live process wrote it and holds the project's lock, taken before the journal's last write.
    await rewrite(crashed);
    const held = value(
      await acquireLock(testHost(), join(box.paths.locksDir, `${crashed.project.id}.lock`), {
        timeoutMs: 0,
        held: () => finding("project.locked", { message: "held" }),
        now: () => new Date(Date.parse(crashed.startedAt) - 1000),
      }),
    );
    try {
      expect((await housekeeping(trashDeps())).notices).toEqual([]);
    } finally {
      await held.release();
    }
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

  test("notices only (a read command or a dry run): a trash past its deadline is left, its journal unchanged (D61)", async () => {
    config('[offload]\nkeepLocalFor = "1h"');
    value(await offloadNow());
    const [journal] = (await journals()) as OffloadJournal[];
    const later = new Date(Date.parse(journal?.keepUntil as string) + 1000);
    // Nothing deletes it now, so the notice names plainport gc (D64 revised).
    const done = await housekeeping(trashDeps({ now: () => later }), { deleteDue: false });
    expect(done.started).toEqual([]);
    expect(done.notices).toEqual([expect.stringContaining("plainport gc")]);
    await Bun.sleep(100);
    expect(trashes()).toHaveLength(1);
    expect(await journals()).toEqual([journal as OffloadJournal]);
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
    expect([stale.state, stale.stale, stale.conditions]).toEqual([
      "shelved",
      true,
      ["stale", "store-unreachable"],
    ]);
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
      ["never-synced", "store-unreachable"],
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
      await projectViews(
        {
          io: testHost(),
          paths: box.paths,
          env: env(),
          device,
          loader: new ConfigLoader(testHost(), box.paths),
          opener,
          openMirror: async () => ({ ok: true, value: mirror }),
          plugins: [nodePlugin],
        },
        { sizes: true },
      ),
    );
    // Its folder's size without its dependency folders (node_modules holds 400 bytes).
    expect(views.projects[0]?.bytes).toBeGreaterThan(0);
    expect(views.projects[0]?.bytes).toBeLessThan(400);
  });

  test("the staging record is published as a JSON Schema", () => {
    expect(Object.keys(stagingJsonSchemas())).toEqual(["staging-record", "staging-holder"]);
    expect(stagingJsonSchemas()["staging-record"]).toMatchObject({ title: "StagingRecord" });
  });
});

describe("fix wave r3: an incomplete catalog is no fork (D61)", () => {
  for (const step of ["offload.snapshot.done", "offload.verified"] as const) {
    test(`at ${step}, this op's event with the catalog incomplete stays pending; once the events arrive, it finishes`, async () => {
      // The first offload, then an onload: the second offload's base is the first snapshot.
      value(await offloadNow());
      await waitJournalsGone();
      value(await runOnload(onloadDeps(testHost()), { project: await ref(), hydrate: false }));
      await crashOffloadAt("offload.commit.appended");
      const journal = onlyJournal<OffloadJournal>();
      const { event: _e, verified: _v, ...rest } = journal;
      await rewrite(
        step === "offload.verified" ? { ...rest, verified: journal.verified, step } : { ...rest, step },
      );
      // The store's listing lacks the first offload's event: the catalog names a base it does not hold (D41).
      const first = (await storeEvents()).find((e) => e.type === "offloaded" && e.op !== journal.op);
      const key = `meta/v1/events/${first?.id}.json`;
      const held = store.data.get(key) as Uint8Array;
      store.data.delete(key);
      const before = reportOf(await recover(recoverDeps()));
      expect(before.operations.map((o) => [o.outcome, o.finding?.code])).toEqual([
        ["pending", "catalog.incomplete"],
      ]);
      expect((await journals()).map((j) => [j.op, j.step])).toEqual([[journal.op, step]]);
      expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe("export const main = 1;\n");
      expect(existsSync(`${dir}.plainport`)).toBe(false);
      // The missing event arrives: the commit is the head, so the release finishes and no fork was made.
      store.data.set(key, held);
      const after = reportOf(await recover(recoverDeps()));
      expect(after.operations.map((o) => [o.outcome, o.state])).toEqual([["finished", "shelved"]]);
      const fold = foldCatalog(await storeEvents()).projects[journal.project.id];
      expect([fold?.status, fold?.conflicts, fold?.head]).toEqual(["shelved", [], journal.op]);
      await expectShelved();
      await expectInvariants();
    });
  }
});

describe("fix wave r3: unreadable journals and a reused pid", () => {
  const trashDeps = (): TrashDeps => ({ host: testHost(), paths: box.paths, env: env(), log: () => {} });
  const views = async () =>
    value(
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
  const unreadable = (text: string): string => {
    mkdirSync(box.paths.journalDir, { recursive: true });
    const path = journalFile(box.paths, ulid());
    writeFileSync(path, text);
    return path;
  };
  /** A journal of a later version: its project still reads, the rest does not validate. */
  const later = (id: string, address = "work:web") =>
    unreadable(JSON.stringify({ v: 2, kind: "offload", project: { id, address }, future: true }));

  test("an unreadable journal gets a notice, and shows in its project's view, or every project's when no project reads", async () => {
    value(await offloadNow());
    await waitJournalsGone();
    const id = (await projectId()) as string;
    const named = later(id);
    const notices = (await housekeeping(trashDeps())).notices;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(named);
    expect(notices[0]).toContain("work:web");
    expect(notices[0]).toContain("plainport recover");
    const first = await views();
    expect(first.unreadableJournals).toEqual([named]);
    const web = first.projects.find((p) => p.id === id);
    expect([web?.conditions, web?.unreadableJournals]).toEqual([["journal-unreadable"], [named]]);
    // Another project's leaves this one alone; one whose project cannot be read may be any project's.
    rmSync(named);
    later(ulid(), "work:other");
    expect((await views()).projects.find((p) => p.id === id)?.conditions).toEqual([]);
    const anyone = unreadable("{ not json");
    expect((await housekeeping(trashDeps())).notices.some((n) => n.includes(anyone))).toBe(true);
    const third = (await views()).projects.find((p) => p.id === id);
    expect([third?.conditions, third?.unreadableJournals]).toEqual([["journal-unreadable"], [anyone]]);
  });

  test("an unreadable journal of another project holds only that project; its own, or one of no project, holds this one", async () => {
    await crashOffloadAt("offload.committed");
    const journal = onlyJournal<OffloadJournal>();
    const own = later(journal.project.id);
    const result = await recover(recoverDeps());
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "journal.pending"]);
    expect(reportOf(result).operations.map((o) => o.outcome)).toEqual(["pending"]);
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    rmSync(own);
    const anyone = unreadable("{ not json");
    expect(reportOf(await recover(recoverDeps())).operations.map((o) => o.outcome)).toEqual(["pending"]);
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    rmSync(anyone);
    const other = later(ulid(), "work:other");
    const settled = await recover(recoverDeps());
    expect(settled.ok ? 0 : [settled.exitCode, settled.finding.code]).toEqual([6, "journal.pending"]);
    expect(reportOf(settled).operations.map((o) => o.outcome)).toEqual(["finished"]);
    expect(reportOf(settled).unreadable).toEqual([other]);
    rmSync(other);
    await expectShelved();
    await expectInvariants();
  });

  test("a reused pid does not make an interrupted operation look running: the lock it held decides", async () => {
    await crashOffloadAt("offload.committed");
    const crashed = onlyJournal<OffloadJournal>();
    // pid 1 is alive and never a plainport: without the project's lock held by it, the operation was interrupted.
    await rewrite({ ...crashed, pid: 1 });
    expect((await housekeeping(trashDeps())).notices).toHaveLength(1);
    const view = (await views()).projects.find((p) => p.id === crashed.project.id);
    expect([view?.conditions, view?.journal?.running]).toEqual([["interrupted"], false]);
    // This process's pid, its lock left from before this host booted: interrupted too.
    await rewrite(crashed);
    const stale = value(
      await acquireLock(testHost(), join(box.paths.locksDir, `${crashed.project.id}.lock`), {
        timeoutMs: 0,
        held: () => finding("project.locked", { message: "held" }),
        now: () => new Date(0),
      }),
    );
    try {
      expect((await housekeeping(trashDeps())).notices).toHaveLength(1);
    } finally {
      await stale.release();
    }
    expect(reportOf(await recover(recoverDeps())).operations.map((o) => o.outcome)).toEqual(["finished"]);
    await expectInvariants();
  });
});

describe("fix wave r3: staging gc finds and staging it cannot reach", () => {
  const trashDeps = (): TrashDeps => ({ host: testHost(), paths: box.paths, env: env(), log: () => {} });
  const restoreDeps = () => ({
    host: testHost(),
    paths: box.paths,
    device,
    env: env(),
    loader: new ConfigLoader(testHost(), box.paths),
    opener,
    openMirror: async () => ({ ok: true as const, value: mirror }),
    emit: () => {},
    log: () => {},
  });

  test("an onload --to whose journal was lost before any registry override leaves staging gc removes", async () => {
    value(await offloadNow());
    await waitJournalsGone();
    mkdirSync(join(box.home, "elsewhere"));
    const host = testHost({ faults: { at: "onload.restored" } });
    await expect(
      runOnload(onloadDeps(host), {
        project: await ref(),
        to: join(box.home, "elsewhere/web"),
        hydrate: false,
      }),
    ).rejects.toBeInstanceOf(InjectedFault);
    const holder = join(box.home, "elsewhere/.plainport-staging");
    expect(readdirSync(holder).filter((n) => !n.startsWith("."))).toHaveLength(1);
    // The onload's every write lost (D24): no journal, and the registry has no override for its landing.
    rmSync(box.paths.journalDir, { recursive: true });
    const id = (await projectId()) as string;
    expect(value(await readRegistry(testHost(), box.paths)).projects[id]?.override).toBeUndefined();
    const report = value(await collectTrash(trashDeps(), { early: false }));
    expect(report.staging).toHaveLength(1);
    expect(existsSync(holder) ? readdirSync(holder).filter((n) => !n.startsWith(".")) : []).toEqual([]);
    await expectInvariants();
  });

  test("a crashed restore's staging whose volume is away is reported (root.path-missing), and removed once it is back", async () => {
    value(await offloadNow());
    await waitJournalsGone();
    engine.hooks.duringRestore = () => {
      throw new InjectedFault("restore");
    };
    await expect(
      runRestore(restoreDeps(), { project: await ref(), to: join(box.home, "old/web") }),
    ).rejects.toBeInstanceOf(InjectedFault);
    engine.hooks.duringRestore = undefined;
    renameSync(join(box.home, "old"), join(box.home, "old.away"));
    const away = await collectTrash(trashDeps(), { early: false });
    expect(away.ok ? 0 : [away.exitCode, away.finding.code]).toEqual([6, "root.path-missing"]);
    const kept = (away.ok ? away.value : (away.data as { stagingKept: { staging: string }[] })).stagingKept;
    expect(kept.map((k) => k.staging)).toEqual([
      expect.stringContaining(join(box.home, "old/.plainport-staging")),
    ]);
    renameSync(join(box.home, "old.away"), join(box.home, "old"));
    const back = value(await collectTrash(trashDeps(), { early: false }));
    expect([back.staging.length, back.stagingKept]).toEqual([1, []]);
  });
});

describe("fix wave q1: recover's routing table, Ctrl-C and exit code (D64)", () => {
  const crashApiAt = async (point: string) => {
    box.file("work/api/package.json", `${JSON.stringify({ name: "api" })}\n`);
    box.file("work/api/README.md", "# api\n");
    const host = testHost({ faults: { at: point } });
    await expect(runOffload(offloadDeps(host), { project: await ref("work:api") })).rejects.toBeInstanceOf(
      InjectedFault,
    );
  };

  test("every offload and onload step, and every after-effect seam's step, has exactly one rule with its outcomes", () => {
    expect(Object.keys(OFFLOAD_RECOVERY).sort()).toEqual([...OFFLOAD_STEPS].sort());
    expect(Object.keys(ONLOAD_RECOVERY).sort()).toEqual([...ONLOAD_STEPS].sort());
    for (const step of Object.values(OFFLOAD_AFTER_EFFECT)) expect(OFFLOAD_RECOVERY[step]).toBeDefined();
    for (const step of Object.values(ONLOAD_AFTER_EFFECT)) expect(ONLOAD_RECOVERY[step]).toBeDefined();
    for (const rule of [...Object.values(OFFLOAD_RECOVERY), ...Object.values(ONLOAD_RECOVERY)])
      expect(RECOVERY_RULE_OUTCOMES[rule].length).toBeGreaterThan(0);
    expect(OFFLOAD_RECOVERY["offload.planned"]).toBe("roll-back");
    expect(OFFLOAD_RECOVERY["offload.verified"]).toBe("search-store");
    expect(OFFLOAD_RECOVERY["offload.release.delete"]).toBe("delete-trash");
    expect(ONLOAD_RECOVERY["onload.swap.start"]).toBe("swap-check");
  });

  test("the first Ctrl-C stops recover at the next operation: exit 130, the rest pending with their journals", async () => {
    await crashApiAt("offload.committed");
    await crashOffloadAt("offload.committed");
    const stop = new AbortController();
    const result = await recover(
      recoverDeps({
        signal: stop.signal,
        log: (_level, message) => {
          if (message.includes(": finished")) stop.abort();
        },
      }),
    );
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([130, "operation.cancelled"]);
    const ops = reportOf(result).operations;
    expect(ops.map((o) => [o.outcome, o.finding?.code])).toEqual([
      ["finished", undefined],
      ["pending", "operation.cancelled"],
    ]);
    // The finished one's detached delete may still hold its journal; the cancelled one keeps its own.
    expect((await journals()).filter((j) => j.project.address === "work:web").map((j) => j.step)).toEqual([
      "offload.committed",
    ]);
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    const again = reportOf(await recover(recoverDeps())).operations;
    expect(again.filter((o) => o.project === "work:web").map((o) => o.outcome)).toEqual(["finished"]);
    await expectInvariants();
  });

  test("the exit code is the most severe across projects: a later diverged-after-commit (8) beats an earlier locked one (11) and an unreadable journal (6)", async () => {
    await crashApiAt("offload.committed");
    await crashOffloadAt("offload.committed");
    writeFileSync(join(dir, "src/main.ts"), "export const main = 2;\n");
    const api = (await journals()).find((j) => j.project.address === "work:api") as Journal;
    mkdirSync(box.paths.journalDir, { recursive: true });
    writeFileSync(
      journalFile(box.paths, ulid()),
      JSON.stringify({ v: 2, project: { id: ulid(), address: "work:other" } }),
    );
    const held = value(
      await acquireLock(testHost(), join(box.paths.locksDir, `${api.project.id}.lock`), {
        timeoutMs: 0,
        held: () => finding("project.locked", { message: "held" }),
      }),
    );
    try {
      const result = await recover(recoverDeps());
      expect(reportOf(result).operations.map((o) => [o.project, o.outcome])).toEqual([
        ["work:api", "pending"],
        ["work:web", "diverged-after-commit"],
      ]);
      expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([
        8,
        "offload.diverged-after-commit",
      ]);
    } finally {
      await held.release();
    }
    expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe("export const main = 2;\n");
  });
});

describe("fix wave q1: one deleter per trash, by its claim (D64)", () => {
  /**
   * A host whose detached delete claims the trash as this live process, then waits for the gate before it deletes,
   * slowly, as a real rm of a large tree does.
   */
  const gated = () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let done: Promise<void> = Promise.resolve();
    const real = testHost();
    const host: HostPorts = {
      ...real,
      deleteTrashDetached: async (trash, journal) => {
        writeFileSync(
          `${trash}.claim`,
          JSON.stringify({
            v: 1,
            pid: process.pid,
            device: device.id,
            bootedAt: real.proc.bootedAtMs(),
            startedAt: new Date().toISOString(),
          }),
        );
        done = (async () => {
          await gate;
          rmSync(trash, { recursive: true, force: true });
          rmSync(`${trash}.claim`, { force: true });
          rmSync(journal, { force: true });
        })();
        return ok({ pid: process.pid });
      },
    };
    return { host, open: () => open(), done: () => done };
  };
  const trashDeps = (host: HostPorts, now?: Date): TrashDeps => ({
    host,
    paths: box.paths,
    env: env(),
    log: () => {},
    ...(now === undefined ? {} : { now: () => now }),
  });
  const files = (path: string): number => {
    let n = 0;
    const walk = (at: string) => {
      for (const e of readdirSync(at, { withFileTypes: true, encoding: "utf8" }))
        if (e.isDirectory()) walk(join(at, e.name));
        else n++;
    };
    walk(path);
    return n;
  };

  test("gc and recover leave a trash a live detached delete has claimed, whole, and take over one whose claimer died", async () => {
    config('[offload]\nkeepLocalFor = "1h"');
    for (let i = 0; i < 2000; i++) box.file(`work/web/node_modules/big/f${i}.js`, "x".repeat(64));
    value(await offloadNow());
    const [journal] = (await journals()) as OffloadJournal[];
    const trash = journal?.trash as string;
    const before = files(trash);
    const later = new Date(Date.parse(journal?.keepUntil as string) + 1000);
    const slow = gated();
    expect((await housekeeping(trashDeps(slow.host, later))).started).toHaveLength(1);
    expect(existsSync(`${trash}.claim`)).toBe(true);
    // The claimer is alive: neither gc nor recover deletes beside it, and nothing fails.
    const gc = value(await collectTrash(trashDeps(testHost(), later), { early: true }));
    expect([gc.deleted, gc.kept.map((k) => k.op)]).toEqual([[], [journal?.op as string]]);
    const rec = await recover(recoverDeps({ now: () => later }));
    expect(rec.ok).toBe(true);
    expect(reportOf(rec).operations.map((o) => o.outcome)).toEqual(["trash-kept"]);
    expect(files(trash)).toBe(before);
    slow.open();
    await slow.done();
    expect(trashes()).toEqual([]);
    expect(await journals()).toEqual([]);
  });

  test("a claim whose process is gone is taken over: gc deletes the trash, the claim and the journal", async () => {
    config('[offload]\nkeepLocalFor = "1h"');
    value(await offloadNow());
    const [journal] = (await journals()) as OffloadJournal[];
    const trash = journal?.trash as string;
    const { keepUntil: _k, ...rest } = journal as OffloadJournal;
    await rewrite(rest);
    writeFileSync(
      `${trash}.claim`,
      JSON.stringify({
        v: 1,
        pid: 99_999_999,
        device: device.id,
        bootedAt: testHost().proc.bootedAtMs(),
        startedAt: new Date().toISOString(),
      }),
    );
    const gc = value(await collectTrash(trashDeps(testHost()), { early: false }));
    expect(gc.deleted.map((d) => d.op)).toEqual([journal?.op as string]);
    expect(trashes()).toEqual([]);
    expect(await journals()).toEqual([]);
    await expectInvariants();
  });
});

describe("fix wave q2: claim edges, the notice for unclaimed due trash, the exit order (D64 revised)", () => {
  const trashDeps = (): TrashDeps => ({ host: testHost(), paths: box.paths, env: env(), log: () => {} });
  /** A released trash with no deadline and no claim: housekeeping dropped keepUntil, then crashed before the spawn. */
  const unclaimed = async (): Promise<OffloadJournal> => {
    config('[offload]\nkeepLocalFor = "1h"');
    value(await offloadNow());
    const [journal] = (await journals()) as OffloadJournal[];
    const { keepUntil: _k, ...rest } = journal as OffloadJournal;
    await rewrite(rest);
    return rest as OffloadJournal;
  };

  test("a detached delete finishing between the trash check and the claim check is not 'nothing is deleting it'", async () => {
    const journal = await unclaimed();
    const trash = journal.trash as string;
    const real = testHost();
    // The first look at the trash finds it; the delete then finishes (trash, then claim, gone) before the claim is read.
    let looked = false;
    const host: typeof real = {
      ...real,
      fs: {
        ...real.fs,
        lstat: async (path: string) => {
          const stat = await real.fs.lstat(path);
          if (path === trash && !looked) {
            looked = true;
            rmSync(trash, { recursive: true, force: true });
          }
          return stat;
        },
      },
    };
    const notices = (await housekeeping({ ...trashDeps(), host }, { deleteDue: false })).notices;
    expect(looked).toBe(true);
    expect(notices).toEqual([]);
  });

  test("a due trash nothing claims (a crash before the claim) is named with plainport gc, in the notice and the view; gc deletes it", async () => {
    const journal = await unclaimed();
    const notices = (await housekeeping(trashDeps(), { deleteDue: false })).notices;
    expect(notices.some((n) => n.includes(journal.trash as string) && n.includes("plainport gc"))).toBe(true);
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
    const web = views.projects.find((p) => p.id === journal.project.id);
    expect(web?.trash.map((t) => [t.deleting, t.due])).toEqual([[false, true]]);
    expect(web?.next?.command).toBe("plainport gc");
    expect(value(await collectTrash(trashDeps(), { early: false })).deleted).toHaveLength(1);
    expect(trashes()).toEqual([]);
    await expectInvariants();
  });

  test("a stray claim tmp file (a delete killed while claiming) goes with the trash", async () => {
    const journal = await unclaimed();
    writeFileSync(`${journal.trash}.claim.tmp`, '{"v":1,"pid":');
    expect(value(await collectTrash(trashDeps(), { early: false })).deleted).toHaveLength(1);
    expect(trashes()).toEqual([]);
  });

  const claimOf = (trash: string, over: Record<string, unknown> = {}) =>
    writeFileSync(
      `${trash}.claim`,
      JSON.stringify({
        v: 1,
        device: device.id,
        pid: process.pid,
        bootedAt: testHost().proc.bootedAtMs(),
        startedAt: new Date().toISOString(),
        ...over,
      }),
    );
  for (const [name, over] of [
    ["another device id", { device: ulid() }],
    ["an earlier boot", { bootedAt: Date.now() - 400 * 86_400_000 }],
    ["a dead pid", { pid: 99_999_999 }],
  ] as const) {
    test(`a claim with ${name} is taken over: gc deletes the trash and the claim`, async () => {
      const journal = await unclaimed();
      claimOf(journal.trash as string, over);
      expect(value(await collectTrash(trashDeps(), { early: false })).deleted).toHaveLength(1);
      expect(trashes()).toEqual([]);
      await expectInvariants();
    });
  }

  test("gc's reason for a live claim names the claim file", async () => {
    const journal = await unclaimed();
    claimOf(journal.trash as string);
    const kept = value(await collectTrash(trashDeps(), { early: false })).kept;
    expect(kept[0]?.reason).toContain(`${journal.trash}.claim`);
  });

  test("recover's exit order is D64's: 130, then 8, 7, 6, 11, 9, 5, 10, 4, 3, 2, 1", () => {
    expect(RECOVER_EXIT_ORDER).toEqual([130, 8, 7, 6, 11, 9, 5, 10, 4, 3, 2, 1]);
  });
});

describe("D67: a released journal whose trash is already gone is finished", () => {
  const trashDeps = (): TrashDeps => ({ host: testHost(), paths: box.paths, env: env(), log: () => {} });
  /** The state a delete killed between removing its claim and its journal leaves: the journal alone. */
  const killedBeforeJournal = async (): Promise<OffloadJournal> => {
    config('[offload]\nkeepLocalFor = "1h"');
    value(await offloadNow());
    const [journal] = (await journals()) as OffloadJournal[];
    const { keepUntil: _k, ...rest } = journal as OffloadJournal;
    await rewrite(rest);
    rmSync(rest.trash as string, { recursive: true });
    return rest as OffloadJournal;
  };

  test("housekeeping says nothing about it; a write command's removes the journal, a read command's leaves it", async () => {
    await killedBeforeJournal();
    const read = await housekeeping(trashDeps(), { deleteDue: false });
    expect(read.notices).toEqual([]);
    expect(await journals()).toHaveLength(1);
    const write = await housekeeping(trashDeps());
    expect([write.notices, write.started]).toEqual([[], []]);
    expect(await journals()).toEqual([]);
    expect(trashes()).toEqual([]);
    await expectInvariants();
  });

  test("gc removes the journal and reports nothing deleted; invariant 3 holds", async () => {
    await killedBeforeJournal();
    const gc = value(await collectTrash(trashDeps(), { early: false }));
    expect([gc.deleted, gc.kept, gc.skipped]).toEqual([[], [], []]);
    expect(await journals()).toEqual([]);
    expect(trashes()).toEqual([]);
    await expectInvariants();
  });
});

describe("orphan claims: a claim whose trash is gone and whose claimer is not live (D64, D67)", () => {
  /** A host in boot session "S", so these rows never depend on whether the runner can read its own. */
  const inS = (): HostPorts => ({ ...testHost(), bootSession: async () => "S" });
  const trashDeps = (): TrashDeps => ({ host: inS(), paths: box.paths, env: env(), log: () => {} });
  const holder = () => join(box.home, "work/.plainport-trash");
  /** `<op>.claim`, its `.claim.boot` and a stray `.claim.tmp`, with no trash folder and no journal. */
  const orphan = async (pid: number): Promise<string> => {
    const trash = join(holder(), ulid());
    mkdirSync(holder(), { recursive: true });
    const startedAt = new Date().toISOString();
    const claim = { v: 1, device: device.id, pid, bootedAt: testHost().proc.bootedAtMs(), startedAt };
    const session = "S";
    writeFileSync(`${trash}.claim`, JSON.stringify(claim));
    writeFileSync(`${trash}.claim.tmp`, JSON.stringify(claim));
    writeFileSync(`${trash}.claim.boot`, JSON.stringify({ v: 1, pid, startedAt, session }));
    return trash;
  };
  const left = (trash: string) =>
    [".claim", ".claim.boot", ".claim.tmp"].filter((suffix) => existsSync(`${trash}${suffix}`));

  test("gc removes a claim with no trash and a dead pid, its .claim.boot and a stray .claim.tmp, then the empty holder", async () => {
    const trash = await orphan(99_999_999);
    value(await collectTrash(trashDeps(), { early: false }));
    expect(left(trash)).toEqual([]);
    expect(existsSync(holder())).toBe(false);
  });

  test("gc keeps a claim with no trash whose claimer is live", async () => {
    const trash = await orphan(process.pid);
    value(await collectTrash(trashDeps(), { early: false }));
    expect(left(trash)).toEqual([".claim", ".claim.boot", ".claim.tmp"]);
  });

  test("housekeeping in a write command removes a dead orphan claim; a read command's leaves it", async () => {
    const dead = await orphan(99_999_999);
    const live = await orphan(process.pid);
    await housekeeping(trashDeps(), { deleteDue: false });
    expect(left(dead)).toEqual([".claim", ".claim.boot", ".claim.tmp"]);
    await housekeeping(trashDeps());
    expect([left(dead), left(live)]).toEqual([[], [".claim", ".claim.boot", ".claim.tmp"]]);
  });

  test("a .plainport-trash that is a symlink (here into the project) is never swept, by gc or housekeeping", async () => {
    const inner = join(dir, "inner");
    mkdirSync(inner);
    symlinkSync(inner, holder());
    const trash = join(holder(), ulid());
    const startedAt = new Date().toISOString();
    const claim = {
      v: 1,
      device: device.id,
      pid: 99_999_999,
      bootedAt: testHost().proc.bootedAtMs(),
      startedAt,
    };
    for (const suffix of [".claim", ".claim.tmp"]) writeFileSync(`${trash}${suffix}`, JSON.stringify(claim));
    writeFileSync(`${trash}.claim.boot`, JSON.stringify({ v: 1, pid: 99_999_999, startedAt, session: "S" }));
    value(await collectTrash(trashDeps(), { early: false }));
    await housekeeping(trashDeps());
    expect(readdirSync(inner).sort()).toEqual(
      [".claim", ".claim.boot", ".claim.tmp"].map((suffix) => `${basename(trash)}${suffix}`).sort(),
    );
  });

  test("a claim file that does not parse, or is no regular file, keeps its op's files; names that only look like claims stay", async () => {
    const torn = await orphan(99_999_999);
    writeFileSync(`${torn}.claim`, "{ torn");
    const tornBoot = await orphan(99_999_999);
    writeFileSync(`${tornBoot}.claim.boot`, '{"v":1,');
    const tornTmp = await orphan(99_999_999);
    writeFileSync(`${tornTmp}.claim.tmp`, '{"v":1,"pid":');
    const folder = await orphan(99_999_999);
    rmSync(`${folder}.claim`);
    mkdirSync(`${folder}.claim`);
    const lookalikes = [`${ulid()}.claim.old`, `${ulid().toLowerCase()}.claim`, `x${ulid()}.claim`];
    for (const name of lookalikes) writeFileSync(join(holder(), name), "{}");
    value(await collectTrash(trashDeps(), { early: false }));
    await housekeeping(trashDeps());
    for (const trash of [torn, tornBoot, tornTmp, folder])
      expect([trash, left(trash)]).toEqual([trash, [".claim", ".claim.boot", ".claim.tmp"]]);
    for (const name of lookalikes) expect(existsSync(join(holder(), name))).toBe(true);
  });

  test("a lone .claim.boot with no trash (a deleter killed between its claim and its .claim.boot, or v0.1.1's) goes", async () => {
    const trash = await orphan(99_999_999);
    rmSync(`${trash}.claim`);
    rmSync(`${trash}.claim.tmp`);
    value(await collectTrash(trashDeps(), { early: false }));
    expect(left(trash)).toEqual([]);
  });

  test("a .claim.boot beside a released trash with no claim (killed before its claim): gc deletes the trash and it", async () => {
    config('[offload]\nkeepLocalFor = "1h"');
    value(await offloadNow());
    const [journal] = (await journals()) as OffloadJournal[];
    const { keepUntil: _k, ...rest } = journal as OffloadJournal;
    await rewrite(rest);
    const trash = rest.trash as string;
    writeFileSync(
      `${trash}.claim.boot`,
      JSON.stringify({ v: 1, pid: process.pid, startedAt: new Date().toISOString(), session: "S" }),
    );
    expect(value(await collectTrash(trashDeps(), { early: false })).deleted.map((d) => d.op)).toEqual([
      rest.op,
    ]);
    expect([existsSync(trash), left(trash)]).toEqual([false, []]);
    await expectInvariants();
  });

  test("a holder the sweep removed nothing from is left as it is, empty or not", async () => {
    mkdirSync(holder(), { recursive: true });
    value(await collectTrash(trashDeps(), { early: false }));
    await housekeeping(trashDeps());
    expect(existsSync(holder())).toBe(true);
  });

  test("a claim beside a trash that is still there is no orphan: gc leaves it to the journal's own settling", async () => {
    const trash = await orphan(99_999_999);
    mkdirSync(trash);
    value(await collectTrash(trashDeps(), { early: false }));
    expect(left(trash)).toEqual([".claim", ".claim.boot", ".claim.tmp"]);
    expect(existsSync(trash)).toBe(true);
  });
});

describe("release fixes: expected I/O failures are values, never exceptions (I9, rule 7)", () => {
  const eio = (what: string) => Object.assign(new Error(`EIO: ${what}`), { code: "EIO" });
  const trashDeps = (over: Partial<TrashDeps> = {}): TrashDeps => ({
    host: testHost(),
    paths: box.paths,
    env: env(),
    log: () => {},
    ...over,
  });

  test("gc: a trash that cannot be stat'ed is not taken as finished, and gc reports the guard's refusal (no throw, D87)", async () => {
    config('[offload]\nkeepLocalFor = "1h"');
    value(await offloadNow());
    const trash = join(box.home, "work/.plainport-trash", trashes()[0] as string);
    const real = testHost();
    const host: HostPorts = {
      ...real,
      fs: {
        ...real.fs,
        lstat: async (path) => {
          if (path === trash) throw eio("lstat");
          return real.fs.lstat(path);
        },
      },
    };
    const result = await collectTrash(trashDeps({ host }), { early: true });
    expect(result.ok ? 0 : result.finding.code).toBe("delete.guard-refused");
    expect(trashes()).toHaveLength(1);
    expect(await journals()).toHaveLength(1);
  });

  test("housekeeping: a trash that cannot be stat'ed never throws out of the start of a command", async () => {
    config('[offload]\nkeepLocalFor = "1h"');
    value(await offloadNow());
    const trash = join(box.home, "work/.plainport-trash", trashes()[0] as string);
    const real = testHost();
    const host: HostPorts = {
      ...real,
      fs: {
        ...real.fs,
        lstat: async (path) => {
          if (path === trash) throw eio("lstat");
          return real.fs.lstat(path);
        },
      },
    };
    const later = new Date(Date.now() + 2 * 3_600_000);
    const done = await housekeeping(trashDeps({ host, now: () => later }), { deleteDue: false });
    expect(done.notices.join("\n")).toContain("plainport gc deletes it");
  });

  test("recover: a journal that cannot be read again under the lock stays pending with fs.unreadable, not exit 0", async () => {
    await crashOffloadAt("offload.verified");
    const journal = onlyJournal();
    const file = join(box.paths.journalDir, `${journal.op}.json`);
    const real = testHost({ faults: { onStep: capture } });
    let reads = 0;
    const host: HostPorts = {
      ...real,
      fs: {
        ...real.fs,
        // The first two reads are recover's listing and the gate's; the third is the read under the lock.
        readText: async (path) => {
          if (path === file && ++reads >= 3) throw eio("read");
          return real.fs.readText(path);
        },
      },
    };
    const result = await recover(recoverDeps({ host }));
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "fs.unreadable"]);
    expect(reportOf(result).operations.map((o) => o.outcome)).toEqual(["pending"]);
    expect((await journals()).map((j) => j.op)).toEqual([journal.op]);
  });

  test("recover: a journal whose keepLocalFor is not a duration is unreadable (journal.pending), never a RangeError", async () => {
    await crashOffloadAt("offload.committed");
    const journal = onlyJournal<OffloadJournal>();
    expect(journal.release?.keepLocalFor).toBe("0");
    const file = join(box.paths.journalDir, `${journal.op}.json`);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.release.keepLocalFor = "soon";
    writeFileSync(file, JSON.stringify(raw));
    const result = await recover(recoverDeps());
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "journal.pending"]);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
  });

  test("status: a journal folder that cannot be listed is a finding and a condition, never 'no journals'", async () => {
    await crashOffloadAt("offload.verified");
    const real = testHost();
    const io: HostPorts = {
      ...real,
      fs: {
        ...real.fs,
        readdir: async (path) => {
          if (path === box.paths.journalDir) throw eio("readdir");
          return real.fs.readdir(path);
        },
      },
    };
    const views = value(
      await projectViews({
        io,
        paths: box.paths,
        env: env(),
        device,
        loader: new ConfigLoader(real, box.paths),
        opener,
        openMirror: async () => ({ ok: true, value: mirror }),
      }),
    );
    expect(views.findings.map((f) => f.code)).toContain("fs.unreadable");
    const web = views.projects.find((p) => p.address === "work:web");
    expect(web?.conditions).toContain("journal-unreadable");
    expect(web?.next?.command).toBe("plainport recover");
  });
});

describe("recover: release never moves a folder holding a store (D83)", () => {
  test("a store that appeared inside the project after the commit keeps the release pending; moved away, it finishes", async () => {
    await crashOffloadAt("offload.committed");
    box.file("work/web/node_modules/.vault/data/snap", "repository bytes");
    config('[stores.vault]\nkind = "local"\npath = "~/work/web/node_modules/.vault"');
    const stuck = await recover(recoverDeps());
    expect(stuck.ok ? 0 : [stuck.exitCode, stuck.finding.code]).toEqual([6, "store.inside-project"]);
    expect(reportOf(stuck).operations.map((o) => o.outcome)).toEqual(["pending"]);
    expect(readFileSync(join(dir, "node_modules/.vault/data/snap"), "utf8")).toBe("repository bytes");
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    expect(trashes()).toEqual([]);
    config();
    const done = reportOf(await recover(recoverDeps()));
    expect(done.operations.map((o) => o.outcome)).toEqual(["finished"]);
  });
});

describe("D84: plainport's holders are never a working copy's place, and gc never deletes one there", () => {
  const trashDeps = (): TrashDeps => ({ host: testHost(), paths: box.paths, env: env(), log: () => {} });
  const holderChild = () => join(box.home, "work/.plainport-staging", ulid());

  test("onload --to and restore --to into a .plainport-* holder are path.reserved; nothing lands there", async () => {
    value(await offloadNow());
    await waitJournalsGone();
    const to = holderChild();
    const onload = await runOnload(onloadDeps(testHost()), { project: await ref(), to, hydrate: false });
    expect(onload.ok ? 0 : [onload.exitCode, onload.finding.code]).toEqual([6, "path.reserved"]);
    const restore = await runRestore(
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
      { project: await ref(), to: join(box.home, "old/.plainport-trash/web") },
    );
    expect(restore.ok ? 0 : restore.finding.code).toBe("path.reserved");
    expect(existsSync(to)).toBe(false);
    expect(existsSync(join(box.home, "old/.plainport-trash"))).toBe(false);
  });

  /** A working copy an earlier build onloaded into a staging holder: registered there, then edited. */
  const workingCopyInHolder = async () => {
    value(await offloadNow());
    await waitJournalsGone();
    const elsewhere = join(box.home, "old/web");
    mkdirSync(join(box.home, "old"), { recursive: true });
    value(await runOnload(onloadDeps(testHost()), { project: await ref(), to: elsewhere, hydrate: false }));
    const landed = holderChild();
    mkdirSync(join(box.home, "work/.plainport-staging"), { recursive: true });
    renameSync(elsewhere, landed);
    const id = (await projectId()) as string;
    value(
      await updateRegistry(testHost(), box.paths, (registry) => {
        const entry = registry.projects[id];
        if (entry === undefined) throw new Error("not registered");
        return ok({ ...registry, projects: { ...registry.projects, [id]: { ...entry, override: landed } } });
      }),
    );
    writeFileSync(join(landed, "src/main.ts"), "export const main = 2; // an edit no snapshot has\n");
    return { landed, id };
  };

  test("gc fails closed: a registered working copy in a staging holder is kept and reported, never deleted", async () => {
    const { landed } = await workingCopyInHolder();
    const result = await collectTrash(trashDeps(), { early: true });
    expect(result.ok ? 0 : result.finding.code).toBe("project.nested");
    if (!result.ok)
      expect((result.data as { stagingKept: { staging: string }[] }).stagingKept[0]?.staging).toBe(landed);
    expect(readFileSync(join(landed, "src/main.ts"), "utf8")).toContain("an edit no snapshot has");
  });

  test("gc fails closed while the project's lock is live, too", async () => {
    const { landed, id } = await workingCopyInHolder();
    const held = value(
      await acquireLock(testHost(), join(box.paths.locksDir, `${id}.lock`), {
        timeoutMs: 0,
        held: () => finding("project.locked", { message: "held" }),
      }),
    );
    try {
      const result = await collectTrash(trashDeps(), { early: true });
      expect(result.ok).toBe(false);
      expect(readFileSync(join(landed, "src/main.ts"), "utf8")).toContain("an edit no snapshot has");
    } finally {
      await held.release();
    }
  });
});

describe("D87: one guarded deleter (astra r2 findings 1, 3, 4, 5)", () => {
  const trashDeps = (over: Partial<TrashDeps> = {}): TrashDeps => ({
    host: testHost(),
    paths: box.paths,
    env: env(),
    log: () => {},
    ...over,
  });
  /** A store a person would set up: the identity file and a restic repository's layout. */
  const plantStore = (at: string) => {
    mkdirSync(join(at, "meta/v1"), { recursive: true });
    writeFileSync(join(at, "meta/v1/store.json"), '{"v":1}\n');
    mkdirSync(join(at, "keys"), { recursive: true });
    mkdirSync(join(at, "data"), { recursive: true });
    writeFileSync(join(at, "config"), "repository");
  };
  /** Waits for the detached child: its claim gone, or its trash gone. */
  const childDone = async (trash: string) => {
    for (let i = 0; i < 600 && existsSync(`${trash}.claim`); i++) await Bun.sleep(25);
    await Bun.sleep(200);
  };

  test("finding 1: a store moved into excluded output during the final fingerprint scan is never deleted", async () => {
    let armed = false;
    let planted: string | undefined;
    const real = testHost({
      faults: {
        onStep: (step) => {
          capture(step);
          if (step === "offload.release.trash") armed = true;
        },
      },
    });
    const host: HostPorts = {
      ...real,
      fs: {
        ...real.fs,
        // The interleaving: the first look at the folder in the release's fingerprint scan moves a store into the
        // excluded node_modules and points the configuration at it.
        lstat: async (path) => {
          if (armed && path.startsWith(`${realpathSync(dir)}/`)) {
            armed = false;
            planted = join(dir, "node_modules/.archive");
            plantStore(planted);
            config(`[stores.archive]\nkind = "local"\npath = "${planted}"`);
          }
          return real.fs.lstat(path);
        },
      },
    };
    const result = await runOffload(offloadDeps(host), { project: await ref() });
    expect(planted).toBeDefined();
    const [op] = trashes();
    const trash = join(box.home, "work/.plainport-trash", op as string);
    await childDone(trash);
    // Moved with the folder, never deleted: the guard in the detached child refused.
    expect(readFileSync(join(trash, "web/node_modules/.archive/meta/v1/store.json"), "utf8")).toContain(
      '"v":1',
    );
    expect(result.ok || result.finding.code === "delete.guard-refused").toBe(true);
    const gc = await collectTrash(trashDeps(), { early: true });
    expect(gc.ok ? 0 : gc.finding.code).toBe("delete.guard-refused");
    expect(existsSync(join(trash, "web/node_modules/.archive/config"))).toBe(true);
  });

  test("finding 3: a store inside an orphan staging folder is never deleted by gc", async () => {
    const staging = join(box.home, "work/.plainport-staging", ulid());
    plantStore(join(staging, "store"));
    const result = await collectTrash(trashDeps(), { early: false });
    expect(result.ok ? 0 : result.finding.code).toBe("delete.guard-refused");
    expect(existsSync(join(staging, "store/meta/v1/store.json"))).toBe(true);
  });

  test("finding 3: a store inside retained trash survives gc, housekeeping and recover past its deadline", async () => {
    config('[offload]\nkeepLocalFor = "1h"');
    value(await offloadNow());
    const [journal] = (await journals()) as OffloadJournal[];
    const trash = join(box.home, "work/.plainport-trash", (journal as OffloadJournal).op);
    const store = join(trash, "web/.next/archive");
    plantStore(store);
    const later = () => new Date(Date.parse((journal as OffloadJournal).keepUntil as string) + 1000);
    const gc = await collectTrash(trashDeps({ now: later }), { early: false });
    expect(gc.ok ? 0 : gc.finding.code).toBe("delete.guard-refused");
    await housekeeping(trashDeps({ now: later }), { deleteDue: true });
    await childDone(trash);
    const recovered = await recover(recoverDeps({ now: later }));
    expect(recovered.ok ? 0 : recovered.finding.code).toBe("delete.guard-refused");
    expect(existsSync(join(store, "meta/v1/store.json"))).toBe(true);
    expect(existsSync(join(trash, "web/src/main.ts"))).toBe(true);
  });

  test("finding 3: store setup refuses a folder inside a reserved holder", async () => {
    const result = await setUpStore(testHost(), {
      paths: box.paths,
      env: { PLAINPORT_STORE_PASSWORD: "pw" },
      name: "inside",
      store: { kind: "local", path: `~/work/.plainport-staging/${ulid()}` },
      opener,
      mint: () => ulid(),
    });
    expect(result.ok ? 0 : result.finding.code).toBe("path.reserved");
  });

  /** A working copy in a holder whose registered override reaches it through a symlink under ~/aliases. */
  const aliasedCopy = async () => {
    value(await offloadNow());
    await waitJournalsGone();
    mkdirSync(join(box.home, "old"), { recursive: true });
    const elsewhere = join(box.home, "old/web");
    value(await runOnload(onloadDeps(testHost()), { project: await ref(), to: elsewhere, hydrate: false }));
    const landed = join(box.home, "work/.plainport-staging", ulid());
    mkdirSync(dirname(landed), { recursive: true });
    renameSync(elsewhere, landed);
    mkdirSync(join(box.home, "aliases"));
    symlinkSync(landed, join(box.home, "aliases/web"));
    const id = (await projectId()) as string;
    value(
      await updateRegistry(testHost(), box.paths, (registry) => {
        const entry = registry.projects[id];
        if (entry === undefined) throw new Error("not registered");
        return ok({
          ...registry,
          projects: { ...registry.projects, [id]: { ...entry, override: join(box.home, "aliases/web") } },
        });
      }),
    );
    writeFileSync(join(landed, "src/main.ts"), "export const main = 3; // an edit no snapshot has\n");
    chmodSync(join(box.home, "aliases"), 0o000);
    return { landed, id };
  };

  for (const live of [false, true])
    test(`finding 4: an alias that cannot be resolved keeps the working copy in a holder${live ? ", with a live lock" : ""}`, async () => {
      const { landed, id } = await aliasedCopy();
      const held = live
        ? value(
            await acquireLock(testHost(), join(box.paths.locksDir, `${id}.lock`), {
              timeoutMs: 0,
              held: () => finding("project.locked", { message: "held" }),
            }),
          )
        : undefined;
      try {
        const result = await collectTrash(trashDeps(), { early: true });
        expect(result.ok).toBe(false);
        expect(readFileSync(join(landed, "src/main.ts"), "utf8")).toContain("an edit no snapshot has");
      } finally {
        await held?.release();
        chmodSync(join(box.home, "aliases"), 0o755);
      }
    });

  test("finding 5: a configuration that turns invalid after the first load moves nothing; source and store intact", async () => {
    const archive = join(dir, "node_modules/.archive");
    const host = testHost({
      faults: {
        onStep: (step) => {
          capture(step);
          if (step !== "offload.committed") return;
          plantStore(archive);
          box.file(
            ".config/plainport/config.toml",
            `[stores.archive]\nkind = "local"\npath = "${archive}"\n[roots.work\n`,
          );
        },
      },
    });
    const result = await runOffload(offloadDeps(host), { project: await ref() });
    expect(result.ok ? 0 : result.finding.code).toBe("config.invalid");
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    expect(existsSync(join(archive, "meta/v1/store.json"))).toBe(true);
    expect(trashes()).toEqual([]);
  });
});

describe("round 3 minors: a refused detached delete is said, and keeps its deadline (r3 #4, #5)", () => {
  const trashDeps = (over: Partial<TrashDeps> = {}): TrashDeps => ({
    host: testHost(),
    paths: box.paths,
    env: env(),
    log: () => {},
    ...over,
  });
  const plantStore = (at: string) => {
    mkdirSync(join(at, "meta/v1"), { recursive: true });
    writeFileSync(join(at, "meta/v1/store.json"), '{"v":1}\n');
  };
  const childDone = async (trash: string) => {
    for (let i = 0; i < 600 && existsSync(`${trash}.claim`); i++) await Bun.sleep(25);
    for (let i = 0; i < 200 && !existsSync(`${trash}.refused`) && existsSync(trash); i++) await Bun.sleep(25);
  };
  const views = async () =>
    value(
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

  test("#4: the refusing child leaves <op>.refused; housekeeping, status and gc name the reason and the way out", async () => {
    config('[offload]\nkeepLocalFor = "1h"');
    value(await offloadNow());
    const [journal] = (await journals()) as OffloadJournal[];
    const trash = join(box.home, "work/.plainport-trash", (journal as OffloadJournal).op);
    plantStore(join(trash, "web/.next/archive"));
    const later = () => new Date(Date.parse((journal as OffloadJournal).keepUntil as string) + 1000);
    await housekeeping(trashDeps({ now: later }), { deleteDue: true });
    await childDone(trash);
    expect(readFileSync(`${trash}.refused`, "utf8")).toContain("delete.guard-refused");
    const notices = (await housekeeping(trashDeps({ now: later }), { deleteDue: true })).notices.join("\n");
    expect(notices).toContain(`the trash ${trash}`);
    expect(notices).toContain("is a store plainport made");
    expect(notices).toContain("plainport gc");
    const web = (await views()).projects.find((p) => p.address === "work:web");
    expect(web?.trash[0]?.refused?.code).toBe("delete.guard-refused");
    expect(web?.next?.reason).toContain("was not deleted");
    const gc = await collectTrash(trashDeps({ now: later }), { early: false });
    expect(gc.ok ? 0 : gc.finding.fix).toContain("mv ");
    // Moved out, as the fix says: gc deletes it, and the note goes with the trash.
    renameSync(join(trash, "web/.next/archive"), join(box.home, "kept-store"));
    value(await collectTrash(trashDeps({ now: later }), { early: false }));
    expect(existsSync(trash)).toBe(false);
    expect(existsSync(`${trash}.refused`)).toBe(false);
  });

  test("#5: a refused detached delete puts back the deadline housekeeping took off, so onload renames the trash back", async () => {
    config('[offload]\nkeepLocalFor = "1h"');
    value(await offloadNow());
    const [journal] = (await journals()) as OffloadJournal[];
    const op = (journal as OffloadJournal).op;
    const keepUntil = (journal as OffloadJournal).keepUntil as string;
    const trash = join(box.home, "work/.plainport-trash", op);
    plantStore(join(trash, "web/.next/archive"));
    const later = () => new Date(Date.parse(keepUntil) + 1000);
    await housekeeping(trashDeps({ now: later }), { deleteDue: true });
    await childDone(trash);
    const [after] = (await journals()) as OffloadJournal[];
    expect([after?.op, after?.step, after?.keepUntil]).toEqual([op, "offload.release.delete", keepUntil]);
    expect(existsSync(join(trash, "web/src/main.ts"))).toBe(true);
  });
});

describe("views read the mirror first, and resolve a secret only for a sealed catalog (Task 13, D108)", () => {
  const viewDeps = (over: Partial<ViewDeps> = {}): ViewDeps => ({
    io: testHost(),
    paths: box.paths,
    env: env(),
    device,
    loader: new ConfigLoader(testHost(), box.paths),
    opener,
    openMirror: async () => ({ ok: true, value: mirror }),
    providerDeadlineMs: 50,
    ...over,
  });
  const web = async (over: Partial<ViewDeps> = {}) => {
    const views = value(await projectViews(viewDeps(over)));
    const view = views.projects.find((p) => p.address === "work:web");
    if (view === undefined) throw new Error(`no view of work:web in ${JSON.stringify(views)}`);
    return view;
  };
  const closed = (code: "store.unreachable" | "store.secret-missing" | "store.seal-key-unavailable") => {
    const failure = fail(finding(code, { message: `${code} for the test`, fix: "fix it" }));
    return { failure, opener: { open: async () => failure } as StoreOpener };
  };
  const gone: StoreOpener = {
    open: async () => {
      const failure = fail(finding("store.unreachable", { message: "the network is down" }));
      return {
        ok: true,
        value: {
          blob: { ...store, get: async () => failure, stat: async () => failure, list: async () => failure },
          engine,
        },
      };
    },
  };
  const hanging: StoreOpener = { open: () => new Promise(() => {}) };

  const cases: [string, StoreOpener, ProjectCondition, string][] = [
    ["network loss", gone, "store-unreachable", "store.unreachable"],
    ["a missing op", closed("store.secret-missing").opener, "secret-unavailable", "store.secret-missing"],
    ["a signed-out op", closed("store.secret-missing").opener, "secret-unavailable", "store.secret-missing"],
    [
      "a denied Keychain read",
      closed("store.secret-missing").opener,
      "secret-unavailable",
      "store.secret-missing",
    ],
    [
      "a missing password",
      closed("store.secret-missing").opener,
      "secret-unavailable",
      "store.secret-missing",
    ],
    ["a provider that never answers", hanging, "secret-unavailable", ""],
    [
      "a key derivation failure",
      closed("store.seal-key-unavailable").opener,
      "seal-key-unavailable",
      "store.seal-key-unavailable",
    ],
  ];

  for (const [name, failing, condition, cause] of cases) {
    test(`${name}: the mirror's project with ${condition}, and a write command refuses`, async () => {
      value(await offloadNow());
      await web();
      const view = await web({ opener: failing });
      expect([view.state, view.stale, view.conditions]).toEqual(["shelved", true, ["stale", condition]]);
      expect(view.head).not.toBeNull();
      const detail = view.conditionDetails.find((d) => d.condition === condition);
      expect(detail?.finding?.code).toBeDefined();
      // Write commands have no provider deadline yet (Q14 bounds views only).
      if (failing === hanging) return;
      // The write path never reads the mirror in place of the store: an onload of the shelved project, then an offload
      // of the local one, each refuse with the store's own cause, never a project-state refusal.
      await waitJournalsGone();
      const onload = await runOnload(
        { ...onloadDeps(testHost()), opener: failing },
        { project: await ref(), hydrate: false },
      );
      expect(onload.ok ? "onloaded" : onload.finding.code).toBe(cause);
      value(await runOnload(onloadDeps(testHost()), { project: await ref(), hydrate: false }));
      const offload = await runOffload(
        { ...offloadDeps(testHost()), opener: failing },
        { project: await ref() },
      );
      expect(offload.ok ? "offloaded" : offload.finding.code).toBe(cause);
      expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    });
  }

  for (const code of ["store.unreachable", "store.secret-missing", "store.seal-key-unavailable"] as const) {
    test(`a catalog read for writing refuses a stale read whatever kept the store away (${code})`, async () => {
      value(await offloadNow());
      await web();
      const unreachable = fail(finding(code, { message: `${code} for the test` }));
      const failing: BlobStore = {
        ...store,
        get: async () => unreachable,
        stat: async () => unreachable,
        list: async () => unreachable,
      };
      const storeId = parseStoreIdentity(store.data.get("meta/v1/store.json") as Uint8Array)?.id as string;
      const read = await catalogReader({
        store: failing,
        mirror,
        storeId,
        storeName: "ssd",
        now: () => new Date(),
        report: () => {},
      })();
      expect(read.ok ? "read" : read.finding.code).toBe(code);
    });
  }

  test("a never-synced store: an empty mirror, never-synced beside the cause", async () => {
    value(await offloadNow());
    const empty = memoryBlobStore({ createIfAbsent: true });
    const view = await web({ opener: gone, openMirror: async () => ({ ok: true, value: empty }) });
    expect([view.stale, view.syncedAt, view.conditions]).toEqual([
      true,
      undefined,
      ["never-synced", "store-unreachable"],
    ]);
  });

  // D108: a plain catalog is refreshed without the secret, as v0.1.1 did; only a sealed one resolves it (D105).
  const watching = (seen: string[], catalog?: CatalogPolicy): StoreOpener => ({
    open: async (n, s, password) => {
      seen.push(password);
      const opened = await opener.open(n, s, password);
      return opened.ok && catalog !== undefined ? { ok: true, value: { ...opened.value, catalog } } : opened;
    },
  });
  const sealedPolicy = (): CatalogPolicy => ({
    seal: "sealed",
    storeId: parseStoreIdentity(store.data.get("meta/v1/store.json") as Uint8Array)?.id as string,
    key: new Uint8Array(32).fill(7),
  });

  // Review phase 5 M2 (judgement c): an S3 store opens only with its key pair, so views resolve the pair (never the
  // restic password, for a plain catalog) within the same deadline.
  const s3Config = () =>
    box.file(
      ".config/plainport/config.toml",
      [
        "version = 1",
        'defaultStore = "ssd"',
        "[stores.ssd]",
        'kind = "s3"',
        'endpoint = "https://s3.example.eu"',
        'bucket = "plainport"',
        'secret = "env:PLAINPORT_STORE_PASSWORD"',
        'accessKeyId = "env:S3_KEY_ID"',
        'secretAccessKey = "env:S3_SECRET"',
        "[roots.work]",
        'store = "ssd"',
        'on = { mbp = "~/work" }',
      ].join("\n"),
    );
  /** Opens as the binary's opener does: an S3 store without its key pair is store.secret-missing. */
  const pairing = (seen: [string, StoreCredentials | undefined][]): StoreOpener => ({
    open: async (n, s, password, credentials) => {
      seen.push([password, credentials]);
      if (s.kind === "s3" && credentials === undefined)
        return fail(finding("store.secret-missing", { message: "no key pair" }));
      return opener.open(n, { kind: "local", path: "~/ssd" }, password);
    },
  });

  test("a plain catalog on an S3 store reads live with its key pair and no restic password (review phase 5 M2)", async () => {
    value(await offloadNow());
    await web();
    s3Config();
    const seen: [string, StoreCredentials | undefined][] = [];
    const view = await web({
      opener: pairing(seen),
      env: { HOME: box.home, PATH, S3_KEY_ID: "key-id", S3_SECRET: "key-secret" },
    });
    expect([view.stale, view.conditions]).toEqual([false, []]);
    expect(seen).toEqual([["", { accessKeyId: "key-id", secretAccessKey: "key-secret" }]]);
    // Without the pair, the mirror, with secret-unavailable.
    const without = await web({ opener: pairing([]), env: { HOME: box.home, PATH } });
    expect([without.stale, without.conditions]).toEqual([true, ["stale", "secret-unavailable"]]);
  });

  // Task 15: keychain: and op: references resolve through the providers the opener carries, under the same deadline;
  // since D108 only a sealed catalog asks for the secret.
  const keychainConfig = () =>
    box.file(
      ".config/plainport/config.toml",
      [
        "version = 1",
        'defaultStore = "ssd"',
        "[stores.ssd]",
        'kind = "local"',
        'path = "~/ssd"',
        'secret = "keychain:plainport/ssd"',
        "[roots.work]",
        'store = "ssd"',
        'on = { mbp = "~/work" }',
      ].join("\n"),
    );
  /** watching(), with a keychain provider on the opener. */
  const withKeychain = (seen: string[], keychain: SecretProvider): StoreOpener => ({
    ...watching(seen, sealedPolicy()),
    secrets: { keychain },
  });

  test("a sealed catalog's keychain: secret resolves through the opener's provider, within the views' deadline", async () => {
    value(await offloadNow());
    keychainConfig();
    const asked: [string, number | undefined][] = [];
    const seen: string[] = [];
    const keychain: SecretProvider = {
      get: async (ref, ctx) => {
        asked.push([ref, ctx?.deadlineMs]);
        return ok("from-keychain");
      },
    };
    const view = await web({ opener: withKeychain(seen, keychain) });
    expect(view.stale).toBe(false);
    expect(asked).toEqual([["keychain:plainport/ssd", 50]]);
    expect(seen).toEqual(["", "from-keychain"]);
  });

  test("a keychain: provider that never answers: secret-unavailable at the deadline, the sealed catalog never read", async () => {
    value(await offloadNow());
    await web();
    keychainConfig();
    const seen: string[] = [];
    const view = await web({ opener: withKeychain(seen, { get: () => new Promise(() => {}) }) });
    expect([view.state, view.stale, view.conditions]).toEqual([
      "shelved",
      true,
      ["stale", "secret-unavailable"],
    ]);
    expect(seen).toEqual([""]);
  });

  test("a plain catalog is read live with no secret: the opener gets none, even when the provider has none", async () => {
    value(await offloadNow());
    await web();
    for (const environment of [env(), { HOME: box.home, PATH }]) {
      const seen: string[] = [];
      const view = await web({ opener: watching(seen), env: environment });
      expect([view.state, view.stale, view.conditions]).toEqual(["shelved", false, []]);
      expect(seen).toEqual([""]);
    }
  });

  test("a sealed catalog resolves the store's secret through its provider, and the opener gets it", async () => {
    value(await offloadNow());
    await web();
    const seen: string[] = [];
    value(await projectViews(viewDeps({ opener: watching(seen, sealedPolicy()) })));
    expect(seen).toEqual(["", "pw"]);
  });

  test("a seal key derivation the views' deadline gives up on is stopped, not left running (review phase 5 r2 M5)", async () => {
    value(await offloadNow());
    await web();
    // The store publishes a sealed catalog; the opener gives no policy, so the views derive the key from restic's.
    const held = parseStoreIdentity(store.data.get(STORE_IDENTITY_KEY) as Uint8Array);
    if (held === undefined) throw new Error("no store identity");
    store.data.set(STORE_IDENTITY_KEY, encodeStoreIdentityV2({ id: held.id, repo: held.repo, seal: "v1" }));
    // This device's pin of the plain policy would refuse the flip first: a device that never pinned it.
    rmSync(storeStateFile(box.paths, held.id), { force: true });
    const signals: AbortSignal[] = [];
    const slowKey: StoreOpener = {
      open: async (n, st, password) => {
        const opened = await opener.open(n, st, password);
        if (!opened.ok) return opened;
        return {
          ok: true,
          value: {
            ...opened.value,
            engine: {
              ...opened.value.engine,
              catalogKey: (_id, ctx) =>
                new Promise((resolve) => {
                  if (ctx?.signal === undefined) return;
                  signals.push(ctx.signal);
                  ctx.signal.addEventListener("abort", () =>
                    resolve(fail(finding("process.cancelled", { message: "stopped" }))),
                  );
                }),
            },
          },
        };
      },
    };
    const view = await web({ opener: slowKey });
    expect(view.stale).toBe(true);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  test("a sealed catalog whose secret the provider does not give: the mirror's state, secret-unavailable", async () => {
    value(await offloadNow());
    await web();
    const seen: string[] = [];
    const view = await web({ opener: watching(seen, sealedPolicy()), env: { HOME: box.home, PATH } });
    expect([view.state, view.stale, view.conditions]).toEqual([
      "shelved",
      true,
      ["stale", "secret-unavailable"],
    ]);
    expect(seen).toEqual([""]);
  });

  test("a refresh that times out never writes the mirror afterwards", async () => {
    value(await offloadNow());
    await web();
    // A new event on the store, which a refresh would copy into the mirror.
    const first = (await storeEvents()).find((e) => e.type === "offloaded");
    const late = ulid();
    value(
      await appendEvent(storeEventLog(store), {
        ...(first as Extract<CatalogEvent, { type: "offloaded" }>),
        id: late,
        op: late,
        snapshot: late,
        base: (first as Extract<CatalogEvent, { type: "offloaded" }>).snapshot,
      }),
    );
    const slow: StoreOpener = {
      open: async () => ({
        ok: true,
        value: {
          blob: {
            ...store,
            list: async (prefix: string) => {
              await Bun.sleep(150);
              return store.list(prefix);
            },
          },
          engine,
        },
      }),
    };
    const before = new Map([...mirror.data].map(([k, v]) => [k, Buffer.from(v).toString("hex")]));
    const view = await web({ opener: slow });
    expect(view.stale).toBe(true);
    await Bun.sleep(400);
    expect(new Map([...mirror.data].map(([k, v]) => [k, Buffer.from(v).toString("hex")]))).toEqual(before);
  });
});

describe("review r1 I2: a sealed event that does not open is never an absent or uncommitted one", () => {
  // Sealed stores are format 2, which recover reads only from Task 18 on; today a sealed event reaches recover as one
  // its policy cannot open (here, sealed on a plain store): catalog.seal-failed, the same finding a wrong key gives.
  const KEY = new Uint8Array(32).fill(7);
  const storeId = (): string => {
    const parsed = parseStoreIdentity(store.data.get("meta/v1/store.json") as Uint8Array);
    if (parsed === undefined) throw new Error("no store identity");
    return parsed.id;
  };
  /** Seals every event on the store in place, and returns how to put the plain bytes back. */
  const sealEvents = async (): Promise<() => void> => {
    const policy = { seal: "sealed" as const, storeId: storeId(), key: KEY };
    const plain = new Map<string, Uint8Array>();
    for (const event of await storeEvents()) {
      const key = `meta/v1/events/${event.id}.json`;
      plain.set(key, store.data.get(key) as Uint8Array);
      store.data.set(key, value(encode(event, policy)));
    }
    return () => {
      for (const [key, bytes] of plain) store.data.set(key, bytes);
    };
  };
  const expectPendingThenFinished = async (unseal: () => void) => {
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect([op?.outcome, op?.finding?.code]).toEqual(["pending", "catalog.seal-failed"]);
    expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe("export const main = 1;\n");
    expect(await journals()).toHaveLength(1);
    unseal();
    const [done] = reportOf(await recover(recoverDeps())).operations;
    expect([done?.outcome, done?.state]).toEqual(["finished", "shelved"]);
    await expectShelved();
  };

  test("commit.start, the event appended but not opening: pending, never rolled back", async () => {
    await crashOffloadAt("offload.commit.appended");
    await expectPendingThenFinished(await sealEvents());
  });

  test("a sealed policy for another store is refused before recover reads or writes the catalog (review r1 I4)", async () => {
    await crashOffloadAt("offload.commit.appended");
    const elsewhere: StoreOpener = {
      open: async () => ({
        ok: true,
        value: { blob: store, engine, catalog: { seal: "sealed", storeId: ulid(), key: KEY } },
      }),
    };
    const [op] = reportOf(await recover(recoverDeps({ opener: elsewhere }))).operations;
    expect([op?.outcome, op?.finding?.code]).toEqual(["pending", "catalog.seal-failed"]);
    expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe("export const main = 1;\n");
    expect((await storeEvents()).filter((e) => e.type === "offloaded")).toHaveLength(1);
  });

  // Review r1 I3: a torn sealed envelope never opens, so it cannot be completed in place; like a torn plain event it
  // is no record, and the onloaded event is written again under a new id, journaled first (DESIGN, Recover).
  test("a torn sealed onloaded event is written again under a new id, never retried in place", async () => {
    const policy = { seal: "sealed" as const, storeId: storeId(), key: KEY };
    const sealedOpener: StoreOpener = {
      open: async () => ({ ok: true, value: { blob: store, engine, catalog: policy } }),
    };
    const host = testHost({ faults: { onStep: capture } });
    value(await runOffload({ ...offloadDeps(host), opener: sealedOpener }, { project: await ref() }));
    await waitJournalsGone();
    const crash = testHost({ faults: { at: "onload.commit.start" } });
    await expect(
      runOnload({ ...onloadDeps(crash), opener: sealedOpener }, { project: await ref(), hydrate: false }),
    ).rejects.toBeInstanceOf(InjectedFault);
    const journal = onlyJournal<OnloadJournal>();
    const whole = value(
      encode(
        {
          v: 1,
          id: journal.event as string,
          type: "onloaded",
          device: device.id,
          at: "2026-10-12T00:00:00.000Z",
          op: journal.op,
          project: journal.project.id,
          root: journal.project.rootId,
          path: journal.project.path,
          base: journal.snapshot,
          ...(journal.over === undefined ? {} : { over: journal.over }),
        } as CatalogEvent,
        policy,
      ),
    );
    store.data.set(`meta/v1/events/${journal.event}.json`, whole.subarray(0, whole.length - 20));
    const [op] = reportOf(await recover(recoverDeps({ opener: sealedOpener }))).operations;
    expect(op?.outcome).toBe("finished");
    const read = value(await readEvents(storeEventLog(store, policy)));
    expect(read.events.filter((e) => e.type === "onloaded").map((e) => e.id)).not.toContain(journal.event);
    expect(read.events.filter((e) => e.type === "onloaded")).toHaveLength(1);
  });

  test("an onloaded event that does not open is never written a second time under a new id", async () => {
    value(await offloadNow());
    await waitJournalsGone();
    const host = testHost({ faults: { at: "onload.commit.appended" } });
    await expect(
      runOnload(onloadDeps(host), { project: await ref(), hydrate: false }),
    ).rejects.toBeInstanceOf(InjectedFault);
    const unseal = await sealEvents();
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect([op?.outcome, op?.finding?.code]).toEqual(["pending", "catalog.seal-failed"]);
    expect(await journals()).toHaveLength(1);
    unseal();
    expect((await storeEvents()).filter((e) => e.type === "onloaded")).toHaveLength(1);
    const [done] = reportOf(await recover(recoverDeps())).operations;
    expect(done?.outcome).toBe("finished");
    expect((await storeEvents()).filter((e) => e.type === "onloaded")).toHaveLength(1);
  });

  // Review r2 #3: an event that does not open but was made before the operation began cannot be its commit, so it
  // does not hold the store search; one made since does.
  for (const [when, outcome] of [
    ["before", "rolled-back"],
    ["after", "pending"],
  ] as const)
    test(`snapshot.done, an unopenable event made ${when} the op began: ${outcome}`, async () => {
      await crashOffloadAt("offload.snapshot.done");
      const journal = onlyJournal<OffloadJournal>();
      // Far from the op either way, whatever clock the test host pins.
      const time = Date.parse(when === "before" ? "2001-01-01T00:00:00.000Z" : "2999-01-01T00:00:00.000Z");
      const id = ulid(time);
      const sealed = value(
        encode(
          {
            v: 1,
            id,
            op: id,
            type: "offloaded",
            device: device.id,
            at: new Date(time).toISOString(),
            project: journal.project.id,
            root: journal.project.rootId,
            path: journal.project.path,
            snapshot: id,
            stored: { ssd: "a".repeat(64) },
            stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
          } as CatalogEvent,
          { seal: "sealed", storeId: storeId(), key: KEY },
        ),
      );
      store.data.set(`meta/v1/events/${id}.json`, sealed);
      const [op] = reportOf(await recover(recoverDeps())).operations;
      expect(op?.outcome).toBe(outcome);
      if (outcome === "pending") expect(op?.finding?.code).toBe("catalog.seal-failed");
      expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe("export const main = 1;\n");
    });

  test("verified, commit.start lost, the event not opening: the store search waits, never rolls back", async () => {
    await crashOffloadAt("offload.commit.appended");
    const journal = onlyJournal<OffloadJournal>();
    const { event: _e, ...rest } = journal;
    await rewrite({ ...rest, step: "offload.verified" });
    await expectPendingThenFinished(await sealEvents());
  });
});

describe("ls merges catalogs by project id (Task 21)", () => {
  const viewDeps = (over: Partial<ViewDeps> = {}): ViewDeps => ({
    io: testHost(),
    paths: box.paths,
    env: env(),
    device,
    loader: new ConfigLoader(testHost(), box.paths),
    opener,
    openMirror: async () => ({ ok: true, value: mirror }),
    providerDeadlineMs: 5_000,
    ...over,
  });

  /** A second store, nas, whose catalog holds the web project too (an offload made there from another copy). */
  const nasHolding = async (names: string[]) => {
    const done = value(await offloadNow());
    await waitJournalsGone();
    const event = value(await readEvents(storeEventLog(store))).events.find((e) => e.type === "offloaded");
    if (event?.type !== "offloaded") throw new Error("no offloaded event");
    config(names.map((n) => `[stores.${n}]\nkind = "local"\npath = "~/nas"`).join("\n"));
    box.dir("nas");
    const nas = memoryBlobStore({ createIfAbsent: true });
    const nasMirror = memoryBlobStore({ createIfAbsent: true });
    const nasId = ulid();
    const both: StoreOpener = {
      open: async (name) => ({ ok: true, value: { blob: names.includes(name) ? nas : store, engine } }),
    };
    value(
      await setUpStore(testHost(), {
        paths: box.paths,
        env: { PLAINPORT_STORE_PASSWORD: "pw" },
        name: names[0] as string,
        store: { kind: "local", path: "~/nas" },
        opener: both,
        mint: () => nasId,
      }),
    );
    for (const name of names.slice(1))
      value(
        await updateRegistry(testHost(), box.paths, (r) => ({
          ok: true,
          value: { ...r, stores: { ...r.stores, [name]: nasId } },
        })),
      );
    const other = ulid();
    value(
      await appendEvent(storeEventLog(nas), {
        ...event,
        id: ulid(),
        op: other,
        snapshot: other,
        stored: { [nasId]: "e".repeat(64) },
      }),
    );
    return {
      done,
      deps: viewDeps({
        opener: both,
        openMirror: async (id) => ({ ok: true, value: id === nasId ? nasMirror : mirror }),
      }),
    };
  };

  test("a project in two stores' catalogs is one row, with several-stores, showing its root's store's", async () => {
    const { done, deps } = await nasHolding(["nas"]);
    const views = value(await projectViews(deps));
    const webs = views.projects.filter((p) => p.address === "work:web");
    expect(webs).toHaveLength(1);
    const [web] = webs;
    expect(web?.conditions).toContain("several-stores");
    expect(web?.store).toBe("ssd");
    expect(web?.head).toBe(done.snapshot);
    expect(web?.conditionDetails.find((d) => d.condition === "several-stores")?.message).toContain(
      "stores ssd and nas",
    );
  });

  test("one store under two names is one catalog: no several-stores", async () => {
    value(await offloadNow());
    await waitJournalsGone();
    config('[stores.disk]\nkind = "local"\npath = "~/ssd"');
    value(
      await updateRegistry(testHost(), box.paths, (r) => ({
        ok: true,
        value: { ...r, stores: { ...r.stores, disk: r.stores?.ssd as string } },
      })),
    );
    const views = value(await projectViews(viewDeps()));
    const webs = views.projects.filter((p) => p.address === "work:web");
    expect(webs.map((w) => w.conditions)).toEqual([[]]);
    expect(views.stores.map((st) => st.name).sort()).toEqual(["disk", "ssd"]);
  });
});

describe("recover: the writer rule on a format-2 store (D104, Q11)", () => {
  /** The store, as v0.2 sets it up or upgrades it: format 2 under the same id (repo/ stays, as an upgrade leaves it). */
  let storeId: string;
  beforeEach(async () => {
    storeId = value(await readRegistry(testHost(), box.paths)).stores?.ssd as string;
    store.data.set(STORE_IDENTITY_KEY, encodeStoreIdentityV2({ id: storeId, repo: "repo", seal: "none" }));
  });

  test("[stored] an offload keys its event's one stored entry by the store's id, never by the alias", async () => {
    value(await offloadNow());
    const [event] = (await storeEvents()).filter((e) => e.type === "offloaded");
    expect(event?.type === "offloaded" && Object.keys(event.stored)).toEqual([storeId]);
    await waitJournalsGone();
    await expectInvariants();
  });

  test("[stored] the snapshot-discarded event recover writes is keyed by the store's id", async () => {
    engine.hooks.duringSnapshot = () => chmodSync(join(dir, "src/main.ts"), 0o000);
    await crashOffloadAt("offload.snapshot.discarded");
    chmodSync(join(dir, "src/main.ts"), 0o644);
    const journal = onlyJournal<OffloadJournal>();
    expect(reportOf(await recover(recoverDeps())).operations[0]?.outcome).toBe("rolled-back");
    const discarded = (await storeEvents()).filter((e) => e.type === "snapshot-discarded");
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatchObject({
      snapshot: journal.op,
      stored: { [storeId]: journal.discarded?.snapshot },
    });
    expect(Object.keys(discarded[0]?.type === "snapshot-discarded" ? discarded[0].stored : {})).toEqual([
      storeId,
    ]);
    await expectLocalUntouched();
    await expectInvariants();
  });

  test("[stored] recover's fork event is keyed by the store's id", async () => {
    engine.hooks.failNext = {
      snapshot: fail(finding("internal.unexpected", { message: "the first try fails" })),
    };
    expect((await offloadNow()).ok).toBe(false);
    const id = (await projectId()) as string;
    const rootId = value(await readRegistry(testHost(), box.paths)).roots?.work as string;
    engine.hooks.duringSnapshot = async () => {
      engine.hooks.duringSnapshot = undefined;
      const other = ulid();
      value(
        await appendEvent(storeEventLog(store), {
          v: 1,
          id: other,
          op: other,
          type: "offloaded",
          device: ulid(),
          at: "2026-10-02T00:00:00.000Z",
          project: id,
          root: rootId,
          path: "web",
          snapshot: other,
          stored: { [storeId]: "c".repeat(64) },
          stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
        }),
      );
    };
    await crashOffloadAt("offload.diverged");
    const journal = onlyJournal<OffloadJournal>();
    const [op] = reportOf(await recover(recoverDeps())).operations;
    expect([op?.outcome, op?.state]).toEqual(["forked", "conflicted"]);
    const fork = (await storeEvents()).find((e) => e.id === journal.event);
    expect(fork?.type === "offloaded" && fork.stored).toEqual({ [storeId]: journal.verified as string });
    await expectLocalUntouched();
    await expectInvariants();
  });
});
