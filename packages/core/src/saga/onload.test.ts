// The onload saga against a sandboxed home, a fixture project offloaded first, an in-memory store and the fake engine
// (T0). Package managers are fake binaries on PATH that record the call and write a marker, so no install reaches a
// registry (D13). Every test that runs the saga to an end checks invariants 1–3 afterwards (testing/invariants.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { FINDINGS, type StreamEvent } from "@plainport/contract";
import { macOnlyTests } from "../../../../test/platform.ts";
import { nodePlugin } from "../../../eco-node/src/index.ts";
import { FIXTURES, GOLDEN_CASES } from "../../../eco-node/src/testing.ts";
import { appendEvent, type CatalogEvent, foldCatalog, readEvents, storeEventLog } from "../catalog/index.ts";
import { ConfigLoader } from "../config/load.ts";
import { type Device, ensureDevice } from "../device.ts";
import { type Journal, type OnloadJournal, readJournals } from "../journal/index.ts";
import type { HostPorts } from "../ports/host.ts";
import { InjectedFault } from "../ports/host.ts";
import type { StoreOpener } from "../ports/store.ts";
import { recover } from "../recover/recover.ts";
import { type RegistryEntry, readRegistry, updateRegistry } from "../registry.ts";
import { type ProjectRef, resolveProject } from "../roots/address.ts";
import { canonicalPath } from "../roots/canonical.ts";
import { setUpStore } from "../store.ts";
import { quietChecks } from "../testing/checks.ts";
import { type FakeEngine, fakeEngine } from "../testing/fake-engine.ts";
import { makeGitFixture } from "../testing/git-fixture.ts";
import { testHost } from "../testing/host.ts";
import {
  captureTree,
  catalogInvariantViolations,
  invariantViolations,
  type TreeCapture,
} from "../testing/invariants.ts";
import { type MemoryBlobStore, memoryBlobStore } from "../testing/memory-blob-store.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { settledOffload } from "../testing/settle.ts";
import { ulid } from "../ulid.ts";
import { runDehydrate, runHydrate } from "./hydrate.ts";
import { openSaga } from "./journaled.ts";
import { type OffloadDeps, runOffload } from "./offload.ts";
import {
  finishOnload,
  ONLOAD_AFTER_EFFECT,
  ONLOAD_RECOVERY_NEEDS,
  ONLOAD_STEPS,
  type OnloadDeps,
  type OnloadRequest,
  type OnloadStep,
  onloadSwapped,
  runOnload,
} from "./onload.ts";

let box: Sandbox;
let device: Device;
let store: MemoryBlobStore;
let mirror: MemoryBlobStore;
let engine: FakeEngine;
let dir: string;
let bin: string;
let pmLog: string;
let events: StreamEvent[];
let logs: string[];
let steps: string[];

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

/**
 * A fake package manager on PATH: records "<cwd>|<args>" in FAKE_PM_LOG and writes node_modules/.installed-by, or
 * fails like an offline registry when FAKE_PM_FAIL is set.
 */
const fakeManager = (name: string) => {
  const path = join(bin, name);
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `echo "$PWD|${name} $*" >> "$FAKE_PM_LOG"`,
      'if [ -n "$FAKE_PM_FAIL" ]; then echo "npm ERR! network request failed (offline)" >&2; exit 1; fi',
      `mkdir -p node_modules && echo "${name} $*" > node_modules/.installed-by`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
};

beforeEach(async () => {
  box = makeSandbox("plainport-onload-saga-");
  config();
  box.dir("ssd");
  bin = box.dir("bin");
  pmLog = join(box.home, "pm.log");
  for (const name of ["npm", "pnpm", "yarn", "bun"]) fakeManager(name);
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
  // A small Node project: sources, a .env, a symlink, an exec bit, a read-only file, and dependencies to strip.
  box.file("work/web/package.json", `${JSON.stringify({ name: "web" })}\n`);
  box.file("work/web/package-lock.json", `${JSON.stringify({ lockfileVersion: 3 })}\n`);
  box.file("work/web/src/main.ts", "export const main = 1;\n");
  box.file("work/web/.env", "TOKEN=op://vault/item\n");
  box.file("work/web/run.sh", "#!/bin/sh\necho hi\n");
  chmodSync(join(box.home, "work/web/run.sh"), 0o755);
  box.file("work/web/docs/readme.txt", "read only\n");
  chmodSync(join(box.home, "work/web/docs/readme.txt"), 0o444);
  box.file("work/web/node_modules/dep/index.js", "x".repeat(4000));
  symlinkSync("src/main.ts", join(box.home, "work/web/main-link"));
  dir = join(box.home, "work/web");
  events = [];
  released.clear();
  logs = [];
  steps = [];
});

afterEach(() => box.cleanup());

const env = (extra: Record<string, string> = {}) => ({
  HOME: box.home,
  PATH: `${bin}:/usr/bin:/bin`,
  PLAINPORT_STORE_PASSWORD: "pw",
  FAKE_PM_LOG: pmLog,
  ...extra,
});

const recordingHost = (): HostPorts => testHost({ faults: { onStep: (s) => steps.push(s) } });

/** Each project folder as it stood when its offload's release began: what invariant 1 checks a shelved one against. */
const released = new Map<string, TreeCapture>();
const capturing = (): HostPorts =>
  testHost({
    faults: {
      onStep: (step) => {
        if (step !== "offload.release.trash") return;
        const [journal] = readdirSync(box.paths.journalDir)
          .map((n) => JSON.parse(readFileSync(join(box.paths.journalDir, n), "utf8")) as Journal)
          .filter((j) => j.kind === "offload" && j.step === "offload.release.trash");
        if (journal !== undefined) released.set(journal.project.dir, captureTree(journal.project.dir));
      },
    },
  });

const offloadDeps = (host: HostPorts = capturing()): OffloadDeps => ({
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

const deps = (over: Partial<OnloadDeps> = {}, host: HostPorts = recordingHost()): OnloadDeps => ({
  host,
  plugins: [nodePlugin],
  paths: box.paths,
  device,
  env: env(),
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

const value = <T>(
  result: { ok: true; value: T } | { ok: false; finding: { code: string; message: string } },
): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

/** Offloads the web project (or another folder) and waits until its detached delete has finished (trash, claim, journal). */
const offload = async (path = "web") => {
  const done = value(await runOffload(offloadDeps(), { project: await ref(`work:${path}`) }));
  // The detached delete may be slow on a loaded runner: up to 30 s.
  if (done.keepUntil === undefined) await settledOffload(box.paths, done);
  return done;
};

const onload = async (
  { project, ...req }: Partial<OnloadRequest> = {},
  over: Partial<OnloadDeps> = {},
  host?: HostPorts,
) => runOnload(deps(over, host), { project: await ref(project?.address ?? "work:web"), ...req });

const storeEvents = async (): Promise<CatalogEvent[]> => {
  const read = await readEvents(storeEventLog(store));
  if (!read.ok) throw new Error(read.finding.message);
  return read.value.events;
};

const projectId = async (path = "web"): Promise<string> => {
  const registry = value(await readRegistry(testHost(), box.paths));
  return Object.entries(registry.projects).find(([, e]) => e.path === path)?.[0] as string;
};

const expectInvariants = async (path = "web", folder = join(box.home, "work", path)) =>
  expect(
    await invariantViolations({
      // These runs use the real clock (testHost), so their deadlines are compared with it.
      now: new Date(),
      paths: box.paths,
      device: device.id,
      project: { id: await projectId(path), dir: folder },
      roots: [join(box.home, "work")],
      store: { name: "ssd", blob: store, engine },
      stripped: ["node_modules"],
      ...(released.has(folder) ? { released: released.get(folder) as TreeCapture } : {}),
    }),
  ).toEqual([]);

/** Every entry below a folder with its type, mode, link target and content hash; node_modules left out. */
const treeOf = (
  root: string,
  skip = (path: string) =>
    path === "node_modules" || path.startsWith("node_modules/") || path.endsWith("/node_modules"),
): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (relative: string) => {
    for (const name of readdirSync(relative === "" ? root : join(root, relative)).sort()) {
      const path = relative === "" ? name : `${relative}/${name}`;
      if (skip(path)) continue;
      const full = join(root, path);
      const stat = lstatSync(full);
      const mode = (stat.mode & 0o7777).toString(8);
      if (stat.isSymbolicLink()) out[path] = `link ${readlinkSync(full)}`;
      else if (stat.isDirectory()) {
        out[path] = `dir ${mode}`;
        walk(path);
      } else out[path] = `file ${mode} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
    }
  };
  walk("");
  return out;
};

/** Aborts once the fake install has started (its call is in the log), not on a timer. */
const abortOnceInstalling = async (stop: AbortController, calls = 1) => {
  for (let i = 0; i < 2000 && pmCalls().length < calls; i++) await Bun.sleep(10);
  stop.abort();
};

/** Writes a lock for the project as a live plainport elsewhere would hold it. */
const holdLock = (id: string) => {
  mkdirSync(box.paths.locksDir, { recursive: true });
  writeFileSync(
    join(box.paths.locksDir, `${id}.lock`),
    `${JSON.stringify({ pid: process.ppid, host: hostname(), startedAt: new Date().toISOString(), token: "held" })}\n`,
  );
};

const pmCalls = (): string[] =>
  existsSync(pmLog)
    ? readFileSync(pmLog, "utf8")
        .trim()
        .split("\n")
        .filter((l) => l !== "")
    : [];

const expectShelvedUntouched = async () => {
  expect(existsSync(dir)).toBe(false);
  expect(existsSync(`${dir}.plainport`)).toBe(true);
  expect((await storeEvents()).filter((e) => e.type === "onloaded" && e.device === device.id)).toEqual([]);
  expect((await readJournals(testHost(), box.paths)).journals).toEqual([]);
  const staging = join(box.home, "work/.plainport-staging");
  expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
};

describe("onload: the round trip", () => {
  test("restores the offloaded folder byte for byte (stripped paths aside), swaps it in and hydrates it", async () => {
    const before = treeOf(dir);
    // A folder mode a new folder would not get: the offloaded event records it (rootMode, D55).
    chmodSync(dir, 0o750);
    const rootMode = lstatSync(dir).mode & 0o7777;
    const off = await offload();
    expect((await storeEvents()).find((e) => e.type === "offloaded")).toMatchObject({ rootMode: 0o750 });
    expect(existsSync(dir)).toBe(false);

    const result = value(await onload());
    expect(result).toMatchObject({
      exitCode: 0,
      project: "work:web",
      snapshot: off.op,
      over: off.op,
      store: "ssd",
      dir,
      restored: "restore",
      hydrate: { status: "installed", steps: [{ path: "", command: "npm ci", ok: true }] },
    });
    expect(treeOf(dir)).toEqual(before);
    // The folder's own mode comes back from the offloaded event (D55); restic alone would make it 0700.
    expect((lstatSync(dir).mode & 0o7777).toString(8)).toBe(rootMode.toString(8));
    // The install ran in the project, frozen, and put the dependencies back.
    expect(pmCalls()).toEqual([`${await canonicalReal(dir)}|npm ci`]);
    expect(readFileSync(join(dir, "node_modules/.installed-by"), "utf8").trim()).toBe("npm ci");

    // The stub is gone; the onloaded event opens the lease and records the head it was written over (D43).
    expect(existsSync(`${dir}.plainport`)).toBe(false);
    const id = await projectId();
    const onloaded = (await storeEvents()).find((e) => e.type === "onloaded");
    expect(onloaded).toMatchObject({
      type: "onloaded",
      project: id,
      path: "web",
      device: device.id,
      op: result.op,
      base: off.op,
      over: off.op,
    });
    const state = foldCatalog(await storeEvents()).projects[id];
    expect(state).toMatchObject({
      status: "local",
      head: off.op,
      lease: { device: device.id, base: off.op },
    });

    // This device records the copy's base (the head it was written over) and the onload time.
    const entry = value(await readRegistry(testHost(), box.paths)).projects[id];
    expect(entry).toMatchObject({ root: "work", path: "web", base: off.op, onloadedAt: expect.any(String) });
    expect(entry?.unhydrated).toBeUndefined();
    expect(entry?.override).toBeUndefined();

    // Nothing is left open: no journal, no lock, no staging.
    expect((await readJournals(testHost(), box.paths)).journals).toEqual([]);
    expect(existsSync(join(box.paths.locksDir, `${id}.lock`))).toBe(false);
    // The staging holder it left empty goes too (C2).
    expect(existsSync(join(box.home, "work/.plainport-staging"))).toBe(false);
    await expectInvariants();
  });

  test("reports its phases in order and reaches every journal step once, in ONLOAD_STEPS order", async () => {
    await offload();
    const result = value(await onload());
    const phases = events.filter((e) => e.type === "phase");
    expect(phases.filter((e) => e.status === "start").map((e) => e.phase)).toEqual([
      "resolve",
      "preflight",
      "restore",
      "verify",
      "swap",
      "toolchain",
      "hydrate",
    ]);
    expect(phases.every((e) => e.op === result.op)).toBe(true);
    expect(steps.filter((s) => (ONLOAD_STEPS as readonly string[]).includes(s))).toEqual([...ONLOAD_STEPS]);
    await expectInvariants();
  });

  test("at every journal step the journal on disk names that step, the staging folder and the snapshot", async () => {
    const off = await offload();
    const seen: OnloadJournal[] = [];
    const host = testHost({
      faults: {
        onStep: (step) => {
          steps.push(step);
          if (!(ONLOAD_STEPS as readonly string[]).includes(step)) return;
          const [journal] = readdirSync(box.paths.journalDir).map(
            (n) => JSON.parse(readFileSync(join(box.paths.journalDir, n), "utf8")) as OnloadJournal,
          );
          if (journal !== undefined) seen.push(journal);
        },
      },
    });
    value(await onload({}, {}, host));
    expect(seen.map((j) => j.step)).toEqual([...ONLOAD_STEPS]);
    for (const j of seen) {
      expect(j).toMatchObject({ kind: "onload", snapshot: off.op, over: off.op, project: { dir } });
      expect(j.staging).toBe(join(box.home, "work/.plainport-staging", j.op));
    }
    expect(seen.find((j) => j.step === "onload.commit.start")?.event).toEqual(expect.any(String));
    // At swap.start, recover reads the folder the swap moves from: staging here, reuse.folder for a rename-back (M12).
    const swap = seen.find((j) => j.step === "onload.swap.start");
    expect(swap?.staging ?? swap?.reuse?.folder).toEqual(expect.any(String));
    // Every field recover reads at a step is in the journal at that step.
    for (const j of seen) {
      for (const field of ONLOAD_RECOVERY_NEEDS[j.step as keyof typeof ONLOAD_RECOVERY_NEEDS]) {
        const found = field
          .split(".")
          .reduce<unknown>((at, key) => (at as Record<string, unknown>)?.[key], j);
        expect([j.step, field, found === undefined]).toEqual([j.step, field, false]);
      }
    }
    // A plain run reaches every after-effect seam but the reuse branch's.
    expect(Object.keys(ONLOAD_AFTER_EFFECT).filter((point) => !steps.includes(point))).toEqual([
      "onload.reuse.cleared",
    ]);
    await expectInvariants();
  });

  test("a crash is never caught: the injected fault propagates and the journal stays at its step", async () => {
    await offload();
    const host = testHost({ faults: { at: "onload.swap.start" } });
    await expect(onload({}, {}, host)).rejects.toBeInstanceOf(InjectedFault);
    const [journal] = (await readJournals(testHost(), box.paths)).journals as OnloadJournal[];
    expect(journal?.step).toBe("onload.swap.start");
    expect(existsSync(join(journal?.staging ?? "", "src/main.ts"))).toBe(true);
    expect(existsSync(`${dir}.plainport`)).toBe(true);
  });

  test("an interrupted restore is taken up again: the same staging folder, files already written are skipped", async () => {
    const off = await offload();
    const crash = testHost({ faults: { at: "onload.restored" } });
    await expect(onload({}, {}, crash)).rejects.toBeInstanceOf(InjectedFault);
    const [interrupted] = (await readJournals(testHost(), box.paths)).journals as OnloadJournal[];
    expect(interrupted?.step).toBe("onload.restored");

    const result = value(await onload());
    expect(result.op).toBe(interrupted?.op as string);
    expect(engine.restores.map((r) => [r.target, r.overwrite])).toEqual([
      [interrupted?.staging as string, "always"],
      [interrupted?.staging as string, "if-changed"],
    ]);
    expect(engine.restores[1]?.written).toBe(0);
    expect(result.snapshot).toBe(off.op);
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    await expectInvariants();
  });

  test("an offloaded event without rootMode (older writers) leaves the folder a new folder's mode (D55)", async () => {
    chmodSync(dir, 0o750);
    const off = await offload();
    // The same event without rootMode, as a writer before D55 left it: the catalog is rebuilt from it alone.
    const offloaded = (await storeEvents()).find((e) => e.type === "offloaded");
    if (offloaded?.type !== "offloaded") throw new Error("no offloaded event");
    const { rootMode: _, ...older } = offloaded;
    value(await store.delete(`meta/v1/events/${offloaded.id}.json`));
    value(await appendEvent(storeEventLog(store), older));
    mirror = memoryBlobStore({ createIfAbsent: true });
    const result = value(await onload());
    expect(result.snapshot).toBe(off.op);
    const fresh = join(box.home, "fresh");
    mkdirSync(fresh);
    expect((lstatSync(dir).mode & 0o7777).toString(8)).toBe((lstatSync(fresh).mode & 0o7777).toString(8));
    await expectInvariants();
  });

  test("a head that moves during the restore is never written as a stale over: onload refuses before the swap (I2)", async () => {
    const off = await offload();
    const id = await projectId();
    const root = foldCatalog(await storeEvents()).projects[id]?.root as string;
    engine.hooks.duringRestore = async () => {
      // Another device offloads a newer copy while this restore runs.
      value(
        await appendEvent(storeEventLog(store), {
          v: 1,
          id: ulid(),
          type: "offloaded",
          device: ulid(),
          at: new Date().toISOString(),
          op: ulid(),
          project: id,
          root,
          path: "web",
          base: off.op,
          snapshot: ulid(),
          stored: { ssd: "d".repeat(64) },
          stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
        }),
      );
    };
    const result = await onload();
    expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([8, "catalog.head-moved"]);
    expect(!result.ok && result.finding.fix).toContain("plainport onload work:web");
    await expectShelvedUntouched();
  });

  test("a resumed --snapshot onload writes the current head as over, not the one it began with (I2, D43)", async () => {
    const first = await offload();
    value(await onload());
    writeFileSync(join(dir, "src/main.ts"), "export const main = 2;\n");
    const second = await offload();
    const crash = testHost({ faults: { at: "onload.restored" } });
    await expect(onload({ snapshot: first.op }, {}, crash)).rejects.toBeInstanceOf(InjectedFault);
    // The head moves while the onload is stopped.
    const id = await projectId();
    const root = foldCatalog(await storeEvents()).projects[id]?.root as string;
    const third = ulid();
    value(
      await appendEvent(storeEventLog(store), {
        v: 1,
        id: ulid(),
        type: "offloaded",
        device: ulid(),
        at: new Date().toISOString(),
        op: third,
        project: id,
        root,
        path: "web",
        base: second.op,
        snapshot: third,
        stored: { ssd: "e".repeat(64) },
        stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
      }),
    );
    const result = value(await onload({ snapshot: first.op }));
    expect(result).toMatchObject({ snapshot: first.op, over: third });
    expect((await storeEvents()).filter((e) => e.type === "onloaded").at(-1)).toMatchObject({
      base: first.op,
      over: third,
    });
    expect(value(await readRegistry(testHost(), box.paths)).projects[id]?.base).toBe(third);
  });

  test("a crash part-way through the restore is taken up again: what is missing or cut short is written (M16)", async () => {
    await offload();
    engine.hooks.duringRestore = (target) => {
      rmSync(join(target, "src/main.ts"));
      writeFileSync(join(target, "run.sh"), "#!");
      throw new InjectedFault("restic killed mid-restore");
    };
    await expect(onload()).rejects.toBeInstanceOf(InjectedFault);
    engine.hooks.duringRestore = undefined;
    const result = value(await onload());
    expect(engine.restores.at(-1)).toMatchObject({ overwrite: "if-changed", written: 2 });
    expect(readFileSync(join(result.dir, "src/main.ts"), "utf8")).toBe("export const main = 1;\n");
    await expectInvariants();
  });

  test("onload --snapshot restores an older snapshot and still opens the lease over the head (D43)", async () => {
    const first = await offload();
    value(await onload());
    writeFileSync(join(dir, "src/main.ts"), "export const main = 2;\n");
    const second = await offload();
    const result = value(await onload({ snapshot: first.op }));
    expect(result).toMatchObject({ snapshot: first.op, over: second.op });
    expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe("export const main = 1;\n");
    const id = await projectId();
    const onloads = (await storeEvents()).filter((e) => e.type === "onloaded");
    expect(onloads.at(-1)).toMatchObject({ base: first.op, over: second.op });
    expect(foldCatalog(await storeEvents()).projects[id]).toMatchObject({
      status: "local",
      head: second.op,
      lease: { device: device.id, base: first.op },
    });
    // The copy's next offload builds on the head, so the rollback is a step forward, never a fork.
    expect(value(await readRegistry(testHost(), box.paths)).projects[id]?.base).toBe(second.op);
    await expectInvariants();
  });

  test("a snapshot the catalog does not hold exits 4 with snapshot.not-found; nothing changes", async () => {
    await offload();
    const result = await onload({ snapshot: ulid() });
    expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([4, "snapshot.not-found"]);
    await expectShelvedUntouched();
  });
});

const canonicalReal = async (path: string): Promise<string> => {
  const resolved = await canonicalPath(testHost(), path, box.home);
  if (!resolved.ok) throw new Error(resolved.finding.message);
  return resolved.value.real;
};

describe("onload: finishing from the journal alone (finishOnload, for recover)", () => {
  // Every point after the swap's rename where a crash can leave the journal: the steps, and the seams after an effect.
  const POINTS = [
    "onload.swap.renamed",
    "onload.swapped",
    "onload.stub.removed",
    "onload.commit.start",
    "onload.commit.appended",
    "onload.committed",
    "onload.registry-updated",
  ];
  for (const point of POINTS) {
    test(`a crash at ${point} is finished by finishOnload, each stage done once`, async () => {
      const off = await offload();
      await expect(onload({}, {}, testHost({ faults: { at: point } }))).rejects.toBeInstanceOf(InjectedFault);
      const [journal] = (await readJournals(testHost(), box.paths)).journals as OnloadJournal[];
      if (journal === undefined) throw new Error("no journal");
      expect(await onloadSwapped(testHost(), journal)).toBe(true);
      const saga = openSaga<OnloadJournal, OnloadStep>(
        { io: testHost(), paths: box.paths, faultAt: () => {}, clock: () => new Date(), log: () => {} },
        journal,
      );
      const done = value(
        await finishOnload({
          host: testHost(),
          paths: box.paths,
          saga,
          store: store,
          device: device.id,
          clock: () => new Date(),
          log: () => {},
        }),
      );
      expect(done).toMatchObject({ dir, snapshot: off.op, over: off.op });
      expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
      expect(existsSync(`${dir}.plainport`)).toBe(false);
      const onloaded = (await storeEvents()).filter((e) => e.type === "onloaded" && e.op === journal.op);
      expect(onloaded).toHaveLength(1);
      expect(onloaded[0]).toMatchObject({ base: off.op, over: off.op });
      const entry = value(await readRegistry(testHost(), box.paths)).projects[await projectId()];
      expect(entry).toMatchObject({ base: off.op, onloadedAt: expect.any(String), unhydrated: true });
      expect((await readJournals(testHost(), box.paths)).journals).toEqual([]);
      await expectInvariants();
    });
  }

  for (const point of ["onload.swap.renamed", "onload.reuse.cleared"]) {
    test(`a renamed-back onload stopped at ${point} is finished: the trash and its offload journal go (N5)`, async () => {
      config('[offload]\nkeepLocalFor = "24h"');
      const off = await offload();
      await expect(onload({}, {}, testHost({ faults: { at: point } }))).rejects.toBeInstanceOf(InjectedFault);
      const journal = ((await readJournals(testHost(), box.paths)).journals as OnloadJournal[]).find(
        (j) => j.kind === "onload",
      );
      if (journal === undefined) throw new Error("no onload journal");
      expect(journal.reuse?.op).toBe(off.op);
      const saga = openSaga<OnloadJournal, OnloadStep>(
        { io: testHost(), paths: box.paths, faultAt: () => {}, clock: () => new Date(), log: () => {} },
        journal,
      );
      value(
        await finishOnload({
          host: testHost(),
          paths: box.paths,
          saga,
          store,
          device: device.id,
          clock: () => new Date(),
          log: () => {},
        }),
      );
      expect(existsSync(join(box.home, "work/.plainport-trash", off.op))).toBe(false);
      expect((await readJournals(testHost(), box.paths)).journals).toEqual([]);
      expect(existsSync(join(dir, "node_modules/dep/index.js"))).toBe(true);
      await expectInvariants();
    });
  }

  test("finishOnload's failures speak of the onload, whatever its saga was opened as (N4)", async () => {
    await offload();
    await expect(onload({}, {}, testHost({ faults: { at: "onload.swap.renamed" } }))).rejects.toBeInstanceOf(
      InjectedFault,
    );
    const [journal] = (await readJournals(testHost(), box.paths)).journals as OnloadJournal[];
    const real = testHost();
    const broken: HostPorts = {
      ...real,
      fs: {
        ...real.fs,
        writeTextDurable: async (path, text) => {
          if (path.startsWith(box.paths.journalDir))
            throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
          return real.fs.writeTextDurable(path, text);
        },
      },
    };
    const saga = openSaga<OnloadJournal, OnloadStep>(
      { io: broken, paths: box.paths, faultAt: () => {}, clock: () => new Date(), log: () => {} },
      journal as OnloadJournal,
    );
    const failed = await finishOnload({
      host: broken,
      paths: box.paths,
      saga,
      store,
      device: device.id,
      clock: () => new Date(),
      log: () => {},
    });
    expect(!failed.ok && failed.finding.message).toContain("the files are in place");
    expect(!failed.ok && failed.finding.fix).toContain("finish the onload");
  });

  test("before the rename, onloadSwapped says so: recover rolls back instead", async () => {
    await offload();
    await expect(onload({}, {}, testHost({ faults: { at: "onload.swap.start" } }))).rejects.toBeInstanceOf(
      InjectedFault,
    );
    const [journal] = (await readJournals(testHost(), box.paths)).journals as OnloadJournal[];
    expect(await onloadSwapped(testHost(), journal as OnloadJournal)).toBe(false);
  });
});

describe("onload: nesting by effective folder (D53 revised, N1)", () => {
  /** A second project, work:api, offloaded, so it can be onloaded with --to. */
  const shelvedApi = async () => {
    box.file("work/api/package.json", `${JSON.stringify({ name: "api" })}\n`);
    box.file("work/api/src/api.ts", "export const api = 1;\n");
    return value(await runOffload(offloadDeps(), { project: await ref("work:api") }));
  };

  test("onload --to into another registered project's folder refuses with project.nested", async () => {
    await shelvedApi();
    // work:web is here (registered, onloaded).
    await offload();
    value(await onload());
    const inside = join(dir, "vendor/api");
    const result = await onload({ project: { address: "work:api" } as ProjectRef, to: inside });
    expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([6, "project.nested"]);
    expect(!result.ok && result.finding.message).toContain("work:web");
    expect(existsSync(inside)).toBe(false);
  });

  test("the reviewer's sequence: A's copy placed inside B (--to), work in A, offload B is blocked and A's copy stays", async () => {
    await shelvedApi();
    // A's copy inside B, as an earlier build allowed: the registry's override points into web.
    const apiId = await projectId("api");
    const inside = join(dir, "vendor/api");
    box.file("work/web/vendor/api/src/api.ts", "export const api = 2; // edited in place\n");
    value(
      await updateRegistry(testHost(), box.paths, (r) => ({
        ok: true,
        value: {
          ...r,
          projects: { ...r.projects, [apiId]: { ...(r.projects[apiId] as RegistryEntry), override: inside } },
        },
      })),
    );
    const blocked = await runOffload(offloadDeps(), { project: await ref("work:web") });
    expect(!blocked.ok && [blocked.exitCode, blocked.finding.code]).toEqual([6, "project.nested"]);
    expect(!blocked.ok && blocked.finding.message).toContain("work:api");
    expect(readFileSync(join(inside, "src/api.ts"), "utf8")).toBe(
      "export const api = 2; // edited in place\n",
    );
    expect(existsSync(dir)).toBe(true);
  });

  test("a project whose copy lies inside another's folder is locked by it: dehydrate of the outer exits 11 and spares it", async () => {
    const apiId = ulid();
    const inside = join(dir, "vendor/api");
    box.file("work/web/vendor/api/package.json", `${JSON.stringify({ name: "api" })}\n`);
    box.file("work/web/vendor/api/package-lock.json", `${JSON.stringify({ lockfileVersion: 3 })}\n`);
    box.file("work/web/vendor/api/node_modules/x/index.js", "x\n");
    value(
      await updateRegistry(testHost(), box.paths, (r) => ({
        ok: true,
        value: {
          ...r,
          projects: {
            ...r.projects,
            [apiId]: { root: "work", path: "api", override: inside, registeredAt: new Date().toISOString() },
          },
        },
      })),
    );
    const commandDeps = {
      host: testHost(),
      checks: quietChecks,
      plugins: [nodePlugin],
      env: env(),
      paths: box.paths,
      loader: new ConfigLoader(testHost(), box.paths),
      emit: () => {},
      log: () => {},
    };
    holdLock(apiId);
    const held = await runDehydrate(commandDeps, { project: await ref() });
    expect(!held.ok && [held.exitCode, held.finding.code]).toEqual([11, "project.locked"]);
    rmSync(join(box.paths.locksDir, `${apiId}.lock`));
    const done = value(await runDehydrate(commandDeps, { project: await ref() }));
    expect(done.removed.map((r) => r.path)).toEqual(["node_modules"]);
    expect(existsSync(join(inside, "node_modules/x/index.js"))).toBe(true);
  });
});

describe("onload: nesting by canonical folder (R1, R2)", () => {
  const shelvedApi = async () => {
    box.file("work/api/package.json", `${JSON.stringify({ name: "api" })}\n`);
    box.file("work/api/src/api.ts", "export const api = 1;\n");
    return value(await runOffload(offloadDeps(), { project: await ref("work:api") }));
  };
  /** work:web registered and here (offloaded once, onloaded back). */
  const webHere = async () => {
    await offload();
    value(await onload());
  };
  /** A's copy placed at `spelling` (inside web), as an older build allowed, with work in it. */
  const placeApiAt = async (spelling: string) => {
    const apiId = await projectId("api");
    box.file("work/web/vendor/api/src/api.ts", "export const api = 2; // edited in place\n");
    value(
      await updateRegistry(testHost(), box.paths, (r) => ({
        ok: true,
        value: {
          ...r,
          projects: {
            ...r.projects,
            [apiId]: { ...(r.projects[apiId] as RegistryEntry), override: spelling },
          },
        },
      })),
    );
  };
  const expectWebOffloadRefused = async () => {
    const blocked = await runOffload(offloadDeps(), { project: await ref("work:web") });
    expect(!blocked.ok && [blocked.exitCode, blocked.finding.code]).toEqual([6, "project.nested"]);
    expect(readFileSync(join(dir, "vendor/api/src/api.ts"), "utf8")).toContain("edited in place");
  };
  const insensitiveHere = async () => {
    const probed = await canonicalPath(testHost(), dir, box.home);
    return probed.ok && probed.value.caseInsensitive;
  };

  test("a --to typed in another case on a case-insensitive volume is inside B: refused, and B's offload too", async () => {
    if (!(await insensitiveHere())) return; // a case-sensitive volume: the spellings are two folders
    await shelvedApi();
    await webHere();
    const otherCase = join(box.home, "WORK/WEB/vendor/api");
    const onloaded = await onload({ project: { address: "work:api" } as ProjectRef, to: otherCase });
    expect(!onloaded.ok && [onloaded.exitCode, onloaded.finding.code]).toEqual([6, "project.nested"]);
    await placeApiAt(otherCase);
    await expectWebOffloadRefused();
  });

  test("a --to reached through a symlink is inside B: refused, and B's offload too", async () => {
    await shelvedApi();
    await webHere();
    symlinkSync(join(box.home, "work"), join(box.home, "via"));
    const linked = join(box.home, "via/web/vendor/api");
    const onloaded = await onload({ project: { address: "work:api" } as ProjectRef, to: linked });
    expect(!onloaded.ok && [onloaded.exitCode, onloaded.finding.code]).toEqual([6, "project.nested"]);
    await placeApiAt(linked);
    await expectWebOffloadRefused();
  });

  test("a --to equal to another registered project's folder (B shelved) is refused (R2)", async () => {
    await shelvedApi();
    await offload();
    expect(existsSync(dir)).toBe(false);
    const result = await onload({ project: { address: "work:api" } as ProjectRef, to: dir });
    expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([6, "project.nested"]);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(`${dir}.plainport`)).toBe(true);
  });
});

describe("onload: a store that blips before the swap (N3)", () => {
  test("an unreachable store at the head re-read keeps the journal and staging; the next onload resumes", async () => {
    await offload();
    let blip = false;
    const flaky = {
      ...store,
      list: async (prefix: string) =>
        blip
          ? {
              ok: false as const,
              exitCode: 9 as const,
              finding: {
                code: "store.unreachable",
                severity: "block" as const,
                message: "the disk went away",
                allowable: false,
              },
            }
          : store.list(prefix),
    };
    engine.hooks.duringRestore = () => {
      blip = true;
    };
    const first = await onload(
      {},
      {
        opener: { open: async () => ({ ok: true, value: { blob: flaky, engine } }) },
        openMirror: async () => ({ ok: true, value: memoryBlobStore({ createIfAbsent: true }) }),
      },
    );
    expect(!first.ok && first.exitCode).toBe(9);
    const [journal] = (await readJournals(testHost(), box.paths)).journals as OnloadJournal[];
    expect(journal?.step).toBe("onload.verified");
    expect(existsSync(join(journal?.staging ?? "", "src/main.ts"))).toBe(true);
    engine.hooks.duringRestore = undefined;
    const second = value(await onload());
    expect(second.op).toBe(journal?.op as string);
    await expectInvariants();
  });
});

describe("onload: the same head's folder still in the trash", () => {
  test("with keepLocalFor, onloading the same head renames the folder back instead of restoring it", async () => {
    config('[offload]\nkeepLocalFor = "24h"');
    const before = treeOf(dir);
    const off = await offload();
    const trash = join(box.home, "work/.plainport-trash", off.op);
    expect(existsSync(join(trash, "web/node_modules/dep/index.js"))).toBe(true);

    const result = value(await onload());
    expect(result).toMatchObject({ restored: "reuse", snapshot: off.op, hydrate: { status: "reused" } });
    expect(steps).toContain("onload.reuse.cleared");
    // The totals are the snapshot's, as its offloaded event recorded them.
    const stats = (await storeEvents()).find((e) => e.type === "offloaded");
    expect(stats?.type === "offloaded" && [result.files, result.bytes]).toEqual(
      stats?.type === "offloaded" ? [stats.stats.files, stats.stats.bytes] : [],
    );
    expect(result.files).toBeGreaterThan(0);
    expect(steps).not.toContain("onload.restore.start");
    expect(engine.restores).toEqual([]);
    expect(pmCalls()).toEqual([]);
    expect(treeOf(dir)).toEqual(before);
    // The dependencies came back with the folder.
    expect(existsSync(join(dir, "node_modules/dep/index.js"))).toBe(true);
    expect(existsSync(trash)).toBe(false);
    expect(existsSync(`${dir}.plainport`)).toBe(false);
    expect((await readJournals(testHost(), box.paths)).journals).toEqual([]);
    expect((await storeEvents()).find((e) => e.type === "onloaded")).toMatchObject({
      base: off.op,
      over: off.op,
    });
    await expectInvariants();
  });

  test("a trash folder that changed since it was verified is not renamed back: the snapshot is restored", async () => {
    config('[offload]\nkeepLocalFor = "24h"');
    const off = await offload();
    const trash = join(box.home, "work/.plainport-trash", off.op, "web");
    writeFileSync(join(trash, "src/main.ts"), "edited in the trash\n");
    const result = value(await onload());
    expect(result.restored).toBe("restore");
    expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe("export const main = 1;\n");
    // The trash stays for its own deadline; it is not this onload's.
    expect(existsSync(trash)).toBe(true);
    await expectInvariants();
  });
});

describe("onload: preflight refusals change nothing", () => {
  test("an occupied target refuses with path.occupied and suggests --to; it never merges", async () => {
    await offload();
    box.file("work/web/other.txt", "someone else's folder\n");
    const result = await onload();
    expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([6, "path.occupied"]);
    expect(!result.ok && result.finding.fix).toContain("--to");
    expect(readdirSync(dir)).toEqual(["other.txt"]);
    expect(engine.restores).toEqual([]);
    expect((await storeEvents()).filter((e) => e.type === "onloaded")).toEqual([]);
  });

  test("--to <path> onloads beside an occupied place, and records it as the project's folder here", async () => {
    const before = treeOf(dir);
    await offload();
    const elsewhere = join(box.home, "elsewhere/web");
    mkdirSync(join(box.home, "elsewhere"));
    const result = value(await onload({ to: elsewhere }));
    expect(result.dir).toBe(elsewhere);
    expect(treeOf(elsewhere)).toEqual(before);
    expect(existsSync(`${dir}.plainport`)).toBe(false);
    const id = await projectId();
    expect(value(await readRegistry(testHost(), box.paths)).projects[id]?.override).toBe(elsewhere);
    // The staging holder beside the landing place goes once empty (C2); it stays only while another onload uses it.
    expect(readdirSync(join(box.home, "elsewhere")).sort()).toEqual(["web"]);
    await expectInvariants("web", elsewhere);
  });

  test("the fix path.occupied prints works: --to lands beside an unrelated folder at the project's place (D56)", async () => {
    await offload();
    box.file("work/web/other.txt", "someone else's folder\n");
    const refused = await onload();
    expect(!refused.ok && refused.finding.fix).toContain("--to <path>");
    mkdirSync(join(box.home, "elsewhere"));
    const elsewhere = join(box.home, "elsewhere/web");
    const result = value(await onload({ to: elsewhere }));
    expect(result.dir).toBe(elsewhere);
    expect(existsSync(join(elsewhere, "src/main.ts"))).toBe(true);
    expect(readdirSync(dir)).toEqual(["other.txt"]);
    expect(existsSync(`${dir}.plainport`)).toBe(false);
    await expectInvariants("web", elsewhere);
  });

  test("--to refuses while this project's own onloaded copy is here (project.already-local, D56): one copy per device", async () => {
    await offload();
    value(await onload());
    mkdirSync(join(box.home, "elsewhere"));
    const second = await onload({ to: join(box.home, "elsewhere/web") });
    expect(!second.ok && [second.exitCode, second.finding.code]).toEqual([6, "project.already-local"]);
    expect(!second.ok && second.finding.fix).toContain("plainport restore work:web --snapshot");
    expect(readdirSync(join(box.home, "elsewhere"))).toEqual([]);
    await expectInvariants();
  });

  test("--to, offload, plain onload: the project lands where the registry says, and stays one copy (I1, D56)", async () => {
    await offload();
    mkdirSync(join(box.home, "elsewhere"));
    const elsewhere = join(box.home, "elsewhere/web");
    value(await onload({ to: elsewhere }));
    const id = await projectId();
    expect(value(await readRegistry(testHost(), box.paths)).projects[id]?.override).toBe(elsewhere);
    // Offloaded from there: the stub stands beside it, the registry keeps the override.
    const off = value(await runOffload(offloadDeps(), { project: await ref() }));
    await settledOffload(box.paths, off);
    expect(existsSync(`${elsewhere}.plainport`)).toBe(true);
    expect(value(await readRegistry(testHost(), box.paths)).projects[id]?.override).toBe(elsewhere);
    // A plain onload lands there again, and the registry still says so.
    const back = value(await onload());
    expect(back.dir).toBe(elsewhere);
    expect(value(await readRegistry(testHost(), box.paths)).projects[id]?.override).toBe(elsewhere);
    expect(existsSync(dir)).toBe(false);
    // A second working copy is impossible: at its place it is already onloaded, elsewhere it is already local.
    const again = await onload();
    expect(!again.ok && [again.exitCode, again.finding.code]).toEqual([6, "path.occupied"]);
    const atPlace = await onload({ to: dir });
    expect(!atPlace.ok && [atPlace.exitCode, atPlace.finding.code]).toEqual([6, "project.already-local"]);
    expect(existsSync(dir)).toBe(false);
    await expectInvariants("web", elsewhere);
  });

  test("--to the root's own place records no override (nit)", async () => {
    await offload();
    value(await onload({ to: dir }));
    expect(
      value(await readRegistry(testHost(), box.paths)).projects[await projectId()]?.override,
    ).toBeUndefined();
    await expectInvariants();
  });

  test("a folder kept after offload.diverged-after-commit is this project's own copy: path.occupied says so", async () => {
    await offload();
    value(await onload());
    // The folder stands with no stub while the catalog says shelved (D52): as offload leaves it after an edit.
    const id = await projectId();
    const head = foldCatalog(await storeEvents()).projects[id]?.head as string;
    const off = value(
      await appendEvent(storeEventLog(store), {
        v: 1,
        id: ulid(),
        type: "offloaded",
        device: device.id,
        at: new Date().toISOString(),
        op: ulid(),
        project: id,
        root: foldCatalog(await storeEvents()).projects[id]?.root as string,
        path: "web",
        base: head,
        snapshot: ulid(),
        stored: { ssd: "a".repeat(64) },
        stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
      }),
    );
    expect(off).toBeUndefined();
    const result = await onload();
    expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([6, "path.occupied"]);
    expect(!result.ok && result.finding.message).toContain("this project's own working copy");
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    await expectInvariants();
  });

  test("a project already onloaded here is named as such: path.occupied, never merged", async () => {
    await offload();
    value(await onload());
    const again = await onload();
    expect(!again.ok && [again.exitCode, again.finding.code]).toEqual([6, "path.occupied"]);
    expect(!again.ok && again.finding.message).toBe(
      `work:web is already onloaded here, at ${dir}; onload never merges into it`,
    );
    expect(!again.ok && again.finding.fix).toContain("plainport offload work:web --yes");
    await expectInvariants();
  });

  test("free space short of the snapshot, the dependencies and 10% refuses with fs.no-space", async () => {
    await offload();
    const real = testHost();
    const host: HostPorts = { ...real, fs: { ...real.fs, freeBytes: async () => 100 } };
    const result = await onload({}, {}, host);
    expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([6, "fs.no-space"]);
    expect(engine.restores).toEqual([]);
    await expectShelvedUntouched();
  });

  test("names that differ only by case block on a case-insensitive volume (fs.case-collision)", async () => {
    await offload();
    const insensitive = (await canonicalPath(testHost(), join(box.home, "work"), box.home)).ok
      ? (
          (await canonicalPath(testHost(), join(box.home, "work"), box.home)) as {
            value: { caseInsensitive: boolean };
          }
        ).value.caseInsensitive
      : false;
    engine.hooks.listing = (entries) => [
      ...entries,
      { ...(entries.find((e) => e.path === "src/main.ts") as (typeof entries)[number]), path: "src/MAIN.ts" },
    ];
    const result = await onload();
    if (insensitive) {
      expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([6, "fs.case-collision"]);
      expect(!result.ok && result.finding.paths).toEqual(["src/MAIN.ts", "src/main.ts"]);
      await expectShelvedUntouched();
    } else expect(!result.ok && result.finding.code).not.toBe("fs.case-collision");
  });

  test("a held lock exits 11; an interrupted operation's journal exits 6 with journal.pending", async () => {
    await offload();
    const id = await projectId();
    mkdirSync(box.paths.locksDir, { recursive: true });
    writeFileSync(
      join(box.paths.locksDir, `${id}.lock`),
      `${JSON.stringify({ pid: process.ppid, host: (await import("node:os")).hostname(), startedAt: new Date().toISOString(), token: "t" })}\n`,
    );
    const locked = await onload();
    expect(!locked.ok && [locked.exitCode, locked.finding.code]).toEqual([11, "project.locked"]);
    rmSync(join(box.paths.locksDir, `${id}.lock`));
    await expectShelvedUntouched();

    // An offload of the project stopped after its commit holds it back: journal.pending, exit 6.
    const crash = testHost({ faults: { at: "offload.release.moved" } });
    value(await onload());
    await expect(runOffload(offloadDeps(crash), { project: await ref() })).rejects.toBeInstanceOf(
      InjectedFault,
    );
    const pending = await onload();
    expect(!pending.ok && [pending.exitCode, pending.finding.code]).toEqual([6, "journal.pending"]);
  });

  test("the lock of a registered project holding this one is taken too (D53): held, it exits 11", async () => {
    await offload();
    // work:web/inner is registered too, as root scan would have it.
    const outer = await projectId();
    const inner = ulid();
    value(
      await updateRegistry(testHost(), box.paths, (r) => ({
        ok: true,
        value: {
          ...r,
          projects: {
            ...r.projects,
            [inner]: { root: "work", path: "web/inner", registeredAt: new Date().toISOString() },
          },
        },
      })),
    );
    mkdirSync(box.paths.locksDir, { recursive: true });
    writeFileSync(
      join(box.paths.locksDir, `${inner}.lock`),
      `${JSON.stringify({ pid: process.ppid, host: (await import("node:os")).hostname(), startedAt: new Date().toISOString(), token: "t" })}\n`,
    );
    const result = await onload();
    expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([11, "project.locked"]);
    expect(!result.ok && result.finding.message).toContain("work:web/inner");
    expect(existsSync(join(box.paths.locksDir, `${outer}.lock`))).toBe(false);
    rmSync(join(box.paths.locksDir, `${inner}.lock`));
  });

  test("an unreachable store exits 9 before anything is restored", async () => {
    await offload();
    const result = await onload(
      {},
      {
        openMirror: async () => ({ ok: true, value: memoryBlobStore({ createIfAbsent: true }) }),
        opener: {
          open: async () => ({
            ok: true,
            value: {
              blob: {
                ...store,
                list: async () => ({
                  ok: false,
                  exitCode: 9,
                  finding: {
                    code: "store.unreachable",
                    severity: "block",
                    message: "the disk is not mounted",
                    allowable: false,
                  },
                }),
              },
              engine,
            },
          }),
        },
      },
    );
    expect(!result.ok && result.exitCode).toBe(9);
    await expectShelvedUntouched();
  });

  test("an incomplete head refuses with catalog.incomplete (D44)", async () => {
    await offload();
    const id = await projectId();
    const root = foldCatalog(await storeEvents()).projects[id]?.root as string;
    const produce = (base: string) =>
      appendEvent(storeEventLog(store), {
        v: 1,
        id: ulid(),
        type: "offloaded",
        device: ulid(),
        at: new Date().toISOString(),
        op: ulid(),
        project: id,
        root,
        path: "web",
        base,
        snapshot: ulid(),
        stored: { ssd: "b".repeat(64) },
        stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
      });
    value(await produce(ulid()));
    const incomplete = await onload();
    expect(!incomplete.ok && [incomplete.exitCode, incomplete.finding.code]).toEqual([
      6,
      "catalog.incomplete",
    ]);

    await expectShelvedUntouched();
  });

  test("a conflicted head refuses with catalog.head-moved (exit 8) and names restore, which exists (I1)", async () => {
    const off = await offload();
    const id = await projectId();
    const root = foldCatalog(await storeEvents()).projects[id]?.root as string;
    for (let i = 0; i < 2; i++)
      value(
        await appendEvent(storeEventLog(store), {
          v: 1,
          id: ulid(),
          type: "offloaded",
          device: ulid(),
          at: new Date().toISOString(),
          op: ulid(),
          project: id,
          root,
          path: "web",
          base: off.op,
          snapshot: ulid(),
          stored: { ssd: "c".repeat(64) },
          stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
        }),
      );
    const result = await onload();
    expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([8, "catalog.head-moved"]);
    expect(!result.ok && result.finding.fix).toContain(
      "plainport restore work:web --snapshot <id> --to <path>",
    );
    await expectShelvedUntouched();
  });

  test("another device's lease is a warning (lease.held); with leases = strict it refuses with exit 8", async () => {
    const off = await offload();
    const id = await projectId();
    const root = foldCatalog(await storeEvents()).projects[id]?.root as string;
    value(
      await appendEvent(storeEventLog(store), {
        v: 1,
        id: ulid(),
        type: "onloaded",
        device: ulid(),
        at: new Date().toISOString(),
        op: ulid(),
        project: id,
        root,
        path: "web",
        base: off.op,
        over: off.op,
      }),
    );
    config('[onload]\nleases = "strict"');
    const strict = await onload();
    expect(!strict.ok && [strict.exitCode, strict.finding.code]).toEqual([8, "lease.held"]);
    // Its severity is the catalogue's, whatever the mode: the exit code says it refused (N6).
    expect(!strict.ok && strict.finding.severity).toBe(FINDINGS["lease.held"].severity);
    await expectShelvedUntouched();

    config();
    value(await onload());
    const warned = events.filter((e) => e.type === "finding" && e.finding.code === "lease.held");
    expect(warned).toHaveLength(1);
    expect(warned[0]?.type === "finding" && warned[0].finding.severity).toBe("warn");
    await expectInvariants();
  });
});

describe("onload: verification of the staged tree", () => {
  test("a restored file that differs from the listing fails with verify.mismatch; staging is removed, the stub stays", async () => {
    await offload();
    engine.hooks.duringRestore = (target) => writeFileSync(join(target, "src/main.ts"), "short");
    const result = await onload();
    expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([7, "verify.mismatch"]);
    expect(!result.ok && result.finding.message).toContain("src/main.ts");
    await expectShelvedUntouched();
    await expectInvariants();
  });

  test("a restored link whose real target differs from the listing is refused (readlink, not the listing's word)", async () => {
    await offload();
    engine.hooks.duringRestore = (target) => {
      rmSync(join(target, "main-link"));
      symlinkSync("src/elsewhere.ts", join(target, "main-link"));
    };
    const result = await onload();
    expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([7, "verify.mismatch"]);
    expect(!result.ok && result.finding.message).toContain("main-link");
    await expectShelvedUntouched();
  });

  test("a restore that fails part-way removes its staging folder and changes nothing else", async () => {
    await offload();
    engine.hooks.failNext = {
      restore: {
        ok: false,
        exitCode: 1,
        finding: {
          code: "restic.failed",
          severity: "block",
          message: "restic restore failed",
          allowable: false,
        },
      },
    };
    const result = await onload();
    expect(!result.ok && result.finding.code).toBe("restic.failed");
    await expectShelvedUntouched();
    await expectInvariants();
  });

  test("Ctrl-C before the swap stops at a safe point: exit 130, staging removed, the stub stays", async () => {
    await offload();
    const stop = new AbortController();
    engine.hooks.duringRestore = () => stop.abort();
    const result = await onload({}, { signal: stop.signal });
    expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([130, "operation.cancelled"]);
    await expectShelvedUntouched();
  });
});

describe("onload: hydration", () => {
  test("a failed install leaves the files and exits 10 with the project and snapshot as data (D14)", async () => {
    const off = await offload();
    const result = await runOnload(deps({ env: env({ FAKE_PM_FAIL: "1" }) }), { project: await ref() });
    expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([10, "hydrate.failed"]);
    expect(!result.ok && result.finding.fix).toBe("plainport hydrate work:web");
    expect(!result.ok && result.finding.message).toContain("offline");
    expect(!result.ok && result.data).toMatchObject({
      exitCode: 10,
      project: "work:web",
      snapshot: off.op,
      hydrate: { status: "failed", steps: [{ command: "npm ci", ok: false, exitCode: 1 }] },
    });
    // The files are safe and the project is local: restored-unhydrated.
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    expect(existsSync(`${dir}.plainport`)).toBe(false);
    const id = await projectId();
    expect(value(await readRegistry(testHost(), box.paths)).projects[id]?.unhydrated).toBe(true);
    expect(foldCatalog(await storeEvents()).projects[id]?.status).toBe("local");
    await expectInvariants();

    // plainport hydrate retries, and succeeds once the registry is reachable again.
    const retried = value(
      await runHydrate(
        {
          host: testHost(),
          plugins: [nodePlugin],
          env: env(),
          paths: box.paths,
          loader: new ConfigLoader(testHost(), box.paths),
          emit: () => {},
          log: () => {},
        },
        { project: await ref() },
      ),
    );
    expect(retried).toMatchObject({ exitCode: 0, project: "work:web", hydrate: { status: "installed" } });
    expect(value(await readRegistry(testHost(), box.paths)).projects[id]?.unhydrated).toBeUndefined();
    expect(pmCalls()).toHaveLength(2);
  });

  test("Ctrl-C during the install after a good restore exits 130; the project is restored-unhydrated (D56)", async () => {
    const off = await offload();
    writeFileSync(join(bin, "npm"), '#!/bin/sh\necho "$PWD|npm $*" >> "$FAKE_PM_LOG"\nexec sleep 600\n');
    chmodSync(join(bin, "npm"), 0o755);
    const stop = new AbortController();
    const host = testHost({
      faults: {
        onStep: (step) => {
          if (step === "onload.committed") void abortOnceInstalling(stop);
        },
      },
    });
    const result = await runOnload(deps({ signal: stop.signal }, host), { project: await ref() });
    expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([130, "operation.cancelled"]);
    expect(!result.ok && result.finding.fix).toBe("plainport hydrate work:web");
    expect(!result.ok && result.finding.message).toContain(off.op);
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    const id = await projectId();
    expect(value(await readRegistry(testHost(), box.paths)).projects[id]?.unhydrated).toBe(true);
    expect(foldCatalog(await storeEvents()).projects[id]?.status).toBe("local");
    await expectInvariants();

    // plainport hydrate, stopped the same way, also exits 130 and leaves the project restored-unhydrated.
    const again = new AbortController();
    void abortOnceInstalling(again, 2);
    const hydrated = await runHydrate(
      {
        host: testHost(),
        plugins: [nodePlugin],
        env: env(),
        paths: box.paths,
        emit: () => {},
        log: () => {},
        signal: again.signal,
      },
      { project: await ref() },
    );
    expect(!hydrated.ok && [hydrated.exitCode, hydrated.finding.code]).toEqual([130, "operation.cancelled"]);
    expect(value(await readRegistry(testHost(), box.paths)).projects[id]?.unhydrated).toBe(true);
  }, 30_000);

  test("--no-hydrate restores without installing: restored-unhydrated, exit 0", async () => {
    await offload();
    const result = value(await onload({ hydrate: false }));
    expect(result.hydrate.status).toBe("skipped");
    expect(pmCalls()).toEqual([]);
    expect(value(await readRegistry(testHost(), box.paths)).projects[await projectId()]?.unhydrated).toBe(
      true,
    );
    await expectInvariants();
  });

  test("a project file's hydrate.command and hooks never run in M1: they are reported as untrusted (D54)", async () => {
    box.file(
      "work/web/.plainport.toml",
      '[hydrate]\ncommand = "touch pwned"\n[hooks]\npost-onload = ["touch pwned-too"]\n',
    );
    await offload();
    const result = value(await onload());
    expect(result.hydrate.untrusted).toEqual(["hydrate.command", "hooks.post-onload"]);
    expect(existsSync(join(dir, "pwned"))).toBe(false);
    expect(existsSync(join(dir, "pwned-too"))).toBe(false);
    expect(pmCalls()).toHaveLength(1);
    await expectInvariants();
  });

  test("dehydrate removes only the dependencies a plugin claims and git does not track", async () => {
    box.file("work/web/dist/index.js", "built\n");
    const result = value(
      await runDehydrate(
        {
          host: testHost(),
          checks: quietChecks,
          plugins: [nodePlugin],
          env: env(),
          paths: box.paths,
          loader: new ConfigLoader(testHost(), box.paths),
          emit: () => {},
          log: () => {},
        },
        { project: await ref() },
      ),
    );
    expect(result.removed.map((r) => r.path)).toEqual(["node_modules"]);
    expect(result.freedBytes).toBeGreaterThanOrEqual(4000);
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    expect(existsSync(join(dir, ".env"))).toBe(true);
    expect(value(await readRegistry(testHost(), box.paths)).projects[await projectId()]?.unhydrated).toBe(
      true,
    );
    await expectInvariants();
  });

  test("a dehydrate stopped after a removal still marks the project unhydrated (N2)", async () => {
    box.file("work/web/packages/a/package.json", `${JSON.stringify({ name: "a" })}\n`);
    box.file("work/web/packages/a/package-lock.json", `${JSON.stringify({ lockfileVersion: 3 })}\n`);
    box.file("work/web/packages/a/node_modules/y/index.js", "y\n");
    const stop = new AbortController();
    const real = testHost();
    const host: HostPorts = {
      ...real,
      fs: {
        ...real.fs,
        removeTree: async (path) => {
          await real.fs.removeTree(path);
          stop.abort();
        },
      },
    };
    const result = await runDehydrate(
      {
        host,
        checks: quietChecks,
        plugins: [nodePlugin],
        env: env(),
        paths: box.paths,
        loader: new ConfigLoader(testHost(), box.paths),
        emit: () => {},
        log: () => {},
        signal: stop.signal,
      },
      { project: await ref() },
    );
    expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([130, "operation.cancelled"]);
    expect(value(await readRegistry(testHost(), box.paths)).projects[await projectId()]?.unhydrated).toBe(
      true,
    );
  });

  test("dehydrate never strips a registered inner project's dependencies, and takes its lock (D53, D56)", async () => {
    box.file("work/web/packages/inner/package.json", `${JSON.stringify({ name: "inner" })}\n`);
    box.file("work/web/packages/inner/package-lock.json", `${JSON.stringify({ lockfileVersion: 3 })}\n`);
    box.file("work/web/packages/inner/node_modules/x/index.js", "inner\n");
    const inner = ulid();
    value(
      await updateRegistry(testHost(), box.paths, (r) => ({
        ok: true,
        value: {
          ...r,
          projects: {
            ...r.projects,
            [inner]: { root: "work", path: "web/packages/inner", registeredAt: new Date().toISOString() },
          },
        },
      })),
    );
    const commandDeps = {
      host: testHost(),
      checks: quietChecks,
      plugins: [nodePlugin],
      env: env(),
      paths: box.paths,
      loader: new ConfigLoader(testHost(), box.paths),
      emit: () => {},
      log: () => {},
    };
    // Its lock held: dehydrate and hydrate of the outer project both refuse with exit 11.
    holdLock(inner);
    for (const run of [runDehydrate, runHydrate]) {
      const held = await run(commandDeps, { project: await ref() });
      expect(!held.ok && [held.exitCode, held.finding.code]).toEqual([11, "project.locked"]);
    }
    expect(existsSync(join(dir, "node_modules"))).toBe(true);
    rmSync(join(box.paths.locksDir, `${inner}.lock`));
    const result = value(await runDehydrate(commandDeps, { project: await ref() }));
    expect(result.removed.map((r) => r.path)).toEqual(["node_modules"]);
    expect(existsSync(join(dir, "packages/inner/node_modules/x/index.js"))).toBe(true);
  });
});

describe("onload: round trips for every package manager in the golden set", () => {
  for (const c of GOLDEN_CASES) {
    test(`${c.name}: offload then onload is byte-identical minus stripped paths, and runs ${c.name}'s frozen install`, async () => {
      const fx = makeGitFixture(`plainport-onload-golden-${c.name}-`);
      try {
        // The fixture inside the sandbox's root, with what an install and a build leave (never by running one).
        const project = join(box.home, "work", c.name);
        cpSync(join(FIXTURES, c.name), project, { recursive: true });
        fx.git(project, "init", "-q", "--template=");
        fx.git(project, "add", "-A");
        fx.git(project, "commit", "-q", "-m", "fixture");
        for (const [path, bytes] of Object.entries(c.generated)) {
          mkdirSync(join(project, path, ".."), { recursive: true });
          writeFileSync(join(project, path), "x".repeat(bytes));
        }
        writeFileSync(join(project, ".env"), "SECRET=op://vault/item\n");
        const before = treeOf(project, () => false);
        value(await runOffload(offloadDeps(), { project: await ref(`work:${c.name}`) }));
        // The strip set the snapshot was made with: what the install and the build regenerate.
        const excludes = engine.calls.at(-1)?.excludes ?? [];
        expect(excludes.length).toBeGreaterThan(0);
        const outside = (path: string) => excludes.some((x) => path === x || path.startsWith(`${x}/`));
        // The tree as the swap left it, before the install and git's index refresh (which rewrites .git/index).
        let swapped: Record<string, string> = {};
        const host = testHost({
          faults: {
            onStep: (step) => {
              if (step === "onload.committed") swapped = treeOf(project, outside);
            },
          },
        });
        const result = value(
          await onload({ project: { address: `work:${c.name}` } as ProjectRef }, {}, host),
        );
        expect(result.restored).toBe("restore");
        // Byte for byte, modes and links included, apart from the stripped paths.
        expect(swapped).toEqual(
          Object.fromEntries(Object.entries(before).filter(([path]) => !outside(path))),
        );
        expect(readFileSync(join(project, ".env"), "utf8")).toBe("SECRET=op://vault/item\n");
        const frozen = {
          npm: "npm ci",
          pnpm: "pnpm install --frozen-lockfile",
          "yarn-classic": "yarn install --frozen-lockfile",
          "yarn-berry": "yarn install --immutable",
          bun: "bun install --frozen-lockfile",
          monorepo: "pnpm install --frozen-lockfile",
        }[c.name];
        // The toolchain step may ask a manager its version (packageManager); the install is the one other call.
        expect(
          pmCalls()
            .map((l) => l.split("|")[1])
            .filter((call) => !call?.endsWith(" --version")),
        ).toEqual([frozen]);
        expect(result.hydrate.status).toBe("installed");
        await expectInvariants(c.name);
      } finally {
        fx.cleanup();
      }
    });
  }
});

describe("onload: case collisions on hdiutil images", () => {
  const testOnMac = macOnlyTests();
  testOnMac(
    "names that differ by case land on a case-sensitive image, and block on a case-insensitive one",
    async () => {
      const images = box.dir("images");
      const attach = (name: string, fs: string): string => {
        const image = join(images, `${name}.dmg`);
        const mount = join(images, name);
        const made = Bun.spawnSync([
          "hdiutil",
          "create",
          "-quiet",
          "-size",
          "20m",
          "-fs",
          fs,
          "-volname",
          name,
          image,
        ]);
        if (made.exitCode !== 0) throw new Error(made.stderr.toString());
        mkdirSync(mount);
        const on = Bun.spawnSync(["hdiutil", "attach", "-quiet", "-nobrowse", "-mountpoint", mount, image]);
        if (on.exitCode !== 0) throw new Error(on.stderr.toString());
        return mount;
      };
      const mounted: string[] = [];
      try {
        const sensitive = attach("sensitive", "Case-sensitive APFS");
        mounted.push(sensitive);
        const insensitive = attach("insensitive", "APFS");
        mounted.push(insensitive);
        // Root work lives on the case-sensitive image; the project there holds Readme.md and README.md.
        config().toString();
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
            `on = { mbp = "${sensitive}" }`,
          ].join("\n"),
        );
        const project = join(sensitive, "web");
        mkdirSync(project);
        writeFileSync(join(project, "Readme.md"), "one\n");
        writeFileSync(join(project, "README.md"), "two\n");
        writeFileSync(join(project, "package.json"), "{}\n");
        value(await runOffload(offloadDeps(), { project: await ref("work:web") }));

        const blocked = await onload({ to: join(insensitive, "web") });
        expect(!blocked.ok && [blocked.exitCode, blocked.finding.code]).toEqual([6, "fs.case-collision"]);
        expect(!blocked.ok && blocked.finding.paths).toEqual(["README.md", "Readme.md"]);
        expect(readdirSync(insensitive).filter((n) => !n.startsWith("."))).toEqual([]);

        const landed = value(await onload());
        expect(landed.dir).toBe(project);
        expect(
          readdirSync(project)
            .filter((n) => n !== "node_modules")
            .sort(),
        ).toEqual(["README.md", "Readme.md", "package.json"]);
        expect(readFileSync(join(project, "Readme.md"), "utf8")).toBe("one\n");
      } finally {
        for (const mount of mounted) Bun.spawnSync(["hdiutil", "detach", "-quiet", "-force", mount]);
      }
    },
    60_000,
  );
});

describe("onload: a newer snapshot the catalog cannot read (D86)", () => {
  /** Two offloads, S1 then S2; S2's offloaded event is then replaced by `bytes` and this device's mirror is emptied. */
  const hideNewest = async (bytes: (id: string) => string) => {
    const first = await offload();
    value(await onload());
    writeFileSync(join(dir, "src/main.ts"), "export const main = 2;\n");
    const second = await offload();
    const newest = (await storeEvents()).find((e) => e.type === "offloaded" && e.snapshot === second.op);
    if (newest === undefined) throw new Error("no offloaded event for the second snapshot");
    const key = `meta/v1/events/${newest.id}.json`;
    const original = store.data.get(key) as Uint8Array;
    store.data.set(key, new TextEncoder().encode(bytes(newest.id)));
    mirror = memoryBlobStore({ createIfAbsent: true });
    /** The event readable again, as after an upgrade or a sync. */
    const reveal = () => {
      store.data.set(key, original);
      mirror = memoryBlobStore({ createIfAbsent: true });
    };
    return { first, second, hidden: newest.id, reveal };
  };
  const malformed = () => '{"v":1,"id":"';
  const unsupported = (id: string) =>
    `${JSON.stringify({ v: 1, id, type: "merged", at: new Date().toISOString() })}\n`;

  const expectStillShelved = async (second: { op: string }) => {
    expect(existsSync(dir)).toBe(false);
    expect(JSON.parse(readFileSync(`${dir}.plainport`, "utf8")).snapshot).toBe(second.op);
    expect((await storeEvents()).filter((e) => e.type === "onloaded")).toHaveLength(1);
    expect((await readJournals(testHost(), box.paths)).journals).toEqual([]);
    expect(engine.restores).toHaveLength(1);
  };

  /** Invariants 1–3 on this device, and 4–6 on the store's events and snapshots. */
  const expectAllInvariants = async (before: string[]) => {
    await expectInvariants();
    expect(
      catalogInvariantViolations({
        events: await storeEvents(),
        snapshotsBefore: before,
        snapshotsNow: engine.repository.snapshots.map((s) => s.info.id),
      }),
    ).toEqual([]);
  };

  for (const [kind, bytes] of [
    ["malformed", malformed],
    ["unsupported", unsupported],
  ] as const) {
    test(`a ${kind} newest event: the default onload refuses with catalog.head-uncertain, naming --snapshot <S2>`, async () => {
      const { first, second, hidden } = await hideNewest(bytes);
      const result = await onload();
      expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([6, "catalog.head-uncertain"]);
      if (result.ok) return;
      expect(result.finding.message).toContain(second.op);
      expect(result.finding.message).toContain(hidden);
      expect(result.finding.message).toContain(`its head ${first.op}`);
      expect(result.finding.fix).toContain(`plainport onload work:web --snapshot ${second.op}`);
      await expectStillShelved(second);
    });

    test(`a ${kind} newest event: --snapshot with the older head refuses the same way`, async () => {
      const { first, second } = await hideNewest(bytes);
      const result = await onload({ snapshot: first.op });
      expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([6, "catalog.head-uncertain"]);
      expect(!result.ok && result.finding.fix).toContain(`--snapshot ${second.op}`);
      await expectStillShelved(second);
    });

    test(`a ${kind} newest event: --snapshot <S2> restores S2 from its tag and removes its stub; invariants hold`, async () => {
      const { second } = await hideNewest(bytes);
      const before = engine.repository.snapshots.map((s) => s.info.id);
      const result = value(await onload({ snapshot: second.op }));
      expect(result).toMatchObject({ snapshot: second.op });
      expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe("export const main = 2;\n");
      expect(existsSync(`${dir}.plainport`)).toBe(false);
      expect((await storeEvents()).filter((e) => e.type === "onloaded").at(-1)).toMatchObject({
        base: second.op,
      });
      await expectAllInvariants(before);
    });
  }

  for (const step of ONLOAD_STEPS) {
    test(`--snapshot <S2> under doubt, crashed at ${step}: recover settles it and invariants 1–6 hold`, async () => {
      const { second, reveal } = await hideNewest(malformed);
      const before = engine.repository.snapshots.map((s) => s.info.id);
      const crash = testHost({ faults: { at: step } });
      await expect(onload({ snapshot: second.op, hydrate: false }, {}, crash)).rejects.toBeInstanceOf(
        InjectedFault,
      );
      const recovered = await recover({
        host: testHost(),
        paths: box.paths,
        device,
        env: env(),
        loader: new ConfigLoader(testHost(), box.paths),
        opener,
        openMirror: async () => ({ ok: true, value: mirror }),
        log: () => {},
      });
      expect(recovered.ok ? [] : [recovered.finding.code]).toEqual([]);
      // Either way the project ends whole: S2 in place without its stub (invariants hold even while its event is
      // unreadable), or rolled back and still shelved under S2's stub, exactly the state the doubt began in, whose
      // invariants hold once S2's event reads again.
      if (existsSync(dir)) {
        expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe("export const main = 2;\n");
        expect(existsSync(`${dir}.plainport`)).toBe(false);
        await expectAllInvariants(before);
      } else {
        expect(JSON.parse(readFileSync(`${dir}.plainport`, "utf8")).snapshot).toBe(second.op);
        expect((await storeEvents()).filter((e) => e.type === "onloaded")).toHaveLength(1);
      }
      reveal();
      await expectAllInvariants(before);
    });
  }

  test("a skipped event that leaves the known snapshot named does not stop the default onload", async () => {
    await offload();
    value(await onload());
    writeFileSync(join(dir, "src/main.ts"), "export const main = 2;\n");
    const second = await offload();
    store.data.set(`meta/v1/events/${ulid()}.json`, new TextEncoder().encode(malformed()));
    mirror = memoryBlobStore({ createIfAbsent: true });
    const result = value(await onload());
    expect(result).toMatchObject({ snapshot: second.op });
    expect(existsSync(`${dir}.plainport`)).toBe(false);
  });

  test("offload of a copy whose base no readable event names refuses with catalog.head-uncertain, not a fork", async () => {
    await offload();
    value(await onload());
    writeFileSync(join(dir, "src/main.ts"), "export const main = 2;\n");
    const second = await offload();
    value(await onload());
    // Every event that names this copy's base (its offload, and the onload that restored it) is unreadable now: the
    // fold shows the first snapshot as the head, which without D86 reads as "the head moved" and commits a fork.
    for (const e of await storeEvents())
      if (e.type !== "root-created" && e.type !== "root-bound" && JSON.stringify(e).includes(second.op))
        store.data.set(`meta/v1/events/${e.id}.json`, new TextEncoder().encode(malformed()));
    mirror = memoryBlobStore({ createIfAbsent: true });
    const before = (await storeEvents()).length;
    const tree = treeOf(dir);
    const result = await runOffload(offloadDeps(), { project: await ref() });
    expect(!result.ok && [result.exitCode, result.finding.code]).toEqual([6, "catalog.head-uncertain"]);
    expect(!result.ok && result.finding.message).toContain(second.op);
    expect(treeOf(dir)).toEqual(tree);
    expect(await storeEvents()).toHaveLength(before);
  });
});
