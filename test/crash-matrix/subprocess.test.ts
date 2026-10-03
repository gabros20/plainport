// The crash matrix, subprocess variant (T1; ADR-0017): every row the matrix enumerates (matrix.ts), run by the
// compiled binary with the real restic on a local store, killed by a real SIGKILL at the row's step or seam, then
// `plainport recover`, then the row's checks (checks.ts). A dead process leaves what an InjectedFault cannot: its
// lock file naming a pid that is gone, a detached delete still running, nothing unwound.
//
// The binary is built for the matrix (`--define PLAINPORT_TEST_HOOKS=true`, packages/cli/src/test-hooks.ts) and kills
// itself at the step (PLAINPORT_TEST_FAULT_AT): exact, and it reaches the after-effect seams, which write no journal
// for a watcher to see. Branches that need the world to change mid-run pause the binary at offload.snapshot.start
// (PLAINPORT_TEST_PAUSE_AT) while the test changes it, as the in-process variant's fake engine hooks do.
//
// On macOS each row's root lives on a small case-sensitive APFS disk image (hdiutil) and the project gains a case
// pair; the image is detached and deleted afterwards. Elsewhere the root is in the row's sandbox. Rows are
// independent (each has its own home, root and store), so they run a few at a time: restic derives its key on every
// call, and one row makes some fifteen.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import { tmpdir } from "node:os";
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
import { onMac } from "../platform.ts";
import { describeT1, tierEnabled } from "../tiers.ts";
import { journalSteps, rowProblems, settleJournals, snapshotIds, type World } from "./checks.ts";
import {
  copyProject,
  hashTree,
  makeProjectTemplate,
  type ProjectTemplate,
  removeTree,
  type TreeHash,
} from "./fixture.ts";
import {
  type BranchKind,
  type OFFLOAD_BRANCH_KINDS,
  OFFLOAD_ROWS,
  type ONLOAD_BRANCH_KINDS,
  ONLOAD_ROWS,
  type Row,
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
const PARALLEL = 6;

let scratch: string;
let binary: string;
let tools: string;
let template: ProjectTemplate;
/** The case-sensitive volume's mount point (macOS), where each row's root lives. */
let volume: string | undefined;

const sh = (args: string[]) => {
  const ran = Bun.spawnSync(args, {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (ran.exitCode !== 0) throw new Error(`${args.join(" ")}: ${ran.stderr.toString()}`);
  return ran.stdout.toString();
};

const compile = (outfile: string, define: string[]) => {
  const build = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      join(checkout, "packages/cli/src/main.ts"),
      "--outfile",
      outfile,
      ...define,
    ],
    { cwd: checkout, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(`bun build: ${build.stderr.toString()}`);
};

beforeAll(() => {
  if (!tierEnabled(1)) return;
  scratch = mkdtempSync(join(tmpdir(), "plainport-crash-sub-"));
  binary = join(scratch, "plainport");
  compile(binary, ["--define", "PLAINPORT_TEST_HOOKS=true"]);
  // The binary refuses every path under the real home (guardFromEnv), the checkout's .tools included: a copy.
  const target = hostTarget();
  if (target === undefined) throw new Error(`no tools for ${process.platform}-${process.arch}`);
  tools = join(scratch, "tools");
  mkdirSync(tools);
  copyFileSync(join(checkout, ".tools", target, "restic"), join(tools, "restic"));
  chmodSync(join(tools, "restic"), 0o755);
  template = makeProjectTemplate();
  if (onMac) {
    const image = join(scratch, "case-sensitive.dmg");
    volume = join(scratch, "volume");
    mkdirSync(volume);
    sh([
      "hdiutil",
      "create",
      "-quiet",
      "-size",
      "64m",
      "-fs",
      "Case-sensitive APFS",
      "-volname",
      "pp-crash",
      "-type",
      "UDIF",
      image,
    ]);
    sh(["hdiutil", "attach", "-quiet", "-nobrowse", "-noverify", "-mountpoint", volume, image]);
  }
});

afterAll(() => {
  if (!tierEnabled(1)) return;
  if (volume !== undefined) {
    try {
      sh(["hdiutil", "detach", "-quiet", "-force", volume]);
    } catch {}
  }
  template?.cleanup();
  removeTree(scratch);
});

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
const pauseAtUpload = { PLAINPORT_TEST_PAUSE_AT: "offload.snapshot.start" };
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
  /** The project as the test last saw it, and its capture for invariant 1. */
  reference: TreeHash | undefined;
  released: TreeCapture | undefined;

  constructor(id: number) {
    this.box = makeSandbox("plainport-crash-sub-");
    this.area = volume === undefined ? this.box.home : join(volume, `row-${id}`);
    this.root = join(this.area, "work");
    this.dir = join(this.root, "web");
    mkdirSync(this.root, { recursive: true });
    copyProject(template, this.dir, { casePair: volume !== undefined });
  }

  cleanup() {
    try {
      chmodSync(join(this.dir, "src/extra.ts"), 0o644);
    } catch {}
    this.box.cleanup();
    if (volume !== undefined) removeTree(this.area);
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

  /** Runs a binary; `pause` is called while it waits at its pause step, if one was asked for. */
  async run(
    args: string[],
    extra: Record<string, string> = {},
    pause?: () => Promise<void> | void,
    executable = binary,
  ): Promise<Ran> {
    const pauseFile = join(this.box.home, "paused");
    const child = Bun.spawn([executable, ...args], {
      cwd: this.box.home,
      env: this.env(pause === undefined ? extra : { ...extra, PLAINPORT_TEST_PAUSE_FILE: pauseFile }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (pause !== undefined) {
      const deadline = Date.now() + 60_000;
      while (!existsSync(pauseFile) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
      if (existsSync(pauseFile)) {
        await pause();
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

  look(at = this.dir) {
    this.reference = hashTree(at);
    this.released = captureTree(at);
  }

  /** The project as the crash left it: its folder, or the folder in its trash; else what the test last saw. */
  lookAfterCrash() {
    if (existsSync(this.dir)) return this.look();
    const trash = join(this.root, ".plainport-trash");
    for (const op of existsSync(trash) ? readdirSync(trash) : []) {
      const moved = join(trash, op, "web");
      if (existsSync(moved)) this.look(moved);
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

type ScenarioOf<K extends Record<string, BranchKind>> =
  | "plain"
  | { [B in keyof K]: K[B] extends "plain" ? never : B }[keyof K];
type Scenario = (r: RowRun, row: Row) => Promise<void>;

const OFFLOAD_SCENARIOS: Record<ScenarioOf<typeof OFFLOAD_BRANCH_KINDS>, Scenario> = {
  plain: async (r, row) => killed(await r.run(offloadArgs, crashAt(row.point, row.occurrence)), "offload"),
  discarded: async (r, row) => {
    const ran = await r.run(offloadArgs, { ...crashAt(row.point), ...pauseAtUpload }, () =>
      chmodSync(join(r.dir, "src/extra.ts"), 0o000),
    );
    chmodSync(join(r.dir, "src/extra.ts"), 0o644);
    killed(ran, "offload");
  },
  diverged: async (r, row) => {
    // A first offload that dies before its upload registers the project and its root; recover rolls it back.
    killed(await r.run(offloadArgs, crashAt("offload.planned")), "offload");
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
    const ran = await r.run(offloadArgs, { ...crashAt(row.point, row.occurrence), ...pauseAtUpload }, () =>
      writeFileSync(join(r.dir, "notes/todo.txt"), "edited during the upload\n"),
    );
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
    killed(await r.run(onloadArgs, crashAt("onload.verified")), "onload");
    killed(await r.run(onloadArgs, crashAt(row.point)), "onload");
  },
};

let rowsMade = 0;

const runRow = (row: Row) =>
  slot(async () => {
    const r = new RowRun(++rowsMade);
    try {
      await r.init();
      r.look();
      const scenarios: Record<string, Scenario> =
        row.saga === "offload" ? OFFLOAD_SCENARIOS : ONLOAD_SCENARIOS;
      const crash = scenarios[row.scenario];
      if (crash === undefined) throw new Error(`no ${row.saga} scenario ${row.scenario}`);
      const before = journalSteps(r.box.paths);
      await crash(r, row);
      const w = await r.world();
      const seen = await snapshotIds(w.store.engine);
      const steps = journalSteps(r.box.paths);
      const ops = [...steps.keys()].sort();
      const crashedOp = row.saga === "offload" ? ops.at(-1) : ops.filter((o) => !before.has(o)).at(-1);
      const crashedStep = crashedOp === undefined ? undefined : steps.get(crashedOp);
      // An onload's reference is the project it shelved; an offload's is the project as the crash left it.
      if (row.saga === "offload") r.lookAfterCrash();
      // The dead process's lock file is still there, naming a pid that is gone: recover takes it over (D63).
      const id = r.projectId();
      const stale = id !== undefined && existsSync(join(r.box.paths.locksDir, `${id}.lock`));
      const report = await r.recover();
      await settleJournals(r.box.paths);
      const again = await r.recover();
      const problems = stale ? [] : [`the killed ${row.saga} left no lock file for recover to take over`];
      return problems.concat(
        await rowProblems(row, w, {
          crashedStep,
          crashedOp,
          report,
          again,
          reference: r.reference as TreeHash,
          ...(r.released === undefined ? {} : { released: r.released }),
          seen,
          projectId: r.projectId(),
        }),
      );
    } finally {
      r.cleanup();
    }
  });

describeT1("crash matrix, SIGKILL subprocess", () => {
  test("a binary built without the matrix's define ignores the fault variables: the offload runs to its end", async () => {
    const release = join(scratch, "plainport-release");
    compile(release, []);
    const r = new RowRun(++rowsMade);
    try {
      await r.init();
      const ran = await r.run(offloadArgs, crashAt("offload.committed"), undefined, release);
      expect({ code: ran.code, signal: ran.signal }).toEqual({ code: 0, signal: null });
    } finally {
      r.cleanup();
      removeTree(release);
    }
  }, 120_000);

  for (const [saga, rows] of [
    ["offload", OFFLOAD_ROWS],
    ["onload", ONLOAD_ROWS],
  ] as const)
    describe(`${saga} (${rows.length} rows)`, () => {
      for (const row of rows)
        test.concurrent(row.name, async () => expect(await runRow(row)).toEqual([]), 300_000);
    });
});
