// The crash matrix, subprocess variant (T1; ADR-0017): every row the matrix enumerates (matrix.ts), run by the
// compiled binary with the real restic on a local store, killed by a real SIGKILL at the row's step or seam, then
// `plainport recover`, then the row's checks (checks.ts). A dead process leaves what an InjectedFault cannot: its
// lock file naming a pid that is gone, a detached delete still running, nothing unwound.
//
// The binary is built for the matrix (`--define globalThis.PLAINPORT_TEST_HOOKS=true`, packages/cli/src/test-hooks.ts)
// and kills itself at the step (PLAINPORT_TEST_FAULT_AT): exact, and it reaches the after-effect seams, which write no
// journal for a watcher to see. Branches that need the world to change mid-run pause the binary just before restic
// starts (PLAINPORT_TEST_PAUSE_AT) while the test changes it, as the in-process variant's fake engine hooks do.
//
// macOS only in M1: the binary has only the macOS host, so on Linux its preflight refuses safely (no BSD `find -flags`
// for fs.dataless, no /usr/sbin/lsof for proc.open-files) before any step a row needs. The Linux host (host-linux)
// arrives with M3 (Machines), whose VPS leg needs it; then these rows run on Linux as well. The in-process variant
// runs everywhere.
//
// On macOS each row's root lives on a case-sensitive APFS sparse disk image (hdiutil, growing as written) and the
// project gains a case pair; the image is detached and deleted afterwards. Elsewhere the root is in the row's sandbox.
// Rows are independent (each has its own home, root and store), so they run a few at a time
// (PLAINPORT_CRASH_PARALLEL; 6 locally, 3 on CI, never more than the cores): restic derives its key on every call,
// and one row makes some fifteen. A row's deadline starts once it has its slot; whatever it started is killed, restic's
// process groups included, when it ends, passed or failed.

import { afterAll, beforeAll, describe, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fsBlobStore } from "../../packages/blob-fs/src/index.ts";
import { localStores } from "../../packages/cli/src/stores.ts";
import { appendEvent, storeEventLog } from "../../packages/core/src/catalog/index.ts";
import type { RecoveryReport } from "../../packages/core/src/recover/recover.ts";
import { captureTree, type TreeCapture } from "../../packages/core/src/testing/invariants.ts";
import { makeSandbox, type Sandbox } from "../../packages/core/src/testing/sandbox.ts";
import { hostTarget } from "../../packages/core/src/tools.ts";
import { ulid } from "../../packages/core/src/ulid.ts";
import { testHost } from "../../packages/host-macos/src/testing.ts";
import { attachImage, type DiskImage } from "../disk-image.ts";
import { macOnlyTests, onMac } from "../platform.ts";
import { describeT1, tierEnabled } from "../tiers.ts";
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
  removeTree,
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

const checkout = resolve(import.meta.dir, "../..");
const PASSWORD = "crash-matrix-pw";
const STORE = "local";
const REAL_HOME = process.env.PLAINPORT_TRIPWIRE_REAL_HOME ?? "";
/** The test's PATH without the folders under the real home, which the binary's guard refuses (git, lsof, find stay). */
const PATH = (process.env.PATH ?? "/usr/bin:/bin")
  .split(":")
  .filter((p) => REAL_HOME === "" || !(p === REAL_HOME || p.startsWith(`${REAL_HOME}/`)))
  .join(":");
/** Rows at once. */
const PARALLEL = (() => {
  const asked = Number(process.env.PLAINPORT_CRASH_PARALLEL);
  if (Number.isInteger(asked) && asked > 0) return asked;
  return Math.max(1, Math.min(process.env.CI ? 3 : 6, availableParallelism()));
})();
/** One row's time once it has its slot. */
const ROW_MS = 240_000;
/** A row's test timeout: its own time plus the longest wait for a slot. */
const TEST_MS = ROW_MS * (Math.ceil((ALL_ROWS.length + 2) / PARALLEL) + 1);

let scratch: string;
let binary: string;
let tools: string;
let template: ProjectTemplate;
/** The case-sensitive volume (macOS) and its mount point, where each row's root lives. */
let image: DiskImage | undefined;
let volume: string | undefined;

/** Every row's run, so afterAll can stop what a row that never ended left running. */
const runs = new Set<RowRun>();

beforeAll(async () => {
  if (!tierEnabled(1) || !onMac) return;
  scratch = mkdtempSync(join(tmpdir(), "plainport-crash-sub-"));
  binary = join(scratch, "plainport");
  const build = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      join(checkout, "packages/cli/src/main.ts"),
      "--outfile",
      binary,
      "--define",
      "globalThis.PLAINPORT_TEST_HOOKS=true",
    ],
    { cwd: checkout, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(`building the matrix binary: ${build.stderr.toString()}`);
  // The binary refuses every path under the real home (guardFromEnv), the checkout's .tools included: a copy.
  const target = hostTarget();
  if (target === undefined) throw new Error(`no tools for ${process.platform}-${process.arch}`);
  tools = join(scratch, "tools");
  mkdirSync(tools);
  copyFileSync(join(checkout, ".tools", target, "restic"), join(tools, "restic"));
  chmodSync(join(tools, "restic"), 0o755);
  template = makeProjectTemplate();
  if (onMac) {
    image = await attachImage(join(scratch, "image"), {
      size: "256m",
      fs: "Case-sensitive APFS",
      volname: "pp-crash",
      sparse: true,
    });
    volume = image.mount;
  }
}, 180_000);

afterAll(async () => {
  if (!tierEnabled(1) || !onMac) return;
  for (const r of runs) r.stop();
  try {
    await image?.remove();
  } finally {
    template?.cleanup();
    removeTree(scratch);
  }
}, 180_000);

/** Files below a folder (restic's packs under repo/data). */
const countFiles = (dir: string): number => {
  let n = 0;
  const walk = (d: string) => {
    for (const e of existsSync(d) ? readdirSync(d, { withFileTypes: true }) : [])
      if (e.isDirectory()) walk(join(d, e.name));
      else n++;
  };
  walk(dir);
  return n;
};

/** The processes a process started (named `name`, when given). */
const childrenOf = (parent: number, name?: string): number[] =>
  Bun.spawnSync(["pgrep", "-P", String(parent), ...(name === undefined ? [] : ["-x", name])], {
    env: { PATH: "/usr/bin:/bin" },
    stdout: "pipe",
  })
    .stdout.toString()
    .split("\n")
    .filter(Boolean)
    .map(Number);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const signal = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(pid, sig);
  } catch {}
};

/** A few rows at a time. */
let running = 0;
const waiting: (() => void)[] = [];
const slot = async <T>(work: () => Promise<T>): Promise<T> => {
  if (running >= PARALLEL) await new Promise<void>((go) => waiting.push(go));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
};

type Ran = { code: number | null; signal: string | null; out: string; err: string };

const crashAt = (point: string, occurrence = 1) => ({
  PLAINPORT_TEST_FAULT_AT: point,
  PLAINPORT_TEST_FAULT_OCCURRENCE: String(occurrence),
});
const pauseAtUpload = { PLAINPORT_TEST_PAUSE_AT: MATRIX_POINTS.upload };
const offloadArgs = ["offload", "work:web", "--yes", "--json"];
const onloadArgs = ["onload", "work:web", "--no-hydrate", "--json"];

const ok = (ran: Ran, what: string) => {
  if (ran.code !== 0) throw new Error(`${what} exited ${ran.code ?? ran.signal}: ${ran.err}${ran.out}`);
};
const killed = (ran: Ran, what: string) => {
  if (ran.signal !== "SIGKILL")
    throw new Error(`${what} was not killed (exit ${ran.code}, signal ${ran.signal}): ${ran.err}${ran.out}`);
};

/** One row's world: its sandboxed home, its root (on the case-sensitive volume on macOS) and its project. */
class RowRun {
  readonly box: Sandbox;
  /** The folder for this row on the project's volume. */
  readonly area: string;
  readonly root: string;
  readonly dir: string;
  /** The project before the run, plus the scenario's own edits (noteEdit): what no crash may change. */
  reference: TreeHash = new Map();
  /** Invariant 1's capture: the folder before the run, then as the crash left it (in place or in the trash). */
  released: TreeCapture | undefined;
  /** Every binary this row started; stop() kills those still running and every process group they started. */
  private readonly children = new Set<Bun.Subprocess>();
  /** restic process groups the test itself stopped, killed by stop() too. */
  readonly groups = new Set<number>();

  constructor(id: number) {
    this.box = makeSandbox("plainport-crash-sub-");
    this.area = volume === undefined ? this.box.home : join(volume, `row-${id}`);
    this.root = join(this.area, "work");
    this.dir = join(this.root, "web");
    mkdirSync(this.root, { recursive: true });
    copyProject(template, this.dir, { casePair: volume !== undefined });
    this.reference = hashTree(this.dir);
    this.released = captureTree(this.dir);
    runs.add(this);
  }

  /** Kills whatever this row still runs: its binaries, their children's process groups (restic), stopped groups. */
  stop() {
    for (const child of this.children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      for (const pid of childrenOf(child.pid)) signal(-pid, "SIGKILL");
      signal(child.pid, "SIGKILL");
    }
    for (const pgid of this.groups) signal(-pgid, "SIGKILL");
  }

  cleanup() {
    this.stop();
    runs.delete(this);
    try {
      chmodSync(join(this.dir, "src/extra.ts"), EXTRA_MODE);
    } catch {}
    this.box.cleanup();
    if (volume !== undefined) removeTree(this.area);
  }

  noteEdit(path: string) {
    this.reference.set(path, hashEntry(this.dir, path));
  }

  /** The binary's environment: the row's sandbox named in full (the tripwire fills in what a child's env leaves out). */
  env(extra: Record<string, string> = {}): Record<string, string> {
    const home = this.box.home;
    return {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local/share"),
      PATH,
      PLAINPORT_STORE_PASSWORD: PASSWORD,
      PLAINPORT_TRIPWIRE_REAL_HOME: REAL_HOME,
      PLAINPORT_TOOLS_DIR: tools,
      ...extra,
    };
  }

  spawn(args: string[], extra: Record<string, string> = {}, executable = binary) {
    const child = Bun.spawn([executable, ...args], {
      cwd: this.box.home,
      env: this.env(extra),
      stdout: "pipe",
      stderr: "pipe",
    });
    this.children.add(child);
    return child;
  }

  /** Runs a binary; `pause` is called while it waits at its pause step, if one was asked for. */
  async run(
    args: string[],
    extra: Record<string, string> = {},
    pause?: () => Promise<void> | void,
    executable = binary,
  ): Promise<Ran> {
    const pauseFile = join(this.box.home, "paused");
    const child = this.spawn(
      args,
      pause === undefined ? extra : { ...extra, PLAINPORT_TEST_PAUSE_FILE: pauseFile },
      executable,
    );
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (pause !== undefined) {
      try {
        const deadline = Date.now() + 60_000;
        while (!existsSync(pauseFile) && child.exitCode === null && Date.now() < deadline)
          await Bun.sleep(10);
        if (existsSync(pauseFile)) await pause();
      } catch (error) {
        // A pause that failed must not let the binary go on with a world the test never finished changing.
        this.stop();
        throw error;
      } finally {
        removeTree(pauseFile);
      }
    }
    const [out, err] = await output;
    await child.exited;
    return { code: child.exitCode, signal: child.signalCode, out, err };
  }

  async init() {
    ok(
      await this.run([
        "init",
        "--root",
        `work=${this.root}`,
        "--store-path",
        "~/ssd",
        "--device",
        "mbp",
        "--yes",
        "--json",
      ]),
      "init",
    );
  }

  registry() {
    return JSON.parse(readFileSync(this.box.paths.registryFile, "utf8"));
  }

  projectId(): string | undefined {
    try {
      return Object.entries(this.registry().projects as Record<string, { path: string }>).find(
        ([, e]) => e.path === "web",
      )?.[0];
    } catch {
      return undefined;
    }
  }

  async world(): Promise<World> {
    const opened = await localStores(testHost(), this.env()).open(
      STORE,
      { kind: "local", path: "~/ssd" },
      PASSWORD,
    );
    if (!opened.ok) throw new Error(opened.finding.message);
    return {
      paths: this.box.paths,
      device: JSON.parse(readFileSync(this.box.paths.deviceFile, "utf8")).id,
      dir: this.dir,
      root: this.root,
      store: { name: STORE, blob: opened.value.blob, engine: opened.value.engine },
      scratch: this.area,
    };
  }

  /** Offloads, and waits for the detached delete, so an onload has a shelved project. */
  async shelve() {
    ok(await this.run(offloadArgs), "offload");
    await settleJournals(this.box.paths);
  }

  /** Invariant 1's capture: the folder as the crash left it, in its place or in its trash. */
  captureAfterCrash() {
    if (existsSync(this.dir)) {
      this.released = captureTree(this.dir);
      return;
    }
    const trash = join(this.root, ".plainport-trash");
    for (const op of existsSync(trash) ? readdirSync(trash) : []) {
      const moved = join(trash, op, "web");
      if (existsSync(moved)) this.released = captureTree(moved);
    }
  }

  /** recover's report from its --json envelope, on success or as a failure's data. */
  async recover(): Promise<RecoveryReport> {
    const ran = await this.run(["recover", "--json"]);
    const line = ran.out.trim().split("\n").at(-1) ?? "";
    try {
      const envelope = JSON.parse(line);
      if (envelope.data !== undefined) return envelope.data as RecoveryReport;
    } catch {}
    throw new Error(`recover exited ${ran.code ?? ran.signal} without a report: ${ran.err}${ran.out}`);
  }
}

type Scenario = (r: RowRun, row: Row) => Promise<void>;

const OFFLOAD_SCENARIOS: Record<ScenarioOf<typeof OFFLOAD_BRANCH_KINDS>, Scenario> = {
  plain: async (r, row) => killed(await r.run(offloadArgs, crashAt(row.point, row.occurrence)), "offload"),
  discarded: async (r, row) => {
    const ran = await r.run(offloadArgs, { ...crashAt(row.point), ...pauseAtUpload }, () =>
      chmodSync(join(r.dir, "src/extra.ts"), 0o000),
    );
    chmodSync(join(r.dir, "src/extra.ts"), EXTRA_MODE);
    killed(ran, "offload");
  },
  diverged: async (r, row) => {
    // A first offload that dies before its upload registers the project and its root; recover rolls it back.
    killed(await r.run(offloadArgs, crashAt(MATRIX_POINTS.register)), "offload");
    await r.recover();
    const ran = await r.run(offloadArgs, { ...crashAt(row.point), ...pauseAtUpload }, async () => {
      const s = ulid();
      const appended = await appendEvent(storeEventLog(fsBlobStore(testHost(), join(r.box.home, "ssd"))), {
        v: 1,
        id: s,
        op: s,
        type: "offloaded",
        device: ulid(),
        at: "2026-10-03T00:00:00.000Z",
        project: r.projectId() as string,
        root: r.registry().roots.work,
        path: "web",
        snapshot: s,
        stored: { [STORE]: "c".repeat(64) },
        stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
      });
      if (!appended.ok) throw new Error(appended.finding.message);
    });
    killed(ran, "offload");
  },
  retry: async (r, row) => {
    const ran = await r.run(offloadArgs, { ...crashAt(row.point, row.occurrence), ...pauseAtUpload }, () => {
      writeFileSync(join(r.dir, "notes/todo.txt"), "edited during the upload\n");
      r.noteEdit("notes/todo.txt");
    });
    killed(ran, "offload");
  },
};

const ONLOAD_SCENARIOS: Record<ScenarioOf<typeof ONLOAD_BRANCH_KINDS>, Scenario> = {
  plain: async (r, row) => {
    await r.shelve();
    killed(await r.run(onloadArgs, crashAt(row.point)), "onload");
  },
  reuse: async (r, row) => {
    appendFileSync(r.box.paths.configFile, '\n[offload]\nkeepLocalFor = "1h"\n');
    ok(await r.run(offloadArgs), "offload");
    killed(await r.run(onloadArgs, crashAt(row.point)), "onload");
  },
  resume: async (r, row) => {
    await r.shelve();
    killed(await r.run(onloadArgs, crashAt(MATRIX_POINTS.resumeFrom)), "onload");
    killed(await r.run(onloadArgs, crashAt(row.point)), "onload");
  },
};

const SCENARIOS: { readonly [S in Saga]: Readonly<Record<string, Scenario>> } = {
  offload: OFFLOAD_SCENARIOS,
  onload: ONLOAD_SCENARIOS,
};

interface RowOptions {
  /** A crash of the row's own, instead of its scenario's. */
  crash?: Scenario;
  /** Harm done after recover, which the row's checks must then report (the damage mode). */
  damage?: (world: World) => void;
  /** More checks, once the row's own ran. */
  after?(r: RowRun, crashedOp: string | undefined): Promise<string[]>;
}

let rowsMade = 0;

/** Runs one row in a slot, within ROW_MS of getting it; whatever the row started is killed when it ends. */
const runRow = (row: Row, options: RowOptions = {}) =>
  slot(async () => {
    const r = new RowRun(++rowsMade);
    let timer: Timer | undefined;
    const work = rowWork(r, row, options);
    work.catch(() => {});
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`the row took longer than ${ROW_MS / 1000} s`)), ROW_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      r.cleanup();
    }
  });

const rowWork = async (r: RowRun, row: Row, options: RowOptions): Promise<string[]> => {
  await r.init();
  const crash = options.crash ?? SCENARIOS[row.saga][row.scenario];
  if (crash === undefined) throw new Error(`no ${row.saga} scenario ${row.scenario}`);
  const before = journalSteps(r.box.paths);
  await crash(r, row);
  const w = await r.world();
  const seen = await snapshotIds(w.store.engine);
  const steps = journalSteps(r.box.paths);
  const crashedOp = crashedOperation(before, steps);
  const crashedStep = crashedOp === undefined ? undefined : steps.get(crashedOp);
  const crashLeft = crashCopyProblems(row, w, r.reference);
  if (row.saga === "offload") r.captureAfterCrash();
  // The dead process's lock file is still there, naming a pid that is gone: recover takes it over (D63).
  const id = r.projectId();
  const stale = id !== undefined && existsSync(join(r.box.paths.locksDir, `${id}.lock`));
  // Past the detached delete's start, that delete outlives the binary: let it finish, so recover meets one state.
  if (row.point === MATRIX_POINTS.raced) await settleJournals(r.box.paths);
  const journalAtRecover = crashedOp !== undefined && journalSteps(r.box.paths).has(crashedOp);
  const report = await r.recover();
  await settleJournals(r.box.paths);
  const again = await r.recover();
  options.damage?.(w);
  const problems = stale ? [] : [`the killed ${row.saga} left no lock file for recover to take over`];
  return problems.concat(
    crashLeft,
    await rowProblems(row, w, {
      crashedStep,
      crashedOp,
      journalAtRecover,
      report,
      again,
      reference: r.reference,
      ...(r.released === undefined ? {} : { released: r.released }),
      seen,
      projectId: r.projectId(),
    }),
    options.after === undefined ? [] : await options.after(r, crashedOp),
  );
};

/** A row's test: green when its checks find nothing, or, in the damage mode, when they find the harm done. */
const rowTest = (row: Row) => async () => {
  const problems = await runRow(row, DAMAGE_MODE ? { damage } : {});
  if (DAMAGE_MODE) expect(problems.length).toBeGreaterThan(0);
  else expect(problems).toEqual([]);
};

describeT1("crash matrix, SIGKILL subprocess", () => {
  // Every test here is macOS-only in M1 (see the file comment), counted so a skip never passes for a run on a Mac.
  const macTest = macOnlyTests();
  const macRow = macOnlyTests(process.env, { concurrent: true });

  macTest(
    "a binary built by scripts/build.ts ignores the fault variables: the offload runs to its end",
    async () => {
      const release = join(scratch, "plainport-release");
      const build = Bun.spawnSync(
        [process.execPath, join(checkout, "scripts/build.ts"), "--outfile", release],
        { cwd: checkout, stdout: "pipe", stderr: "pipe" },
      );
      expect(build.exitCode).toBe(0);
      const r = new RowRun(++rowsMade);
      try {
        await r.init();
        const ran = await r.run(offloadArgs, crashAt("offload.committed"), undefined, release);
        expect({ code: ran.code, signal: ran.signal }).toEqual({ code: 0, signal: null });
      } finally {
        r.cleanup();
        removeTree(release);
      }
    },
    120_000,
  );

  for (const [saga, rows] of [
    ["offload", OFFLOAD_ROWS],
    ["onload", ONLOAD_ROWS],
  ] as const)
    describe(`${saga} (${rows.length} rows)`, () => {
      for (const row of rows) macRow(row.name, rowTest(row), TEST_MS);
    });

  // A crash while restic uploads, not at a step: once restic has written a pack of this upload, but no snapshot yet,
  // the test freezes plainport and restic's whole process group (SIGSTOP, so the upload cannot finish in between),
  // checks the upload is still unfinished, then SIGKILLs them, as a power cut or an OOM kill would leave it. The
  // journal stays at the upload's step, so the row is that step's, with three more demands: recover rolled it back
  // (its rule allows nothing else but pending, which the row refuses), the folder is untouched, and a later offload
  // succeeds over the dead restic's lock and leftover packs and becomes the head, never a half-written snapshot of
  // the crashed operation.
  macRow(
    `${MATRIX_POINTS.upload} · mid-upload SIGKILL of plainport and restic's process group`,
    async () => {
      let leftover = { packs: 0, locks: 0, snapshots: -1 };
      const problems = await runRow(plainRowAt(MATRIX_POINTS.upload), {
        crash: async (r) => {
          // Incompressible bytes, several 16 MiB packs: restic writes packs while the upload still runs.
          writeFileSync(join(r.dir, "data/blob.bin"), randomBytes(40 * 1024 * 1024));
          r.noteEdit("data/blob.bin");
          const repo = join(r.box.home, "ssd/repo");
          const child = r.spawn(offloadArgs);
          const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
          const deadline = Date.now() + 120_000;
          while (child.exitCode === null && countFiles(join(repo, "data")) === 0 && Date.now() < deadline)
            await Bun.sleep(2);
          // Freeze first: plainport cannot start anything new, restic cannot finish its snapshot.
          signal(child.pid, "SIGSTOP");
          const uploading = childrenOf(child.pid, "restic");
          for (const pid of uploading) {
            r.groups.add(pid);
            signal(-pid, "SIGSTOP");
          }
          leftover = {
            packs: countFiles(join(repo, "data")),
            locks: countFiles(join(repo, "locks")),
            snapshots: countFiles(join(repo, "snapshots")),
          };
          // The runner gives each child its own process group (pgid = its pid): kill the group, as a crash would.
          for (const pid of uploading) signal(-pid, "SIGKILL");
          signal(child.pid, "SIGKILL");
          await child.exited;
          const [out, err] = await output;
          if (uploading.length === 0)
            throw new Error(
              `restic was not uploading when the kill was due (exit ${child.exitCode}): ${err}${out}`,
            );
          killed({ code: child.exitCode, signal: child.signalCode, out, err }, "offload");
          const gone = Date.now() + 10_000;
          while (uploading.some(alive) && Date.now() < gone) await Bun.sleep(10);
          if (uploading.some(alive)) throw new Error(`restic ${uploading.join(", ")} outlived its SIGKILL`);
        },
        after: async (r, crashedOp) => {
          const later = await r.run(offloadArgs);
          if (later.code !== 0) return [`a later offload exited ${later.code}: ${later.err}${later.out}`];
          await settleJournals(r.box.paths);
          return laterHeadProblems(await r.world(), r.projectId(), crashedOp, r.reference);
        },
      });
      expect(problems).toEqual([]);
      // The kill really landed mid-upload: packs written, the dead restic's lock left, no snapshot yet.
      expect(leftover.packs).toBeGreaterThan(0);
      expect(leftover.locks).toBeGreaterThan(0);
      expect(leftover.snapshots).toBe(0);
    },
    TEST_MS,
  );
});
