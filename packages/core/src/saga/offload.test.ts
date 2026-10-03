// The offload saga against a sandboxed home, a fixture project on disk, an in-memory store and the fake engine (T0).
// Every test that runs the saga to an end checks invariants 1–3 afterwards (testing/invariants.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fail, finding, ok, type Result, type StreamEvent } from "@plainport/contract";
import { nodePlugin } from "../../../eco-node/src/index.ts";
import { appendEvent, type CatalogEvent, foldCatalog, readEvents, storeEventLog } from "../catalog/index.ts";
import { ConfigLoader } from "../config/load.ts";
import { type Device, ensureDevice } from "../device.ts";
import { journalFile, type OffloadJournal, OffloadJournalSchema, readJournals } from "../journal/index.ts";
import { prepareOffload } from "../plan/planner.ts";
import { listPlans, savePlan } from "../plan/store.ts";
import type { HostPorts } from "../ports/host.ts";
import { InjectedFault } from "../ports/host.ts";
import type { StoreOpener } from "../ports/store.ts";
import { readRegistry, updateRegistry } from "../registry.ts";
import { type ProjectRef, resolveProject } from "../roots/address.ts";
import { posixDeleteTrash } from "../spawner.ts";
import { setUpStore } from "../store.ts";
import { StubSchema } from "../stub.ts";
import { quietChecks } from "../testing/checks.ts";
import { type FakeEngine, fakeEngine } from "../testing/fake-engine.ts";
import { testHost } from "../testing/host.ts";
import { captureTree, invariantViolations, type TreeCapture } from "../testing/invariants.ts";
import { type MemoryBlobStore, memoryBlobStore } from "../testing/memory-blob-store.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { isUlid, ulid } from "../ulid.ts";
import * as saga from "./offload.ts";
import { OFFLOAD_STEPS, type OffloadDeps, type OffloadRequest, runOffload } from "./offload.ts";

const PATH = process.env.PATH ?? "/usr/bin:/bin";

let box: Sandbox;
let device: Device;
let store: MemoryBlobStore;
let mirror: MemoryBlobStore;
let engine: FakeEngine;
let dir: string;
let events: StreamEvent[];
let logs: string[];
let steps: string[];
/** The folder as it stood when release began: what invariant 1 checks the committed snapshot against. */
let released: TreeCapture | undefined;
/** Records the folder at the release step; every test host calls it from onStep. */
const capture = (step: string) => {
  if (step === "offload.release.trash") released = captureTree(dir);
};

const opener: StoreOpener = {
  open: async () => ({ ok: true, value: { blob: store, engine } }),
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
  box = makeSandbox("plainport-offload-saga-");
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
  // A small Node project: sources, a .env, a symlink, an exec bit, and dependencies to strip.
  box.file("work/web/package.json", `${JSON.stringify({ name: "web" })}\n`);
  box.file("work/web/package-lock.json", `${JSON.stringify({ lockfileVersion: 3 })}\n`);
  box.file("work/web/src/main.ts", "export const main = 1;\n");
  box.file("work/web/.env", "TOKEN=op://vault/item\n");
  box.file("work/web/run.sh", "#!/bin/sh\necho hi\n");
  chmodSync(join(box.home, "work/web/run.sh"), 0o755);
  box.file("work/web/node_modules/dep/index.js", "x".repeat(4000));
  symlinkSync("src/main.ts", join(box.home, "work/web/main-link"));
  dir = join(box.home, "work/web");
  events = [];
  logs = [];
  steps = [];
  released = undefined;
});

afterEach(() => {
  // A test may leave a file unreadable; restore access so cleanup can remove it.
  for (const path of ["work/web/src", "work/web/src/main.ts", "work/web/secret.txt"]) {
    try {
      chmodSync(join(box.home, path), 0o755);
    } catch {}
  }
  box.cleanup();
});

const deps = (
  over: Partial<OffloadDeps> = {},
  host: HostPorts = testHost({
    faults: {
      onStep: (s) => {
        steps.push(s);
        capture(s);
      },
    },
  }),
): OffloadDeps => ({
  host,
  checks: quietChecks,
  plugins: [nodePlugin],
  paths: box.paths,
  device,
  env: { HOME: box.home, PATH, PLAINPORT_STORE_PASSWORD: "pw" },
  loader: new ConfigLoader(host, box.paths),
  opener,
  openMirror: async () => ({ ok: true, value: mirror }),
  emit: (event) => events.push(event),
  log: (_level, message) => logs.push(message),
  ...over,
});

const ref = async (input = "work:web"): Promise<ProjectRef> => {
  const resolved = await resolveProject(testHost(), box.paths, input, {
    cwd: box.home,
    env: { HOME: box.home },
    device: "mbp",
  });
  if (!resolved.ok) throw new Error(resolved.finding.message);
  return resolved.value;
};

const offload = async (req: Partial<OffloadRequest> = {}, over: Partial<OffloadDeps> = {}) =>
  runOffload(deps(over), { project: await ref(), ...req });

const storeEvents = async (): Promise<CatalogEvent[]> => {
  const read = await readEvents(storeEventLog(store));
  if (!read.ok) throw new Error(read.finding.message);
  return read.value.events;
};

const projectIdOf = async (path: string): Promise<string | undefined> => {
  const registry = await readRegistry(testHost(), box.paths);
  if (!registry.ok) throw new Error(registry.finding.message);
  return Object.entries(registry.value.projects).find(([, e]) => e.path === path)?.[0];
};
const projectId = () => projectIdOf("web");

/** Invariants 1–3 for the web project, or another one (`target`) with its own capture. */
const invariantsOf = async (
  settleMs?: number,
  target: { path: string; released: TreeCapture | undefined } = { path: "web", released },
) =>
  invariantViolations({
    paths: box.paths,
    device: device.id,
    project: { id: await projectIdOf(target.path), dir: join(box.home, "work", target.path) },
    roots: [join(box.home, "work")],
    store: { name: "ssd", blob: store, engine },
    ...(target.released === undefined ? {} : { released: target.released }),
    stripped: ["node_modules"],
    ...(settleMs === undefined ? {} : { settleMs }),
  });

const expectInvariants = async (
  settleMs?: number,
  target?: { path: string; released: TreeCapture | undefined },
) => expect(await invariantsOf(settleMs, target)).toEqual([]);

const expectUntouched = async () => {
  expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
  expect(existsSync(join(dir, "node_modules/dep/index.js"))).toBe(true);
  expect(existsSync(`${dir}.plainport`)).toBe(false);
  expect((await storeEvents()).filter((e) => e.type === "offloaded")).toEqual([]);
  expect((await readJournals(testHost(), box.paths)).journals).toEqual([]);
};

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

const waitGone = async (path: string) => {
  for (let i = 0; i < 200 && existsSync(path); i++) await Bun.sleep(25);
};

describe("offload: the happy path", () => {
  test("snapshots, verifies, commits, then moves the folder aside and leaves a stub", async () => {
    const result = value(await offload());
    expect(isUlid(result.op)).toBe(true);
    expect(result).toMatchObject({ project: "work:web", snapshot: result.op, store: "ssd" });
    expect(result.freedBytes).toBeGreaterThan(4000);

    // The folder is gone from its place; the trash is deleted by a detached process.
    expect(existsSync(dir)).toBe(false);
    await waitGone(join(box.home, "work/.plainport-trash", result.op));
    expect(existsSync(join(box.home, "work/.plainport-trash", result.op))).toBe(false);

    // One snapshot, tagged, with the strip set left out.
    expect(engine.calls).toHaveLength(1);
    const call = engine.calls[0];
    expect(call?.excludes).toEqual(["node_modules"]);
    const id = (await projectId()) as string;
    const events = await storeEvents();
    const rootCreated = events.find((e) => e.type === "root-created");
    expect(rootCreated).toMatchObject({ key: "work", device: device.id, op: result.op });
    const rootId = rootCreated?.root as string;
    expect(call?.tags).toEqual([
      "plainport",
      `plainport:project=${id}`,
      `plainport:root=${rootId}`,
      "plainport:path=web",
      `plainport:op=${result.op}`,
      "plainport:kind=offload",
    ]);
    const snapshot = engine.repository.snapshots[0];
    expect(snapshot?.entries.map((e) => e.path).sort()).toEqual([
      ".env",
      "main-link",
      "package-lock.json",
      "package.json",
      "run.sh",
      "src",
      "src/main.ts",
    ]);

    // The offloaded event: a first offload has no base.
    const offloaded = events.find((e) => e.type === "offloaded");
    expect(offloaded).toMatchObject({
      type: "offloaded",
      project: id,
      root: rootId,
      path: "web",
      device: device.id,
      op: result.op,
      snapshot: result.op,
      stored: { ssd: snapshot?.info.id },
      stats: { files: 5, strippedBytes: 4000, ecosystems: ["node"] },
    });
    expect(offloaded && "base" in offloaded ? offloaded.base : undefined).toBeUndefined();
    expect(foldCatalog(events).projects[id]).toMatchObject({ status: "shelved", head: result.op });

    // The stub matches its schema and names the exact way back.
    const stub = StubSchema.parse(JSON.parse(readFileSync(`${dir}.plainport`, "utf8")));
    expect(stub).toEqual({
      plainport: 1,
      project: id,
      root: "work",
      rootId,
      path: "web",
      store: "ssd",
      snapshot: result.op,
      offloadedAt: expect.any(String),
      bytes: (offloaded?.type === "offloaded" && offloaded.stats.bytes) as number,
      restore: "plainport onload work:web",
    });
    expect(result.stub).toBe(`${dir}.plainport`);

    // This device remembers the root's ULID and the snapshot its copy now is.
    const registry = value(await readRegistry(testHost(), box.paths));
    expect(registry.roots?.work).toBe(rootId);
    expect(registry.projects[id]).toMatchObject({ root: "work", path: "web", base: result.op });

    // Nothing is left open: no journal, no lock.
    expect((await readJournals(testHost(), box.paths)).journals).toEqual([]);
    expect(existsSync(join(box.paths.locksDir, `${id}.lock`))).toBe(false);
    await expectInvariants();
  });

  test("reports every phase in order, and reaches every journal step but discarded once", async () => {
    const result = value(await offload());
    const phases = events.filter((e) => e.type === "phase");
    expect(phases.filter((e) => e.status === "start").map((e) => e.phase)).toEqual([
      "resolve",
      "preflight",
      "scan",
      "plan",
      "snapshot",
      "verify",
      "commit",
      "release",
    ]);
    expect(phases.every((e) => e.op === result.op)).toBe(true);
    expect(steps).toEqual(
      OFFLOAD_STEPS.filter((s) => s !== "offload.snapshot.discarded" && s !== "offload.diverged"),
    );
    await expectInvariants();
  });

  test("the journal is written at every boundary: each step finds its own name on disk", async () => {
    const seen: { step: string; journal: string | undefined }[] = [];
    const host = testHost({
      faults: {
        onStep: (step) => {
          capture(step);
          const names = readdirSync(box.paths.journalDir).filter((n) => n.endsWith(".json"));
          const text =
            names.length === 1 ? readFileSync(join(box.paths.journalDir, names[0] as string), "utf8") : "";
          seen.push({
            step,
            journal: text === "" ? undefined : OffloadJournalSchema.parse(JSON.parse(text)).step,
          });
        },
      },
    });
    value(await runOffload(deps({}, host), { project: await ref() }));
    expect(seen.map((s) => s.step)).toEqual(
      OFFLOAD_STEPS.filter((s) => s !== "offload.snapshot.discarded" && s !== "offload.diverged"),
    );
    for (const { step, journal } of seen) expect(journal).toBe(step);
    await expectInvariants();
  });

  test("keepLocalFor holds the trash with its journal open; nothing deletes it on a timer", async () => {
    config('[offload]\nkeepLocalFor = "24h"');
    const result = value(await offload());
    const trash = join(box.home, "work/.plainport-trash", result.op);
    expect(existsSync(join(trash, "web/src/main.ts"))).toBe(true);
    expect(result.keepUntil).toBeDefined();
    const [journal] = (await readJournals(testHost(), box.paths)).journals;
    expect(journal).toMatchObject({
      op: result.op,
      step: "offload.release.delete",
      trash,
      keepUntil: result.keepUntil,
    });
    await Bun.sleep(100);
    expect(existsSync(trash)).toBe(true);
    await expectInvariants(0);
  });

  test("the next offload of an onloaded copy is made from the head its onload was written over (D43)", async () => {
    const id = ulid();
    const rootId = ulid();
    const s0 = ulid();
    const s1 = ulid();
    const r0 = "a".repeat(64);
    const r1 = "b".repeat(64);
    const common = {
      v: 1 as const,
      device: device.id,
      at: "2026-10-01T00:00:00.000Z",
      project: id,
      root: rootId,
      path: "web",
    };
    const stats = { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] };
    for (const event of [
      { ...common, id: s0, op: s0, type: "offloaded" as const, snapshot: s0, stored: { ssd: r0 }, stats },
      {
        ...common,
        id: s1,
        op: s1,
        type: "offloaded" as const,
        base: s0,
        snapshot: s1,
        stored: { ssd: r1 },
        stats,
      },
      // onload --snapshot s0 over the head s1: the copy is s0's files, but its next offload follows s1.
      { ...common, id: ulid(), op: ulid(), type: "onloaded" as const, base: s0, over: s1 },
    ]) {
      value(await appendEvent(storeEventLog(store), event));
    }
    value(
      await updateRegistry(testHost(), box.paths, (r) => ({
        ok: true,
        value: {
          ...r,
          roots: { work: rootId },
          projects: {
            [id]: { root: "work", path: "web", base: s1, registeredAt: "2026-10-01T00:00:00.000Z" },
          },
        },
      })),
    );
    const result = value(await offload());
    expect(engine.calls[0]?.parent).toBe(r1);
    const offloaded = (await storeEvents()).find((e) => e.type === "offloaded" && e.op === result.op);
    expect(offloaded).toMatchObject({ base: s1, root: rootId });
    // The root keeps the ULID the registry recorded; the catalog lacked its root-created event, so it is written.
    expect((await storeEvents()).filter((e) => e.type === "root-created")).toEqual([
      expect.objectContaining({ root: rootId, key: "work" }),
    ]);
    expect(foldCatalog(await storeEvents()).projects[id]).toMatchObject({
      status: "shelved",
      head: result.op,
    });
    await expectInvariants();
  });
});

describe("offload: an edit during the upload", () => {
  test("is caught by the re-stat; the snapshot is retried once and the retry is what gets committed", async () => {
    engine.hooks.duringSnapshot = (_input, attempt) => {
      if (attempt === 1) writeFileSync(join(dir, "src/main.ts"), "export const main = 2;\n");
    };
    const result = value(await offload());
    expect(engine.calls).toHaveLength(2);
    const [first, second] = engine.repository.snapshots;
    expect(engine.calls[1]?.parent).toBe(first?.info.id);
    const offloaded = (await storeEvents()).find((e) => e.type === "offloaded");
    expect(offloaded).toMatchObject({ snapshot: result.op, stored: { ssd: second?.info.id } });
    expect(new TextDecoder().decode(second?.data.get("src/main.ts"))).toBe("export const main = 2;\n");
    expect(logs.join("\n")).toContain("changed while the snapshot was made");
    await expectInvariants();
  });

  test("an edit during the retry too fails with verify.changed (exit 7); nothing is deleted", async () => {
    engine.hooks.duringSnapshot = (_input, attempt) => {
      writeFileSync(join(dir, "src/main.ts"), `export const main = ${attempt + 10};\n`);
    };
    const result = await offload();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(7);
    expect(result.finding.code).toBe("verify.changed");
    expect(engine.calls).toHaveLength(2);
    await expectUntouched();
    await expectInvariants();
  });
});

describe("offload: unreadable files", () => {
  test("an unreadable file blocks with fs.unreadable before anything is uploaded", async () => {
    box.file("work/web/secret.txt", "s");
    chmodSync(join(dir, "secret.txt"), 0o000);
    const result = await offload();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect([result.exitCode, result.finding.code]).toEqual([6, "fs.unreadable"]);
    expect(engine.calls).toHaveLength(0);
    await expectUntouched();
    await expectInvariants();
  });

  test("a file restic cannot read fails the snapshot (exit 3 is never partial); the snapshot is discarded (D28)", async () => {
    engine.hooks.duringSnapshot = () => chmodSync(join(dir, "src/main.ts"), 0o000);
    const result = await offload();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect([result.exitCode, result.finding.code]).toEqual([6, "restic.unreadable-files"]);
    const incomplete = engine.repository.snapshots[0];
    expect(incomplete?.incomplete).toBe(true);
    const discarded = (await storeEvents()).filter((e) => e.type === "snapshot-discarded");
    expect(discarded).toEqual([
      expect.objectContaining({ snapshot: expect.any(String), stored: { ssd: incomplete?.info.id } }),
    ]);
    expect(steps).toContain("offload.snapshot.discarded");
    chmodSync(join(dir, "src/main.ts"), 0o644);
    await expectUntouched();
    await expectInvariants();
  });
});

describe("offload: verification", () => {
  test("a listing that does not match the scan fails with verify.mismatch (exit 7); nothing is deleted", async () => {
    engine.hooks.listing = (entries) => entries.filter((e) => e.path !== ".env");
    const result = await offload();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect([result.exitCode, result.finding.code]).toEqual([7, "verify.mismatch"]);
    expect(result.finding.message).toContain(".env");
    await expectUntouched();
    await expectInvariants();
  });

  test("a link target that differs from the folder's own readlink fails verification", async () => {
    engine.hooks.listing = (entries) =>
      entries.map((e) => (e.path === "main-link" ? { ...e, linkTarget: "elsewhere" } : e));
    const result = await offload();
    expect(result.ok ? 0 : result.finding.code).toBe("verify.mismatch");
    await expectUntouched();
    await expectInvariants();
  });
});

describe("offload: findings", () => {
  const lockRepo = () => {
    const git = Bun.spawnSync(["git", "init", "-q", dir], {
      env: { PATH, HOME: box.home, GIT_CONFIG_NOSYSTEM: "1" },
    });
    expect(git.exitCode).toBe(0);
    box.file("work/web/.git/index.lock");
  };

  test("a blocker exits 6 with nothing uploaded, and every finding is streamed", async () => {
    lockRepo();
    const result = await offload();
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "git.locked"]);
    expect(engine.calls).toHaveLength(0);
    expect(events.some((e) => e.type === "finding" && e.finding.code === "git.locked")).toBe(true);
    await expectUntouched();
    await expectInvariants();
  });

  test("--allow <code> overrides an allowable blocker", async () => {
    lockRepo();
    const result = await offload({ allow: ["git.locked"] });
    expect(result.ok).toBe(true);
    await expectInvariants();
  });

  test("--allow cannot override a blocker that is not allowable", async () => {
    box.file("work/web/secret.txt", "s");
    chmodSync(join(dir, "secret.txt"), 0o000);
    const result = await offload({ allow: ["fs.unreadable"] });
    expect(result.ok ? 0 : result.finding.code).toBe("fs.unreadable");
    await expectUntouched();
    await expectInvariants();
  });
});

describe("offload: the lock", () => {
  const lockFile = async () => {
    const id = (await projectId()) ?? ulid();
    if ((await projectId()) === undefined) {
      value(
        await updateRegistry(testHost(), box.paths, (r) => ({
          ok: true,
          value: {
            ...r,
            projects: { [id]: { root: "work", path: "web", registeredAt: "2026-10-01T00:00:00.000Z" } },
          },
        })),
      );
    }
    box.dir(".local/state/plainport/locks");
    return join(box.paths.locksDir, `${id}.lock`);
  };

  test("a lock held by a live process exits 11 with nothing done", async () => {
    const holder = {
      pid: process.ppid,
      host: testHost().proc.hostname(),
      startedAt: "2026-10-03T00:00:00.000Z",
    };
    writeFileSync(await lockFile(), `${JSON.stringify(holder)}\n`);
    const result = await offload();
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([11, "project.locked"]);
    expect(engine.calls).toHaveLength(0);
    await expectUntouched();
    await expectInvariants();
  });

  test("a lock left by a dead process is broken", async () => {
    const holder = {
      pid: 2_147_483_000,
      host: testHost().proc.hostname(),
      startedAt: "2026-10-03T00:00:00.000Z",
    };
    writeFileSync(await lockFile(), `${JSON.stringify(holder)}\n`);
    const result = await offload();
    expect(result.ok).toBe(true);
    await expectInvariants();
  });

  test("an interrupted offload's open journal refuses a new one until recover runs", async () => {
    const crashed = offload({}, { host: testHost({ faults: { at: "offload.verified" } }) });
    await expect(crashed).rejects.toBeInstanceOf(InjectedFault);
    const result = await offload();
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "journal.pending"]);
    expect(result.ok ? "" : result.finding.fix).toContain("plainport recover");
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    await expectInvariants();
  });
});

describe("offload: approved plans", () => {
  const plan = async () => {
    const prepared = value(
      await prepareOffload(testHost(), quietChecks, [nodePlugin], {
        dir,
        project: { address: "work:web", root: "work", path: "web" },
        loader: new ConfigLoader(testHost(), box.paths),
        env: { HOME: box.home, PATH },
        now: new Date(),
        storeId: value(await readRegistry(testHost(), box.paths)).stores?.ssd as string,
      }),
    );
    await savePlan(testHost(), box.paths, prepared.plan, new Date());
    return prepared.plan;
  };

  test("a plan whose fingerprint still matches runs", async () => {
    const approved = await plan();
    const result = value(await offload({ plan: approved.id }));
    expect(existsSync(dir)).toBe(false);
    expect(result.snapshot).toBe(result.op);
    await expectInvariants();
  });

  test("a folder changed since the plan exits 6 with plan.stale and a fresh plan to approve; nothing is uploaded", async () => {
    const approved = await plan();
    writeFileSync(join(dir, "src/main.ts"), "changed\n");
    const result = await offload({ plan: approved.id });
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "plan.stale"]);
    const fresh = /--plan ([0-9A-Z]{26})/.exec(result.ok ? "" : (result.finding.fix ?? ""))?.[1];
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(approved.id);
    expect(existsSync(join(box.paths.plansDir, `${fresh}.json`))).toBe(true);
    expect(engine.calls).toHaveLength(0);
    await expectUntouched();
    await expectInvariants();
  });

  test("a plan with a block finding never runs, whatever approved it (D38)", async () => {
    const approved = await plan();
    const file = join(box.paths.plansDir, `${approved.id}.json`);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.plan.findings.push(finding("git.locked", { message: "index.lock exists" }));
    writeFileSync(file, JSON.stringify(saved));
    const result = await offload({ plan: approved.id });
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "git.locked"]);
    expect(engine.calls).toHaveLength(0);
    await expectUntouched();
    await expectInvariants();
  });
});

describe("offload: the head check", () => {
  const otherOffload = async (id: string, rootId: string) => {
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
  const register = async () => {
    const id = ulid();
    const rootId = ulid();
    value(
      await updateRegistry(testHost(), box.paths, (r) => ({
        ok: true,
        value: {
          ...r,
          roots: { work: rootId },
          projects: { [id]: { root: "work", path: "web", registeredAt: "2026-10-01T00:00:00.000Z" } },
        },
      })),
    );
    return { id, rootId };
  };

  test("another copy offloaded since this one came: exit 8 before anything is uploaded", async () => {
    const { id, rootId } = await register();
    await otherOffload(id, rootId);
    const result = await offload();
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([8, "catalog.head-moved"]);
    expect(engine.calls).toHaveLength(0);
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    expect(existsSync(`${dir}.plainport`)).toBe(false);
    await expectInvariants();
  });

  test("a head that moves during the upload keeps the snapshot as a fork, exits 8 and deletes nothing", async () => {
    const { id, rootId } = await register();
    engine.hooks.duringSnapshot = () => otherOffload(id, rootId);
    const result = await offload();
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([8, "catalog.head-moved"]);
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    expect(existsSync(`${dir}.plainport`)).toBe(false);
    const state = foldCatalog(await storeEvents()).projects[id];
    expect(state?.status).toBe("conflicted");
    expect((await readJournals(testHost(), box.paths)).journals).toEqual([]);
    await expectInvariants();
  });
});

describe("offload: the store", () => {
  test("a store this device never set up refuses with store.not-set-up", async () => {
    value(await updateRegistry(testHost(), box.paths, (r) => ({ ok: true, value: { ...r, stores: {} } })));
    const result = await offload();
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "store.not-set-up"]);
    expect(result.ok ? "" : result.finding.fix).toContain("plainport init");
    await expectUntouched();
    await expectInvariants();
  });

  test("an unreachable store fails with exit 9 before anything is uploaded", async () => {
    store.failNext("get");
    const result = await offload();
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([9, "store.unreachable"]);
    expect(engine.calls).toHaveLength(0);
    await expectUntouched();
    await expectInvariants();
  });

  test("a project folder on another volume than its root refuses before the snapshot (fs.cross-volume)", async () => {
    const real = testHost({ faults: { onStep: (s) => steps.push(s) } });
    const host: HostPorts = {
      ...real,
      fs: {
        ...real.fs,
        stat: async (path) => {
          const stat = await real.fs.stat(path);
          return path === dir ? { ...stat, dev: stat.dev + 1 } : stat;
        },
      },
    };
    const result = await runOffload(deps({}, host), { project: await ref() });
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "fs.cross-volume"]);
    expect(engine.calls).toHaveLength(0);
    await expectUntouched();
    await expectInvariants();
  });
});

describe("offload: stopping", () => {
  test("a signal during the upload stops at the next safe point: exit 130, nothing deleted, journal closed", async () => {
    const controller = new AbortController();
    engine.hooks.duringSnapshot = () => controller.abort();
    const result = await offload({}, { signal: controller.signal });
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([130, "operation.cancelled"]);
    await expectUntouched();
    await expectInvariants();
  });

  test("a crash is never caught: the injected fault propagates and the journal stays at its step", async () => {
    const host = testHost({ faults: { at: "offload.release.moved", onStep: capture } });
    const run = runOffload(deps({}, host), { project: await ref() });
    await expect(run).rejects.toBeInstanceOf(InjectedFault);
    const [journal] = (await readJournals(testHost(), box.paths)).journals;
    expect(journal?.step).toBe("offload.release.moved");
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(journal?.trash ?? "", "web/src/main.ts"))).toBe(true);
    expect(existsSync(journalFile(box.paths, journal?.op ?? ""))).toBe(true);
    // Invariants 2 and 3 hold only after recover (Task 14); invariant 1 already holds.
    const violations = await invariantViolations({
      paths: box.paths,
      device: device.id,
      project: { id: await projectId(), dir },
      roots: [join(box.home, "work")],
      store: { name: "ssd", blob: store, engine },
      ...(released === undefined ? {} : { released }),
      stripped: ["node_modules"],
      settleMs: 0,
    });
    expect(violations.filter((v) => v.startsWith("invariant 1"))).toEqual([]);
    // Undo by hand so the sandbox can be removed.
    renameSync(join(journal?.trash ?? "", "web"), dir);
    rmSync(journal?.trash ?? "", { recursive: true, force: true });
  });
});

describe("offload: what is not here", () => {
  test("a shelved project is not offloaded again: project.not-found, pointing at onload", async () => {
    value(await offload());
    const again = await runOffload(deps(), { project: { ...(await ref()), dir } });
    expect(again.ok ? 0 : [again.exitCode, again.finding.code]).toEqual([4, "project.not-found"]);
    expect(again.ok ? "" : again.finding.fix).toBe("it is shelved: plainport onload work:web brings it back");
    expect(engine.calls).toHaveLength(1);
    await expectInvariants();
  });
});

describe("offload: fix wave r1", () => {
  const gitInit = () => {
    const git = Bun.spawnSync(["git", "init", "-q", dir], {
      env: { PATH, HOME: box.home, GIT_CONFIG_NOSYSTEM: "1" },
    });
    expect(git.exitCode).toBe(0);
  };
  const journalNow = () => {
    const names = readdirSync(box.paths.journalDir).filter((n) => n.endsWith(".json"));
    return OffloadJournalSchema.parse(
      JSON.parse(readFileSync(join(box.paths.journalDir, names[0] as string), "utf8")),
    );
  };

  test("the steps, in order: every preparation boundary is journaled, and a fork has a branch of its own", () => {
    expect([...OFFLOAD_STEPS]).toEqual([
      "offload.begin",
      "offload.preflight.done",
      "offload.scan.done",
      "offload.strip.done",
      "offload.planned",
      "offload.snapshot.start",
      "offload.snapshot.discarded",
      "offload.snapshot.done",
      "offload.verified",
      "offload.diverged",
      "offload.commit.start",
      "offload.committed",
      "offload.release.trash",
      "offload.release.moved",
      "offload.release.stub",
      "offload.release.delete",
    ]);
  });

  test("phase events stream as the preparation runs: preflight is over before the scan starts", async () => {
    const seen: string[] = [];
    const host = testHost({
      faults: {
        onStep: (step) => {
          capture(step);
          if (step === "offload.preflight.done")
            seen.push(...events.filter((e) => e.type === "phase").map((e) => `${e.phase}.${e.status}`));
        },
      },
    });
    value(await runOffload(deps({}, host), { project: await ref() }));
    expect(seen).toEqual(["resolve.start", "resolve.end", "preflight.start", "preflight.end"]);
    await expectInvariants();
  });

  test("a retry plans again: a path that stops being regenerable during the upload is kept", async () => {
    engine.hooks.duringSnapshot = (_input, attempt) => {
      if (attempt === 1) box.file("work/web/.plainport.toml", '[strip]\nkeep = ["node_modules"]\n');
    };
    value(await offload());
    expect(engine.calls.map((c) => c.excludes)).toEqual([["node_modules"], []]);
    const committed = engine.repository.snapshots[1];
    expect(committed?.entries.some((e) => e.path === "node_modules/dep/index.js")).toBe(true);
    await expectInvariants();
  });

  test("a retry runs preflight again: a blocker that appears during the upload stops it, nothing deleted", async () => {
    gitInit();
    engine.hooks.duringSnapshot = (_input, attempt) => {
      if (attempt === 1) box.file("work/web/.git/index.lock");
    };
    const result = await offload();
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "git.locked"]);
    expect(engine.calls).toHaveLength(1);
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    expect((await storeEvents()).filter((e) => e.type === "offloaded")).toEqual([]);
    await expectInvariants();
  });

  test("an edit after the plan and before the snapshot is caught right before restic runs", async () => {
    const host = testHost({
      faults: {
        onStep: (step) => {
          if (step === "offload.planned") writeFileSync(join(dir, "src/main.ts"), "late edit\n");
        },
      },
    });
    const result = await runOffload(deps({}, host), { project: await ref() });
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "plan.stale"]);
    expect(engine.calls).toHaveLength(0);
    expect(result.ok ? undefined : result.data).toMatchObject({
      kind: "offload",
      fingerprint: expect.any(String),
    });
    await expectInvariants();
  });

  test("something else at <project>.plainport blocks in preflight (D47); the file is never touched", async () => {
    writeFileSync(`${dir}.plainport`, "my own notes\n");
    const result = await offload();
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "path.stub-occupied"]);
    expect(engine.calls).toHaveLength(0);
    expect(readFileSync(`${dir}.plainport`, "utf8")).toBe("my own notes\n");
    const planned = value(
      await prepareOffload(testHost(), quietChecks, [nodePlugin], {
        dir,
        project: { address: "work:web", root: "work", path: "web" },
        loader: new ConfigLoader(testHost(), box.paths),
        env: { HOME: box.home, PATH },
        now: new Date(),
      }),
    );
    expect(planned.plan.findings.map((f) => f.code)).toContain("path.stub-occupied");
    await expectInvariants();
  });

  test("a plan approved with --keep-deps runs only with --keep-deps; otherwise a fresh plan is the error's data", async () => {
    const prepared = value(
      await prepareOffload(testHost(), quietChecks, [nodePlugin], {
        dir,
        project: { address: "work:web", root: "work", path: "web" },
        loader: new ConfigLoader(testHost(), box.paths),
        env: { HOME: box.home, PATH },
        now: new Date(),
        storeId: value(await readRegistry(testHost(), box.paths)).stores?.ssd as string,
        keepDeps: true,
      }),
    );
    await savePlan(testHost(), box.paths, prepared.plan, new Date());
    const without = await offload({ plan: prepared.plan.id });
    expect(without.ok ? 0 : [without.exitCode, without.finding.code]).toEqual([6, "plan.stale"]);
    expect(without.ok ? undefined : without.data).toMatchObject({
      kind: "offload",
      strip: [expect.objectContaining({ path: "node_modules" })],
      options: { keepDeps: false },
    });
    expect(engine.calls).toHaveLength(0);
    const withAllow = await offload({ plan: prepared.plan.id, keepDeps: true, allow: ["git.locked"] });
    expect(withAllow.ok ? 0 : withAllow.finding.code).toBe("plan.stale");
    value(await offload({ plan: prepared.plan.id, keepDeps: true }));
    expect(engine.calls[0]?.excludes).toEqual([]);
    await expectInvariants();
  });

  test("a config change since the plan (strip.extra) refuses the approved plan", async () => {
    const prepared = value(
      await prepareOffload(testHost(), quietChecks, [nodePlugin], {
        dir,
        project: { address: "work:web", root: "work", path: "web" },
        loader: new ConfigLoader(testHost(), box.paths),
        env: { HOME: box.home, PATH },
        now: new Date(),
        storeId: value(await readRegistry(testHost(), box.paths)).stores?.ssd as string,
      }),
    );
    await savePlan(testHost(), box.paths, prepared.plan, new Date());
    config('[strip]\nextra = ["src"]');
    const result = await offload({ plan: prepared.plan.id });
    expect(result.ok ? 0 : result.finding.code).toBe("plan.stale");
    expect(engine.calls).toHaveLength(0);
    await expectInvariants();
  });

  const forkDuringUpload = async () => {
    const id = ulid();
    const rootId = ulid();
    value(
      await updateRegistry(testHost(), box.paths, (r) => ({
        ok: true,
        value: {
          ...r,
          roots: { work: rootId },
          projects: { [id]: { root: "work", path: "web", registeredAt: "2026-10-01T00:00:00.000Z" } },
        },
      })),
    );
    engine.hooks.duringSnapshot = async () => {
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

  test("a fork takes its own journaled branch, never committed, and exit 8 carries the kept snapshot (D14)", async () => {
    await forkDuringUpload();
    const result = await offload();
    expect(steps).toContain("offload.diverged");
    expect(steps).not.toContain("offload.committed");
    expect(steps).not.toContain("offload.commit.start");
    expect(result.ok ? 0 : result.exitCode).toBe(8);
    const kept = engine.repository.snapshots[0]?.info.id;
    expect(result.ok ? undefined : result.data).toMatchObject({
      exitCode: 8,
      project: "work:web",
      store: "ssd",
      stored: kept,
    });
    await expectInvariants();
  });

  test("a crash on the fork branch leaves a journal that says so", async () => {
    await forkDuringUpload();
    const host = testHost({ faults: { at: "offload.diverged" } });
    await expect(runOffload(deps({}, host), { project: await ref() })).rejects.toBeInstanceOf(InjectedFault);
    expect(journalNow()).toMatchObject({
      step: "offload.diverged",
      diverged: true,
      event: expect.any(String),
    });
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    await expectInvariants();
  });

  test("keepLocalFor and the stub policy are in the journal from the plan on, before anything is released", async () => {
    config('[offload]\nkeepLocalFor = "24h"');
    let atCommit: unknown;
    const host = testHost({
      faults: {
        onStep: (step) => {
          capture(step);
          if (step === "offload.committed") atCommit = journalNow();
        },
      },
    });
    const result = value(await runOffload(deps({}, host), { project: await ref() }));
    expect(atCommit).toMatchObject({ release: { keepLocalFor: "24h", stub: true } });
    expect(result.freedBytes).toBe(0);
    await expectInvariants(0);
  });

  test("a detached delete that cannot start loses nothing: the trash waits for recover, nothing is reported freed", async () => {
    const real = testHost({ faults: { onStep: capture } });
    const host: HostPorts = {
      ...real,
      deleteTrashDetached: async () => fail(finding("process.spawn-failed", { message: "no sh today" })),
    };
    const result = value(await runOffload(deps({}, host), { project: await ref() }));
    expect(result.freedBytes).toBe(0);
    expect(existsSync(join(result.trash, "web/src/main.ts"))).toBe(true);
    expect(journalNow().step).toBe("offload.release.delete");
    expect(logs.join("\n")).toContain("plainport recover");
    // Invariants 1 and 2 hold; 3 holds once recover has deleted the trash (Task 14).
    const violations = await invariantsOf(0);
    expect(violations.filter((v) => !v.startsWith("invariant 3"))).toEqual([]);
    expect(violations).toEqual([expect.stringContaining(`invariant 3: ${result.trash}`)]);
  });

  test("an I/O error in release is a coded failure, never an exception; the journal stays for recover", async () => {
    const real = testHost({ faults: { onStep: capture } });
    const host: HostPorts = {
      ...real,
      fs: {
        ...real.fs,
        rename: async (from, to) => {
          if (from === dir) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
          return real.fs.rename(from, to);
        },
      },
    };
    const result = await runOffload(deps({}, host), { project: await ref() });
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([1, "fs.write-failed"]);
    expect(result.ok ? "" : result.finding.fix).toContain("plainport recover");
    expect(journalNow().step).toBe("offload.release.trash");
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    await expectInvariants();
  });

  test("a journal that cannot be written before the commit fails coded, with nothing changed", async () => {
    const real = testHost();
    const host: HostPorts = {
      ...real,
      fs: {
        ...real.fs,
        writeTextDurable: async (path, text) => {
          if (path.startsWith(box.paths.journalDir))
            throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
          return real.fs.writeTextDurable(path, text);
        },
      },
    };
    const result = await runOffload(deps({}, host), { project: await ref() });
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([1, "fs.write-failed"]);
    expect(engine.calls).toHaveLength(0);
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    await expectInvariants();
  });

  test("first offloads of two projects in one root at once agree on the root's ULID", async () => {
    box.file("work/api/package.json", `${JSON.stringify({ name: "api" })}\n`);
    const apiDir = join(box.home, "work/api");
    let apiReleased: TreeCapture | undefined;
    const apiHost = testHost({
      faults: {
        onStep: (step) => {
          if (step === "offload.release.trash") apiReleased = captureTree(apiDir);
        },
      },
    });
    const [a, b] = await Promise.all([
      offload(),
      ref("work:api").then((r) => runOffload(deps({}, apiHost), { project: r })),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const offloads = (await storeEvents()).filter((e) => e.type === "offloaded");
    expect(new Set(offloads.map((e) => e.root)).size).toBe(1);
    const registry = value(await readRegistry(testHost(), box.paths));
    expect(registry.roots?.work).toBe(offloads[0]?.root);
    await expectInvariants();
    await expectInvariants(undefined, { path: "api", released: apiReleased });
  });

  test("a root ULID the catalog already holds is recorded in registry.json", async () => {
    const rootId = ulid();
    value(
      await appendEvent(storeEventLog(store), {
        v: 1,
        id: ulid(),
        op: ulid(),
        type: "root-created",
        device: ulid(),
        at: "2026-10-01T00:00:00.000Z",
        root: rootId,
        key: "work",
      }),
    );
    value(await offload());
    expect(value(await readRegistry(testHost(), box.paths)).roots?.work).toBe(rootId);
    expect((await storeEvents()).filter((e) => e.type === "root-created")).toHaveLength(1);
    await expectInvariants();
  });
});

describe("invariants helper", () => {
  test("invariant 1 needs the deleted copy's own snapshot: a stub naming an uncommitted one fails it", async () => {
    value(await offload());
    const stub = JSON.parse(readFileSync(`${dir}.plainport`, "utf8"));
    writeFileSync(`${dir}.plainport`, JSON.stringify({ ...stub, snapshot: ulid() }));
    const violations = await invariantViolations({
      paths: box.paths,
      device: device.id,
      project: { id: await projectId(), dir },
      roots: [join(box.home, "work")],
      store: { name: "ssd", blob: store, engine },
      ...(released === undefined ? {} : { released }),
      stripped: ["node_modules"],
    });
    expect(violations.some((v) => v.startsWith("invariant 1"))).toBe(true);
  });

  test("invariant 1 compares the committed snapshot with the folder as it was released", async () => {
    value(await offload());
    const violations = await invariantViolations({
      paths: box.paths,
      device: device.id,
      project: { id: await projectId(), dir },
      roots: [join(box.home, "work")],
      store: { name: "ssd", blob: store, engine },
      released: new Map([
        ...(released ?? new Map()),
        ["missing.txt", { type: "file", size: 1, mode: 0o644 }],
      ]),
      stripped: ["node_modules"],
    });
    expect(violations.some((v) => v.startsWith("invariant 1") && v.includes("missing.txt"))).toBe(true);
  });

  test("invariant 3 reads each journal: a released operation's trash past its deadline is a leftover", async () => {
    config('[offload]\nkeepLocalFor = "24h"');
    const result = value(await offload());
    const subject = async (now?: Date) =>
      invariantViolations({
        paths: box.paths,
        device: device.id,
        project: { id: await projectId(), dir },
        roots: [join(box.home, "work")],
        store: { name: "ssd", blob: store, engine },
        ...(released === undefined ? {} : { released }),
        stripped: ["node_modules"],
        settleMs: 0,
        ...(now === undefined ? {} : { now }),
      });
    expect(await subject()).toEqual([]);
    const later = new Date(Date.parse(result.keepUntil as string) + 1000);
    expect((await subject(later)).some((v) => v.startsWith("invariant 3"))).toBe(true);
  });
});

describe("the detached trash delete (D47)", () => {
  test("starts only for an offload's own trash and journal; anything else is a bug and refused", async () => {
    const op = ulid();
    await expect(posixDeleteTrash("/tmp/somewhere", `/x/journal/${op}.json`)).rejects.toThrow(
      "not an offload's",
    );
    await expect(
      posixDeleteTrash(`/r/.plainport-trash/${op}`, `/x/journal/${ulid()}.json`),
    ).rejects.toThrow();
    const trash = box.dir(`work/.plainport-trash/${op}`);
    box.file(`work/.plainport-trash/${op}/web/a.txt`, "a");
    const journal = box.file(`.local/state/plainport/journal/${op}.json`, "{}");
    value(await posixDeleteTrash(trash, journal));
    await waitGone(journal);
    expect([existsSync(trash), existsSync(journal)]).toEqual([false, false]);
  });
});

describe("offload: fix wave r2", () => {
  const stubPath = () => `${dir}.plainport`;
  const journalNow = () => {
    const names = readdirSync(box.paths.journalDir).filter((n) => n.endsWith(".json"));
    return OffloadJournalSchema.parse(
      JSON.parse(readFileSync(join(box.paths.journalDir, names[0] as string), "utf8")),
    );
  };
  const register = async () => {
    const id = ulid();
    value(
      await updateRegistry(testHost(), box.paths, (r) => ({
        ok: true,
        value: {
          ...r,
          projects: { [id]: { root: "work", path: "web", registeredAt: "2026-10-01T00:00:00.000Z" } },
        },
      })),
    );
    return id;
  };

  test("a file that appears at the stub's path while it is written is never overwritten (D48)", async () => {
    const real = testHost({ faults: { onStep: capture } });
    let planted = false;
    const plant = (to: string) => {
      if (!planted && to === stubPath()) {
        planted = true;
        writeFileSync(stubPath(), "written by someone else\n");
      }
    };
    const host: HostPorts = {
      ...real,
      fs: {
        ...real.fs,
        rename: async (from, to) => {
          plant(to);
          return real.fs.rename(from, to);
        },
        link: async (from, to) => {
          plant(to);
          return real.fs.link(from, to);
        },
      },
    };
    const result = await runOffload(deps({}, host), { project: await ref() });
    expect(planted).toBe(true);
    expect(readFileSync(stubPath(), "utf8")).toBe("written by someone else\n");
    expect(result.ok ? 0 : result.finding.code).toBe("path.stub-occupied");
    expect(journalNow().step).toBe("offload.release.moved");
  });

  test("this project's own stub at the path is compared, then replaced", async () => {
    const id = await register();
    writeFileSync(
      stubPath(),
      JSON.stringify({
        plainport: 1,
        project: id,
        root: "work",
        rootId: ulid(),
        path: "web",
        store: "ssd",
        snapshot: ulid(),
        offloadedAt: "2026-10-01T00:00:00.000Z",
        bytes: 1,
        restore: "plainport onload work:web",
      }),
    );
    const result = value(await offload());
    expect(JSON.parse(readFileSync(stubPath(), "utf8"))).toMatchObject({ project: id, snapshot: result.op });
    await expectInvariants();
  });

  test("a FIFO at the stub's path blocks in preflight without being read", async () => {
    expect(Bun.spawnSync(["mkfifo", stubPath()]).exitCode).toBe(0);
    const result = await offload();
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "path.stub-occupied"]);
    expect(engine.calls).toHaveLength(0);
    rmSync(stubPath());
    await expectInvariants();
  }, 10_000);

  test("an edit while the listing is read is caught by the re-stat after it, and the offload plans again", async () => {
    let edited = false;
    engine.hooks.duringListing = () => {
      if (edited) return;
      edited = true;
      writeFileSync(join(dir, "src/main.ts"), "export const main = 3;\n");
    };
    value(await offload());
    expect(engine.calls).toHaveLength(2);
    const committed = engine.repository.snapshots[1];
    expect(new TextDecoder().decode(committed?.data.get("src/main.ts"))).toBe("export const main = 3;\n");
    await expectInvariants();
  });

  const approve = async (over: { keepDeps?: boolean; storeId?: string } = {}) => {
    const prepared = value(
      await prepareOffload(testHost(), quietChecks, [nodePlugin], {
        dir,
        project: { address: "work:web", root: "work", path: "web" },
        loader: new ConfigLoader(testHost(), box.paths),
        env: { HOME: box.home, PATH },
        now: new Date(),
        storeId: value(await readRegistry(testHost(), box.paths)).stores?.ssd as string,
        ...over,
      }),
    );
    await savePlan(testHost(), box.paths, prepared.plan, new Date());
    return prepared.plan;
  };

  test("an approval binds the store's identity: the same name on another store refuses (D48)", async () => {
    const approved = await approve();
    store = memoryBlobStore({ createIfAbsent: true });
    engine = fakeEngine();
    value(
      await setUpStore(testHost(), {
        paths: box.paths,
        env: { PLAINPORT_STORE_PASSWORD: "pw" },
        name: "ssd",
        store: { kind: "local", path: "~/ssd" },
        opener,
        mint: () => ulid(),
      }),
    );
    const result = await offload({ plan: approved.id });
    expect(result.ok ? 0 : result.finding.code).toBe("plan.stale");
    expect(engine.calls).toHaveLength(0);
    await expectInvariants();
  });

  test("a stale plan's fix is the exact command that runs the fresh plan, its options included", async () => {
    const approved = await approve();
    const result = await offload({ plan: approved.id, keepDeps: true });
    expect(result.ok ? 0 : result.finding.code).toBe("plan.stale");
    const fix = result.ok ? "" : (result.finding.fix ?? "");
    const fresh = /--plan ([0-9A-Z]{26})/.exec(fix)?.[1] as string;
    expect(fix).toEndWith(`plainport offload work:web --plan ${fresh} --keep-deps`);
    expect(result.ok ? undefined : result.data).toMatchObject({ id: fresh, options: { keepDeps: true } });
    value(await offload({ plan: fresh, keepDeps: true }));
    await expectInvariants();
  });

  test("plan.stale after an upload says a snapshot was uploaded and not committed", async () => {
    const approved = await approve();
    engine.hooks.duringSnapshot = () => writeFileSync(join(dir, "src/main.ts"), "edited\n");
    const result = await offload({ plan: approved.id });
    expect(result.ok ? 0 : result.finding.code).toBe("plan.stale");
    const message = result.ok ? "" : result.finding.message;
    expect(message).not.toContain("nothing was uploaded");
    expect(message).toContain("uploaded but not committed");
    await expectInvariants();
  });

  test("one store serves one root (D48): a second root naming the same store is refused", async () => {
    config('[roots.personal]\nstore = "ssd"\non = { mbp = "~/personal" }');
    box.file("personal/notes/package.json", `${JSON.stringify({ name: "notes" })}\n`);
    value(await offload());
    const other = await resolveProject(testHost(), box.paths, "personal:notes", {
      cwd: box.home,
      env: { HOME: box.home },
      device: "mbp",
    });
    const result = await runOffload(deps(), { project: value(other) });
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "store.root-mismatch"]);
    expect(result.ok ? "" : result.finding.fix).toContain("its own store");
    expect(existsSync(join(box.home, "personal/notes/package.json"))).toBe(true);
    expect(engine.calls).toHaveLength(1);
    await expectInvariants();
  });

  const spy = (fail: (method: string, path: string) => string | undefined): HostPorts => {
    const real = testHost({ faults: { onStep: capture } });
    const wrap =
      <A extends unknown[], R>(method: string, fn: (path: string, ...rest: A) => Promise<R>) =>
      async (path: string, ...rest: A): Promise<R> => {
        const code = fail(method, path);
        if (code !== undefined) throw Object.assign(new Error(`${code}: injected`), { code });
        return fn(path, ...rest);
      };
    return {
      ...real,
      fs: {
        ...real.fs,
        lstat: wrap("lstat", real.fs.lstat),
        readdir: wrap("readdir", real.fs.readdir),
        writeTextDurable: wrap("writeTextDurable", real.fs.writeTextDurable),
      },
    };
  };

  test("I/O errors are coded: the project folder cannot be stat'ed", async () => {
    const host = spy((m, p) => (m === "lstat" && p === dir ? "EACCES" : undefined));
    const result = await runOffload(deps({}, host), { project: await ref() });
    expect(result.ok ? 0 : result.finding.code).toBe("fs.unreadable");
    await expectInvariants();
  });

  test("I/O errors are coded: the journal folder cannot be listed", async () => {
    const host = spy((m, p) => (m === "readdir" && p === box.paths.journalDir ? "EIO" : undefined));
    box.dir(".local/state/plainport/journal");
    const result = await runOffload(deps({}, host), { project: await ref() });
    expect(result.ok ? 0 : result.finding.code).toBe("fs.write-failed");
    await expectInvariants();
  });

  test("I/O errors are coded: the project lock cannot be written", async () => {
    const host = spy((m, p) =>
      m === "writeTextDurable" && p.startsWith(box.paths.locksDir) ? "EROFS" : undefined,
    );
    const result = await runOffload(deps({}, host), { project: await ref() });
    expect(result.ok ? 0 : result.finding.code).toBe("fs.write-failed");
    await expectInvariants();
  });

  test("I/O errors are coded: the stub's path cannot be inspected during release", async () => {
    let moved = false;
    const real = spy((m, p) => (moved && m === "lstat" && p === stubPath() ? "EIO" : undefined));
    const host: HostPorts = {
      ...real,
      faultAt: (step) => {
        real.faultAt(step);
        if (step === "offload.release.moved") moved = true;
      },
      fs: {
        ...real.fs,
        link: async (from, to) => {
          if (to === stubPath()) throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
          return real.fs.link(from, to);
        },
        rename: async (from, to) => {
          if (to === stubPath()) throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
          return real.fs.rename(from, to);
        },
      },
    };
    const result = await runOffload(deps({}, host), { project: await ref() });
    expect(result.ok ? 0 : result.finding.code).toBe("fs.write-failed");
    expect(result.ok ? "" : result.finding.fix).toContain("plainport recover");
  });
});

describe("offload: fix wave r3 (D50)", () => {
  const personal = async () => {
    config('[roots.personal]\nstore = "ssd"\non = { mbp = "~/personal" }');
    box.file("personal/notes/package.json", `${JSON.stringify({ name: "notes" })}\n`);
    return value(
      await resolveProject(testHost(), box.paths, "personal:notes", {
        cwd: box.home,
        env: { HOME: box.home },
        device: "mbp",
      }),
    );
  };
  const claimOf = () => {
    const bytes = store.data.get("meta/v1/root.json");
    return bytes === undefined ? undefined : JSON.parse(new TextDecoder().decode(bytes));
  };
  const journalNow = (): OffloadJournal => {
    const names = readdirSync(box.paths.journalDir).filter((n) => n.endsWith(".json"));
    return OffloadJournalSchema.parse(
      JSON.parse(readFileSync(join(box.paths.journalDir, names[0] as string), "utf8")),
    );
  };
  /** Every journal the run writes, by step (the last one written at that step). */
  const journalsBy = (seen: Map<string, OffloadJournal>) =>
    testHost({
      faults: {
        onStep: (step) => {
          capture(step);
          steps.push(step);
          seen.set(step, journalNow());
        },
      },
    });
  const at = (journal: OffloadJournal, field: string): unknown =>
    field.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], journal);
  const expectRecoverable = (seen: Map<string, OffloadJournal>) => {
    const needs = saga.RECOVERY_NEEDS as Record<string, readonly string[]>;
    for (const [step, journal] of seen) {
      const missing = (needs[step] ?? ["(no entry)"]).filter((field) => at(journal, field) === undefined);
      expect({ step, missing }).toEqual({ step, missing: [] });
    }
  };

  test("two roots' first offloads to one store at once: exactly one claims it, the other writes nothing", async () => {
    const notes = await personal();
    let notesReleased: TreeCapture | undefined;
    const notesHost = testHost({
      faults: {
        onStep: (step) => {
          if (step === "offload.release.trash") notesReleased = captureTree(join(box.home, "personal/notes"));
        },
      },
    });
    const results = await Promise.all([offload(), runOffload(deps({}, notesHost), { project: notes })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const lost = results.find((r) => !r.ok);
    expect(lost?.ok ? 0 : [lost?.exitCode, lost?.finding.code]).toEqual([6, "store.root-mismatch"]);
    const created = (await storeEvents()).filter((e) => e.type === "root-created");
    expect(created).toHaveLength(1);
    expect(claimOf()).toEqual({ v: 1, root: created[0]?.root });
    expect(engine.calls).toHaveLength(1);
    const offloaded = (await storeEvents()).filter((e) => e.type === "offloaded");
    expect(offloaded.map((e) => (e.type === "offloaded" ? e.root : ""))).toEqual([created[0]?.root ?? "?"]);
    const webWon = results[0]?.ok === true;
    expect(existsSync(join(box.home, webWon ? "personal/notes/package.json" : "work/web/src/main.ts"))).toBe(
      true,
    );
    await expectInvariants();
    expect(
      await invariantViolations({
        paths: box.paths,
        device: device.id,
        project: { id: await projectIdOf("notes"), dir: join(box.home, "personal/notes") },
        roots: [join(box.home, "personal")],
        store: { name: "ssd", blob: store, engine },
        ...(notesReleased === undefined ? {} : { released: notesReleased }),
        stripped: ["node_modules"],
      }),
    ).toEqual([]);
  });

  test("a store another root has claimed refuses before anything is written, events or journal", async () => {
    store.data.set(
      "meta/v1/root.json",
      new TextEncoder().encode(`${JSON.stringify({ v: 1, root: ulid() })}\n`),
    );
    const result = await offload();
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "store.root-mismatch"]);
    expect(await storeEvents()).toEqual([]);
    expect(engine.calls).toHaveLength(0);
    await expectUntouched();
    await expectInvariants();
  });

  test("a first offload claims the store for its root before its root-created event", async () => {
    let claimAtBegin: unknown;
    const host = testHost({
      faults: {
        onStep: (step) => {
          capture(step);
          if (step === "offload.begin") claimAtBegin = claimOf();
        },
      },
    });
    value(await runOffload(deps({}, host), { project: await ref() }));
    const [created] = (await storeEvents()).filter((e) => e.type === "root-created");
    expect(claimAtBegin).toEqual({ v: 1, root: created?.root });
    await expectInvariants();
  });

  test("every step has an entry in the recovery table", () => {
    expect(Object.keys(saga.RECOVERY_NEEDS as object).sort()).toEqual([...OFFLOAD_STEPS].sort());
  });

  test("the journal holds what recovery needs at every step of a released offload; the trash is derivable", async () => {
    const seen = new Map<string, OffloadJournal>();
    const result = value(await runOffload(deps({}, journalsBy(seen)), { project: await ref() }));
    expectRecoverable(seen);
    // A lost release.trash write leaves the journal at committed, with no trash: recover derives it.
    const atCommitted = seen.get("offload.committed") as OffloadJournal;
    expect(atCommitted.trash).toBeUndefined();
    expect(saga.offloadTrashOf(atCommitted)).toBe(result.trash);
    await expectInvariants();
  });

  test("the journal holds what recovery needs on the discarded and the fork branches", async () => {
    const seen = new Map<string, OffloadJournal>();
    engine.hooks.duringSnapshot = () => chmodSync(join(dir, "src/main.ts"), 0o000);
    await runOffload(deps({}, journalsBy(seen)), { project: await ref() });
    chmodSync(join(dir, "src/main.ts"), 0o644);
    expect(seen.has("offload.snapshot.discarded")).toBe(true);
    const id = ulid();
    const rootId = value(await readRegistry(testHost(), box.paths)).roots?.work as string;
    value(
      await updateRegistry(testHost(), box.paths, (r) => ({
        ok: true,
        value: {
          ...r,
          projects: { [id]: { root: "work", path: "web", registeredAt: "2026-10-01T00:00:00.000Z" } },
        },
      })),
    );
    engine.hooks.duringSnapshot = async () => {
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
    const forked = await runOffload(deps({}, journalsBy(seen)), { project: await ref() });
    expect(forked.ok ? 0 : forked.exitCode).toBe(8);
    expect(seen.has("offload.diverged")).toBe(true);
    expectRecoverable(seen);
    await expectInvariants();
  });

  test("--allow is applied to an approved plan: a plan made with --allow git.locked runs with it", async () => {
    const git = Bun.spawnSync(["git", "init", "-q", dir], {
      env: { PATH, HOME: box.home, GIT_CONFIG_NOSYSTEM: "1" },
    });
    expect(git.exitCode).toBe(0);
    box.file("work/web/.git/index.lock");
    const prepared = value(
      await prepareOffload(testHost(), quietChecks, [nodePlugin], {
        dir,
        project: { address: "work:web", root: "work", path: "web" },
        loader: new ConfigLoader(testHost(), box.paths),
        env: { HOME: box.home, PATH },
        now: new Date(),
        allow: ["git.locked"],
        storeId: value(await readRegistry(testHost(), box.paths)).stores?.ssd as string,
      }),
    );
    await savePlan(testHost(), box.paths, prepared.plan, new Date());
    const listed = await listPlans(testHost(), box.paths, new Date());
    expect(listed.map((p) => p.id)).toContain(prepared.plan.id);
    value(await offload({ plan: prepared.plan.id, allow: ["git.locked"] }));
    expect(existsSync(dir)).toBe(false);
    await expectInvariants();
  });

  test("offload.verify = full is refused with usage.invalid until M5; nothing is uploaded", async () => {
    config('[offload]\nverify = "full"');
    const result = await offload();
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([2, "usage.invalid"]);
    expect(result.ok ? "" : result.finding.fix).toContain('verify = "manifest"');
    expect(engine.calls).toHaveLength(0);
    await expectUntouched();
    await expectInvariants();
  });

  test("git's fsmonitor daemon is stopped with git kept inside the folder (D33, D34)", async () => {
    const git = Bun.spawnSync(["git", "init", "-q", dir], {
      env: { PATH, HOME: box.home, GIT_CONFIG_NOSYSTEM: "1" },
    });
    expect(git.exitCode).toBe(0);
    const socket = join(dir, ".git", "fsmonitor--daemon.ipc");
    const server = createServer();
    await new Promise<void>((done) => server.listen(socket, done));
    try {
      const real = testHost({ faults: { onStep: capture } });
      const calls: { args: readonly string[]; env?: Record<string, string> }[] = [];
      const host: HostPorts = {
        ...real,
        run: (spec) => {
          if (spec.command !== "git" || spec.args?.[0] !== "fsmonitor--daemon") return real.run(spec);
          // The socket answers nothing, so the real stop is not run; what it would be given is recorded.
          calls.push({ args: spec.args, ...(spec.env === undefined ? {} : { env: spec.env }) });
          return real.run({ ...spec, command: "true", args: [] });
        },
      };
      const checks = {
        ...quietChecks,
        processesUsing: async () =>
          ok([
            {
              pid: 321,
              ppid: 1,
              ancestor: false,
              command: "git",
              args: "git fsmonitor--daemon run --detach",
              cwd: false,
              files: [socket],
              fileCount: 1,
            },
          ]),
      };
      value(await runOffload(deps({ checks }, host), { project: await ref() }));
      expect(calls).toHaveLength(1);
      expect(calls[0]?.env).toMatchObject({
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CEILING_DIRECTORIES: join(realpathSync(box.home), "work"),
      });
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
    await expectInvariants();
  });

  test("Ctrl-C during the commit's catalog reload is operation.cancelled (130); nothing deleted", async () => {
    const controller = new AbortController();
    let verified = false;
    const realList = store.list;
    store.list = (prefix) => {
      if (verified) controller.abort();
      return realList(prefix);
    };
    const host = testHost({
      faults: {
        onStep: (step) => {
          capture(step);
          if (step === "offload.verified") verified = true;
        },
      },
    });
    const result = await runOffload(deps({ signal: controller.signal }, host), { project: await ref() });
    store.list = realList;
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([130, "operation.cancelled"]);
    await expectUntouched();
    await expectInvariants();
  });

  test("Ctrl-C during a commit reload that also fails is still operation.cancelled", async () => {
    const controller = new AbortController();
    let verified = false;
    const realList = store.list;
    store.list = (prefix) => {
      if (!verified) return realList(prefix);
      controller.abort();
      return Promise.resolve(fail(finding("store.unreachable", { message: "unplugged" })));
    };
    const host = testHost({
      faults: {
        onStep: (step) => {
          capture(step);
          if (step === "offload.verified") verified = true;
        },
      },
    });
    const result = await runOffload(deps({ signal: controller.signal }, host), { project: await ref() });
    store.list = realList;
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([130, "operation.cancelled"]);
    await expectUntouched();
    await expectInvariants();
  });

  test("a snapshot-discarded journal write that fails names plainport recover, which records it", async () => {
    let failing = false;
    engine.hooks.duringSnapshot = () => {
      chmodSync(join(dir, "src/main.ts"), 0o000);
      failing = true;
    };
    const real = testHost({ faults: { onStep: capture } });
    const host: HostPorts = {
      ...real,
      fs: {
        ...real.fs,
        writeTextDurable: async (path, text) => {
          if (failing && path.startsWith(box.paths.journalDir))
            throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
          return real.fs.writeTextDurable(path, text);
        },
      },
    };
    const result = await runOffload(deps({}, host), { project: await ref() });
    chmodSync(join(dir, "src/main.ts"), 0o644);
    expect(result.ok ? 0 : result.finding.code).toBe("fs.write-failed");
    expect(result.ok ? "" : result.finding.fix).toContain("plainport recover");
    expect(result.ok ? "" : result.finding.fix).not.toContain("then re-run");
  });

  test("a snapshot-discarded event the store refuses names plainport recover in the fix", async () => {
    engine.hooks.duringSnapshot = () => {
      chmodSync(join(dir, "src/main.ts"), 0o000);
      store.failNext("put");
    };
    const result = await offload();
    chmodSync(join(dir, "src/main.ts"), 0o644);
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "restic.unreadable-files"]);
    expect(result.ok ? "" : result.finding.fix).toContain("plainport recover");
    expect(journalNow().step).toBe("offload.snapshot.discarded");
  });

  test("the retry's own findings are streamed too", async () => {
    engine.hooks.duringSnapshot = (_input, attempt) => {
      if (attempt === 1) box.file("work/web/.plainport.toml", '[strip]\nkeep = ["node_modules"]\n');
    };
    value(await offload());
    const codes = events.flatMap((e) => (e.type === "finding" ? [e.finding.code] : []));
    expect(codes).toContain("strip.kept");
    await expectInvariants();
  });

  test("preflight checks the credentials: a wrong password refuses before anything is written", async () => {
    engine.hooks.failNext = {
      list: fail(finding("restic.wrong-password", { message: "wrong password or no key found" })),
    };
    const result = await offload();
    expect(result.ok ? 0 : result.finding.code).toBe("restic.wrong-password");
    expect(await storeEvents()).toEqual([]);
    expect(claimOf()).toBeUndefined();
    expect(engine.calls).toHaveLength(0);
    await expectUntouched();
    await expectInvariants();
  });
});
