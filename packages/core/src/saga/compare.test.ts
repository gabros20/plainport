// plainport compare (M2 Task 26) against a sandboxed home, an in-memory store, the fake engine and real git (T0):
// every other head of the project written into its repository as the theirs refs, through a staging folder beside it
// that is removed afterwards, with nothing else on this device changed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, finding, type Result } from "@plainport/contract";
import { nodePlugin } from "../../../eco-node/src/index.ts";
import { appendEvent, readEvents, storeEventLog } from "../catalog/index.ts";
import { ConfigLoader } from "../config/load.ts";
import { type Device, ensureDevice } from "../device.ts";
import { readJournals } from "../journal/index.ts";
import type { StoreOpener } from "../ports/store.ts";
import { readStagingRecords } from "../recover/staging.ts";
import { readRegistry } from "../registry.ts";
import { type ProjectRef, resolveProject } from "../roots/address.ts";
import { setUpStore } from "../store.ts";
import { quietChecks } from "../testing/checks.ts";
import { type FakeEngine, fakeEngine } from "../testing/fake-engine.ts";
import { QUIET_GIT_ENV } from "../testing/git-fixture.ts";
import { testHost } from "../testing/host.ts";
import { type MemoryBlobStore, memoryBlobStore } from "../testing/memory-blob-store.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { settledOffload } from "../testing/settle.ts";
import { ulid } from "../ulid.ts";
import { type CompareDeps, runCompare } from "./compare.ts";
import { runOffload } from "./offload.ts";
import { runOnload } from "./onload.ts";

const PATH = process.env.PATH ?? "/usr/bin:/bin";
const CANARY = "CANARY-0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f";

let box: Sandbox;
let device: Device;
let store: MemoryBlobStore;
let mirror: MemoryBlobStore;
let engine: FakeEngine;
let dir: string;

const opener: StoreOpener = { open: async () => ({ ok: true, value: { blob: store, engine } }) };

const env = () => ({ HOME: box.home, PATH, PLAINPORT_STORE_PASSWORD: "pw", ...QUIET_GIT_ENV });

const gitIn = (cwd: string, ...args: string[]): string => {
  const ran = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: {
      ...env(),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      LC_ALL: "C",
    },
  });
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
  return ran.stdout.toString();
};

beforeEach(async () => {
  box = makeSandbox("plainport-compare-");
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
    ].join("\n"),
  );
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
  box.file("work/web/src/main.ts", "export const main = 1;\n");
  box.file("work/web/.gitignore", ".env\n");
  box.file("work/web/.env", "TOKEN=mine\n");
  dir = join(box.home, "work/web");
});

afterEach(() => box.cleanupSettled());

const gitProject = () => {
  gitIn(dir, "init", "-q");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-q", "-m", "first");
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

const sagaDeps = () => ({
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

const deps = (): CompareDeps => sagaDeps();

/** Offloads web, then onloads it again: the copy here came from the returned snapshot (its registry base). */
const roundTrip = async (): Promise<string> => {
  const done = value(
    await runOffload(
      { ...sagaDeps(), checks: quietChecks, plugins: [nodePlugin] },
      { project: await ref(), allow: ["git.unpushed"] },
    ),
  );
  if (done.keepUntil === undefined) await settledOffload(box.paths, done);
  value(await runOnload({ ...sagaDeps(), plugins: [nodePlugin] }, { project: await ref(), hydrate: false }));
  return done.snapshot;
};

/**
 * Another device's offload over `base`: a copy of the folder, changed by `change`, snapshotted by the engine, and its
 * offloaded event appended to the store. Returns its snapshot id.
 */
const theirOffload = async (base: string, name: string, change: (copy: string) => void): Promise<string> => {
  const copy = join(box.home, "elsewhere", name);
  cpSync(dir, copy, { recursive: true });
  change(copy);
  const snap = value(await engine.snapshot({ dir: copy, excludes: [], tags: [] }, { op: ulid() }));
  rmSync(copy, { recursive: true, force: true });
  const id = Object.keys(value(await readRegistry(testHost(), box.paths)).projects)[0] as string;
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
      base,
      snapshot: s,
      stored: { ssd: snap.id },
      stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
    }),
  );
  return s;
};

/** Everything compare must leave as it was. */
const untouched = async () => ({
  events: value(await readEvents(storeEventLog(store))).events.map((e) => e.id),
  registry: value(await readRegistry(testHost(), box.paths)),
  journals: (await readJournals(testHost(), box.paths)).journals.length,
  staging: await readStagingRecords(testHost(), box.paths),
  holder: existsSync(join(box.home, "work/.plainport-staging")),
  index: existsSync(join(dir, ".git/index")) ? readFileSync(join(dir, ".git/index")).toString("base64") : "",
  status: existsSync(join(dir, ".git"))
    ? gitIn(dir, "--no-optional-locks", "status", "--porcelain=v2", "--branch")
    : "",
  heads: existsSync(join(dir, ".git")) ? gitIn(dir, "for-each-ref", "refs/heads") : "",
});

const theirRefs = () =>
  gitIn(dir, "for-each-ref", "--format=%(refname)", "refs/plainport").split("\n").filter(Boolean);

describe("runCompare", () => {
  test("each other head of a conflict is written as its set; staging is removed and nothing else changes", async () => {
    gitProject();
    const base = await roundTrip();
    const a = await theirOffload(base, "a", (copy) => {
      writeFileSync(join(copy, "src/main.ts"), "export const main = 2;\n");
      writeFileSync(join(copy, ".env"), `TOKEN=${CANARY}\n`);
    });
    const b = await theirOffload(base, "b", (copy) => {
      gitIn(copy, "checkout", "-q", "-b", "feature");
      writeFileSync(join(copy, "src/b.ts"), "export const b = 1;\n");
      gitIn(copy, "add", "src/b.ts");
      gitIn(copy, "commit", "-q", "-m", "feature work");
    });
    const before = await untouched();

    const done = value(await runCompare(deps(), { project: await ref() }));

    expect(done.base).toBe(base);
    expect(done.sets.map((s) => s.snapshot)).toEqual([a, b].sort());
    expect(done.incomplete).toEqual([]);
    expect(theirRefs()).toEqual(
      [a, b]
        .sort()
        .flatMap((s) => [
          `refs/plainport/theirs/${s}/HEAD`,
          ...(s === b ? [`refs/plainport/theirs/${s}/heads/feature`] : []),
          `refs/plainport/theirs/${s}/heads/main`,
          `refs/plainport/theirs/${s}/index`,
          `refs/plainport/theirs/${s}/worktree`,
        ]),
    );
    expect(gitIn(dir, "show", `refs/plainport/theirs/${a}/worktree:src/main.ts`)).toBe(
      "export const main = 2;\n",
    );
    expect(gitIn(dir, "log", "-1", "--format=%s", `refs/plainport/theirs/${b}/heads/feature`).trim()).toBe(
      "feature work",
    );
    const all = Bun.spawnSync(["git", "cat-file", "--batch-all-objects", "--batch"], {
      cwd: dir,
      env: env(),
    });
    expect(all.stdout.toString()).not.toContain(CANARY);
    expect(done.sets.find((s) => s.snapshot === a)?.ignored).toEqual([".env"]);
    expect(await untouched()).toEqual(before);
  });

  test("a rerun with nothing changed changes no ref", async () => {
    gitProject();
    const base = await roundTrip();
    await theirOffload(base, "a", (copy) => writeFileSync(join(copy, "x.txt"), "x\n"));
    value(await runCompare(deps(), { project: await ref() }));
    const refs = gitIn(dir, "for-each-ref", "--format=%(objectname) %(refname)", "refs/plainport");
    const again = value(await runCompare(deps(), { project: await ref() }));
    expect(again.sets.map((s) => s.changed)).toEqual([false]);
    expect(gitIn(dir, "for-each-ref", "--format=%(objectname) %(refname)", "refs/plainport")).toBe(refs);
  });

  test("no other head: nothing to compare, and nothing written", async () => {
    gitProject();
    await roundTrip();
    const done = value(await runCompare(deps(), { project: await ref() }));
    expect(done.sets).toEqual([]);
    expect(done.nothing).toContain("no other head");
    expect(theirRefs()).toEqual([]);
  });

  test("a set left incomplete is replaced whole by the next run", async () => {
    gitProject();
    const base = await roundTrip();
    const a = await theirOffload(base, "a", (copy) => writeFileSync(join(copy, "x.txt"), "x\n"));
    value(await runCompare(deps(), { project: await ref() }));
    gitIn(dir, "update-ref", "-d", `refs/plainport/theirs/${a}/heads/main`);
    const done = value(await runCompare(deps(), { project: await ref() }));
    expect(done.sets.map((s) => [s.snapshot, s.changed])).toEqual([[a, true]]);
    expect(done.incomplete).toEqual([]);
    expect(theirRefs()).toContain(`refs/plainport/theirs/${a}/heads/main`);
  });

  test("a set of a snapshot that is no longer a head, left incomplete, is listed until --clean", async () => {
    gitProject();
    await roundTrip();
    const stale = ulid();
    gitIn(dir, "update-ref", `refs/plainport/theirs/${stale}/HEAD`, "HEAD");
    const done = value(await runCompare(deps(), { project: await ref() }));
    expect(done.incomplete).toEqual([
      { snapshot: stale, leaves: ["HEAD"], complete: false, missing: ["worktree"], extra: [] },
    ]);
  });

  test("--clean removes only refs/plainport/theirs/**", async () => {
    gitProject();
    const base = await roundTrip();
    await theirOffload(base, "a", (copy) => writeFileSync(join(copy, "x.txt"), "x\n"));
    value(await runCompare(deps(), { project: await ref() }));
    gitIn(dir, "update-ref", "refs/plainport/keep", "HEAD");
    const done = value(await runCompare(deps(), { project: await ref(), clean: true }));
    expect(done.removed).toHaveLength(4);
    expect(theirRefs()).toEqual(["refs/plainport/keep"]);
  });

  test("a project that is not a git repository refuses with the paths that differ", async () => {
    const base = await roundTrip();
    await theirOffload(base, "a", (copy) => {
      writeFileSync(join(copy, "src/main.ts"), "export const main = 2;\n");
      writeFileSync(join(copy, "added.txt"), "new\n");
    });
    const before = await untouched();
    const done = await runCompare(deps(), { project: await ref() });
    expect(done.ok ? 0 : [done.exitCode, done.finding.code]).toEqual([6, "compare.not-git"]);
    expect(done.ok ? [] : done.finding.paths).toEqual([join(dir, "added.txt"), join(dir, "src/main.ts")]);
    expect(done.ok ? "" : done.finding.fix).toContain("plainport restore work:web --snapshot");
    expect(await untouched()).toEqual(before);
  });

  test("a project with no working copy here refuses", async () => {
    gitProject();
    const done0 = value(
      await runOffload(
        { ...sagaDeps(), checks: quietChecks, plugins: [nodePlugin] },
        { project: await ref(), allow: ["git.unpushed"] },
      ),
    );
    if (done0.keepUntil === undefined) await settledOffload(box.paths, done0);
    const done = await runCompare(deps(), { project: await ref() });
    expect(done.ok ? 0 : [done.exitCode, done.finding.code]).toEqual([6, "compare.not-local"]);
  });

  test("a restore that fails leaves no staging and no refs", async () => {
    gitProject();
    const base = await roundTrip();
    await theirOffload(base, "a", (copy) => writeFileSync(join(copy, "x.txt"), "x\n"));
    engine.hooks.failNext = { restore: fail(finding("restic.failed", { message: "restore failed" })) };
    const before = await untouched();
    const done = await runCompare(deps(), { project: await ref() });
    expect(done.ok ? "" : done.finding.code).toBe("restic.failed");
    expect(theirRefs()).toEqual([]);
    expect(await untouched()).toEqual(before);
  });
});
