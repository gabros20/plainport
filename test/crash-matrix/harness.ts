// The crash matrix's SIGKILL subprocess harness (ADR-0017), shared by the variant on a local store (subprocess.test.ts,
// T1) and the variants on remote stores (remote.t2.test.ts and faults.t2.test.ts, T2: SFTP and SeaweedFS as the S3
// store, D94): every row the matrix enumerates (matrix.ts), run by the compiled binary with the real restic (and
// rclone, on a remote store), killed by a real SIGKILL at the row's step or seam, then `plainport recover`, then the
// row's checks (checks.ts). A dead process leaves what an InjectedFault cannot: its lock file naming a pid that is gone,
// a detached delete still running, nothing unwound.
//
// The binary is built for the matrix (`--define globalThis.PLAINPORT_TEST_HOOKS=true`, packages/cli/src/test-hooks.ts)
// and kills itself at the step (PLAINPORT_TEST_FAULT_AT): exact, and it reaches the after-effect seams, which write no
// journal for a watcher to see. Branches that need the world to change mid-run pause the binary at a step
// (PLAINPORT_TEST_PAUSE_AT) while the test changes it, as the in-process variant's fake engine hooks do.
//
// The store is the matrix's store dimension (StoreKind): a local folder (`plainport init --store-path`), or an SFTP or
// S3 store of the T2 environment (`scripts/testenv up`) under a fresh prefix per row, set up by `plainport store add`
// (a sealed catalog, the remote default, Q10) with its durability asserted and no conflict grace, so a plain run
// releases as on a local store; the held branch gives itself a grace. Secrets stay references: the config names
// env: variables the binary's environment holds.
//
// macOS only in M2: the binary has only the macOS host, so on Linux its preflight refuses safely (no BSD `find -flags`
// for fs.dataless, no /usr/sbin/lsof for proc.open-files) before any step a row needs. The Linux host (host-linux)
// arrives with M3 (Machines); then these rows run on Linux as well. The in-process variant runs everywhere.
//
// On macOS each row's root lives on a case-sensitive APFS sparse disk image (hdiutil, growing as written) and the
// project gains a case pair; the image is detached and deleted afterwards. Rows are independent (each has its own
// home, root and store), so they run a few at a time (PLAINPORT_CRASH_PARALLEL; per store kind by default), and a
// row's deadline starts once it has its slot; whatever it started is killed, restic's process groups included, when it
// ends, passed or failed.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { makeRoot } from "../../packages/blob-rclone/src/testing/t2.ts";
import { storeOpener } from "../../packages/cli/src/stores.ts";
import { readStoreDescriptor } from "../../packages/core/src/catalog/identity.ts";
import { appendEvent, storeEventLog } from "../../packages/core/src/catalog/index.ts";
import { storedKey } from "../../packages/core/src/catalog/stored.ts";
import { ConfigLoader } from "../../packages/core/src/config/load.ts";
import type { RecoveryReport } from "../../packages/core/src/recover/recover.ts";
import { openStore } from "../../packages/core/src/store.ts";
import { captureTree, namesIn, type TreeCapture } from "../../packages/core/src/testing/invariants.ts";
import { makeSandbox, type Sandbox } from "../../packages/core/src/testing/sandbox.ts";
import { ulid } from "../../packages/core/src/ulid.ts";
import { testHost } from "../../packages/host-macos/src/testing.ts";
import type { TestEnv } from "../../scripts/testenv.ts";
import { binaryEnv, binaryPath, buildHookedBinary, toolsCopy } from "../binary-env.ts";
import { attachImage, type DiskImage } from "../disk-image.ts";
import { onMac } from "../platform.ts";
import { assertedProfile, freshPrefix, type RemoteKind, storeToml } from "../support/remote-device.ts";
import { makeSshShim } from "../support/ssh-shim.ts";
import {
  crashCopyProblems,
  crashedOperation,
  journalSteps,
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
  MATRIX_POINTS,
  type OFFLOAD_BRANCH_KINDS,
  type ONLOAD_BRANCH_KINDS,
  type Row,
  type Saga,
  type ScenarioOf,
} from "./matrix.ts";

export const PASSWORD = "crash-matrix-pw";

/** One row's time once it has its slot. */
export const ROW_MS = 240_000;

/** A test's timeout for `rows` rows run `parallel` at a time, each within `rowMs`: its own time plus the longest wait. */
export const testMs = (rows: number, parallel: number, rowMs = ROW_MS): number =>
  rowMs * (Math.ceil((rows + 2) / parallel) + 1);

/** The child's end: its exit code or the signal that killed it, and what it printed. */
export type Ran = { code: number | null; signal: string | null; out: string; err: string };

/** The last JSON line of a `--json` run, parsed; undefined when there is none. */
export const envelopeOf = (
  ran: Ran,
):
  | {
      ok?: boolean;
      data?: Record<string, unknown>;
      error?: { code?: number; finding?: { code?: string; message?: string } };
    }
  | undefined => {
  try {
    return JSON.parse(ran.out.trim().split("\n").at(-1) ?? "");
  } catch {
    return undefined;
  }
};

/**
 * A store kind of the matrix's store dimension: how a row's device names it, sets it up and reaches it. Rows on a
 * remote kind each get a fresh prefix, so they are as independent as rows on a local folder.
 */
export interface StoreKind {
  readonly name: "local" | RemoteKind;
  /** The store's name in the row's config. */
  readonly store: string;
  /** Rows at once on this kind, unless PLAINPORT_CRASH_PARALLEL says otherwise. */
  readonly parallel: number;
  /** The binary's own environment for it beyond the sandbox: the ssh shim first on PATH, the secrets' variables. */
  env(home: string): Record<string, string>;
  /** Sets the row's device up, and its store unless `add` is false (bootstrap's rows run `store add` themselves). */
  setUp(r: RowRun, add: boolean): Promise<void>;
  /** `store add`'s flags for the row's store, when the kind is set up by it. */
  addFlags?(r: RowRun): string[];
  /** config.toml's [offload] settings every row starts with (a scenario's own replace them, key by key). */
  readonly offload: Readonly<Record<string, string>>;
}

const defaultParallel = (local: number, ci: number) =>
  Math.max(1, Math.min(process.env.CI ? ci : local, availableParallelism()));

/** A local folder at ~/ssd, as `plainport init --store-path` sets it up (M1's store). */
export const LOCAL_KIND: StoreKind = {
  name: "local",
  store: "local",
  parallel: defaultParallel(6, 3),
  env: () => ({}),
  setUp: async (r) => {
    ok(
      await r.run([
        "init",
        "--root",
        `work=${r.root}`,
        "--store-path",
        "~/ssd",
        "--device",
        "mbp",
        "--yes",
        "--json",
      ]),
      "init",
    );
  },
  offload: {},
};

/** What a remote store kind's rows need of the T2 environment. */
export interface RemoteOptions {
  /** Through Toxiproxy, for the fault rows; a row's own fault then cuts every row on the kind, so they run alone. */
  proxied?: boolean;
}

/** The store's variables, referenced by its config (env:), never written into it. */
const SECRET_VARIABLES = (env: TestEnv) => ({
  T18_STORE_PASSWORD: PASSWORD,
  T18_S3_KEY_ID: env.s3.accessKeyId,
  T18_S3_SECRET_KEY: env.s3.secretAccessKey,
});

/** The `store add` flags for a remote store (references only). */
const addFlags = (env: TestEnv, kind: RemoteKind, prefix: string, proxied: boolean): string[] =>
  kind === "sftp"
    ? [
        "--kind",
        "sftp",
        "--host",
        proxied ? env.sftp.proxiedAlias : env.sftp.alias,
        "--path",
        `${env.sftp.root}/${prefix}`,
        "--secret",
        "env:T18_STORE_PASSWORD",
      ]
    : [
        "--kind",
        "s3",
        "--endpoint",
        proxied ? env.s3.proxied : env.s3.endpoint,
        "--bucket",
        env.s3.bucket,
        "--path",
        prefix,
        "--region",
        env.s3.region,
        "--secret",
        "env:T18_STORE_PASSWORD",
        "--access-key-id",
        "env:T18_S3_KEY_ID",
        "--secret-access-key",
        "env:T18_S3_SECRET_KEY",
      ];

/**
 * An SFTP or S3 store of the T2 environment, a fresh prefix per row, set up by `plainport store add` (sealed, the
 * remote default) with the kind's measured profile and durability asserted, and no conflict grace (Q16): a plain run
 * then releases as on a local store, its trash deleted at once.
 */
export const remoteKind = (env: TestEnv, kind: RemoteKind, options: RemoteOptions = {}): StoreKind => ({
  name: kind,
  store: "remote",
  // sshd drops logins past about ten at once, and every rclone and restic call is one.
  parallel: defaultParallel(kind === "sftp" ? 3 : 4, 2),
  env: (home) => ({ PATH: `${join(home, "bin")}:${binaryPath()}`, ...SECRET_VARIABLES(env) }),
  addFlags: (r) => addFlags(env, kind, r.prefix, options.proxied === true),
  setUp: async (r, add) => {
    const shim = makeSshShim(join(r.box.home, "bin"), env.sftp.sshConfig);
    const prefix = freshPrefix(`crash-${kind}`);
    r.prefix = prefix;
    const proxied = options.proxied === true;
    r.configBase = [
      "version = 1",
      'defaultStore = "remote"',
      ...storeToml(env, "remote", { kind, prefix, proxied, semantics: assertedProfile(kind, "durable") }),
      "[roots.work]",
      'store = "remote"',
      `on = { mbp = "${r.root}" }`,
    ];
    r.writeConfig();
    if (kind === "sftp")
      makeRoot(
        { home: r.box.home, path: r.env().PATH as string, rclone: join(r.tools, "rclone") },
        {
          type: "sftp",
          root: `${env.sftp.root}/${prefix}`,
          options: { ssh: shim.rcloneSsh(proxied ? env.sftp.proxiedAlias : env.sftp.alias) },
        },
      );
    ok(await r.run(["init", "--device", "mbp", "--yes", "--json"]), "init");
    if (add) ok(await r.run(r.addArgs()), "store add");
  },
  offload: { conflictGrace: '"0"' },
});

/** What every row of a file shares: the hooked binary, the tools it runs, the project, the case-sensitive volume. */
export interface Harness {
  scratch: string;
  binary: string;
  tools: string;
  template: ProjectTemplate;
  image?: DiskImage;
  /** The case-sensitive volume's mount point, where each row's root lives (macOS). */
  volume?: string;
  /** Every row's run, so the file's afterAll can stop what a row that never ended left running. */
  runs: Set<RowRun>;
  rowsMade: number;
}

/** Builds the binary, copies the tools and makes the project once per file (`withRclone` for remote stores). */
export const makeHarness = async (options: { withRclone?: boolean } = {}): Promise<Harness> => {
  const scratch = mkdtempSync(join(tmpdir(), "plainport-crash-sub-"));
  const binary = join(scratch, "plainport");
  buildHookedBinary(binary);
  // The binary refuses every path under the real home (guardFromEnv), the checkout's .tools included: a copy.
  const tools = toolsCopy(scratch, options.withRclone ? ["restic", "rclone"] : ["restic"]);
  const template = makeProjectTemplate();
  const harness: Harness = { scratch, binary, tools, template, runs: new Set(), rowsMade: 0 };
  if (onMac) {
    harness.image = await attachImage(join(scratch, "image"), {
      size: "512m",
      fs: "Case-sensitive APFS",
      volname: "pp-crash",
      sparse: true,
    });
    harness.volume = harness.image.mount;
  }
  return harness;
};

export const removeHarness = async (harness: Harness | undefined) => {
  if (harness === undefined) return;
  for (const r of harness.runs) r.stop();
  try {
    await harness.image?.remove();
  } finally {
    harness.template.cleanup();
    removeTree(harness.scratch);
  }
};

/** The processes a process started (named `name`, when given). */
export const childrenOf = (parent: number, name?: string): number[] =>
  Bun.spawnSync(["pgrep", "-P", String(parent), ...(name === undefined ? [] : ["-x", name])], {
    env: { PATH: "/usr/bin:/bin" },
    stdout: "pipe",
  })
    .stdout.toString()
    .split("\n")
    .filter(Boolean)
    .map(Number);

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const signal = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(pid, sig);
  } catch {}
};

/** A few rows at a time, per pool. */
export const slots = (parallel: number) => {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= parallel) await new Promise<void>((go) => waiting.push(go));
    running++;
    try {
      return await work();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
};

export const crashAt = (point: string, occurrence = 1) => ({
  PLAINPORT_TEST_FAULT_AT: point,
  PLAINPORT_TEST_FAULT_OCCURRENCE: String(occurrence),
});
export const pauseAt = (point: string) => ({ PLAINPORT_TEST_PAUSE_AT: point });
const pauseAtUpload = pauseAt(MATRIX_POINTS.upload);
export const offloadArgs = ["offload", "work:web", "--yes", "--json"];
export const onloadArgs = ["onload", "work:web", "--no-hydrate", "--json"];

export const ok = (ran: Ran, what: string) => {
  if (ran.code !== 0) throw new Error(`${what} exited ${ran.code ?? ran.signal}: ${ran.err}${ran.out}`);
};
export const killed = (ran: Ran, what: string) => {
  if (ran.signal !== "SIGKILL")
    throw new Error(`${what} was not killed (exit ${ran.code}, signal ${ran.signal}): ${ran.err}${ran.out}`);
};

/** One row's world: its sandboxed home, its root (on the case-sensitive volume on macOS), its project and its store. */
export class RowRun {
  readonly box: Sandbox;
  /** The folder for this row on the project's volume. */
  readonly area: string;
  readonly root: string;
  readonly dir: string;
  readonly tools: string;
  /** The project before the run, plus the scenario's own edits (noteEdit): what no crash may change. */
  reference: TreeHash = new Map();
  /** Invariant 1's capture: the folder before the run, then as the crash left it (in place or in the trash). */
  released: TreeCapture | undefined;
  /** The row's own prefix under the T2 folder or bucket, on a remote store kind. */
  prefix = "";
  /** config.toml without its [offload] table (writeConfig adds it); empty for a local store, which init sets up. */
  configBase: string[] = [];
  /** The [offload] settings this row asked for, over the kind's. */
  private offloadSettings: Record<string, string> = {};
  /** Every binary this row started; stop() kills those still running and every process group they started. */
  private readonly children = new Set<Bun.Subprocess>();
  /** restic process groups the test itself stopped, killed by stop() too. */
  readonly groups = new Set<number>();

  constructor(
    readonly harness: Harness,
    readonly kind: StoreKind,
  ) {
    const id = ++harness.rowsMade;
    this.box = makeSandbox("plainport-crash-sub-");
    this.area = harness.volume === undefined ? this.box.home : join(harness.volume, `row-${id}`);
    this.root = join(this.area, "work");
    this.dir = join(this.root, "web");
    this.tools = harness.tools;
    mkdirSync(this.root, { recursive: true });
    copyProject(harness.template, this.dir, { casePair: harness.volume !== undefined });
    this.reference = hashTree(this.dir);
    this.released = captureTree(this.dir);
    harness.runs.add(this);
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

  async cleanup() {
    this.stop();
    this.harness.runs.delete(this);
    try {
      chmodSync(join(this.dir, "src/extra.ts"), EXTRA_MODE);
    } catch {}
    await this.box.cleanupSettled();
    if (this.harness.volume !== undefined) removeTree(this.area);
  }

  noteEdit(path: string) {
    this.reference.set(path, hashEntry(this.dir, path));
  }

  /** The binary's environment: the row's sandbox named in full (the tripwire fills in what a child's env leaves out). */
  env(extra: Record<string, string> = {}): Record<string, string> {
    return binaryEnv(this.box.home, this.tools, PASSWORD, { ...this.kind.env(this.box.home), ...extra });
  }

  /** config.toml: the kind's base, then an [offload] table of the kind's settings and this row's. */
  writeConfig() {
    const settings = { ...this.kind.offload, ...this.offloadSettings };
    const table = Object.entries(settings).map(([k, v]) => `${k} = ${v}`);
    const lines = [...this.configBase, ...(table.length === 0 ? [] : ["[offload]", ...table]), ""];
    mkdirSync(join(this.box.home, ".config/plainport"), { recursive: true });
    writeFileSync(this.box.paths.configFile, lines.join("\n"));
  }

  /** Sets [offload] keys (TOML values) for the rest of the row. */
  offload(settings: Record<string, string>) {
    this.offloadSettings = { ...this.offloadSettings, ...settings };
    this.writeConfig();
  }

  spawn(args: string[], extra: Record<string, string> = {}, executable = this.harness.binary) {
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
    executable = this.harness.binary,
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

  /** Sets the row's device and store up (the kind's way), then the [offload] settings the kind starts with. */
  async init(options: { add?: boolean } = {}) {
    await this.kind.setUp(this, options.add ?? true);
    if (this.configBase.length === 0 && existsSync(this.box.paths.configFile))
      this.configBase = readFileSync(this.box.paths.configFile, "utf8").trimEnd().split("\n");
    if (Object.keys(this.kind.offload).length > 0) this.writeConfig();
  }

  /** `plainport store add` for the row's store, as the kind sets it up. */
  addArgs(): string[] {
    const flags = this.kind.addFlags?.(this);
    if (flags === undefined) throw new Error(`a ${this.kind.name} store is not set up by store add`);
    return ["store", "add", this.kind.store, ...flags, "--json"];
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

  /** The row's store as the checks read it: the binary's own opener, with its catalog policy (sealed or plain). */
  async world(): Promise<World> {
    const host = testHost();
    const env = this.env();
    const loaded = await new ConfigLoader(host, this.box.paths).load({ env });
    if (!loaded.ok) throw new Error(loaded.finding.message);
    const opened = await openStore(host, {
      paths: this.box.paths,
      env,
      name: this.kind.store,
      config: loaded.value.config,
      opener: storeOpener(host, env),
    });
    if (!opened.ok) throw new Error(`${opened.finding.code}: ${opened.finding.message}`);
    return {
      paths: this.box.paths,
      device: JSON.parse(readFileSync(this.box.paths.deviceFile, "utf8")).id,
      dir: this.dir,
      root: this.root,
      store: {
        name: this.kind.store,
        blob: opened.value.blob,
        engine: opened.value.engine,
        ...(opened.value.catalog === undefined ? {} : { catalog: opened.value.catalog }),
      },
      scratch: this.area,
    };
  }

  /** Another copy's first offload of the project, appended to the row's store: with this one's, a fork. */
  async otherCopyOffloads(at = new Date().toISOString()): Promise<string> {
    const w = await this.world();
    // Keyed as another device keys its one stored entry (Q11): by the store's id on a format-2 store, by its name on
    // a format-1 one.
    const descriptor = await readStoreDescriptor(w.store.blob);
    if (!descriptor.ok || descriptor.value === null) throw new Error("the row's store has no identity");
    const key = storedKey({ name: this.kind.store, id: descriptor.value.id }, descriptor.value.format);
    const s = ulid();
    const appended = await appendEvent(storeEventLog(w.store.blob, w.store.catalog), {
      v: 1,
      id: s,
      op: s,
      type: "offloaded",
      device: ulid(),
      at,
      project: this.projectId() as string,
      root: this.registry().roots.work,
      path: "web",
      snapshot: s,
      stored: { [key]: "c".repeat(64) },
      stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
    });
    if (!appended.ok) throw new Error(appended.finding.message);
    return s;
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
    for (const op of namesIn(trash)) {
      const moved = join(trash, op, "web");
      if (existsSync(moved)) this.released = captureTree(moved);
    }
  }

  /** recover's run and its report from its --json envelope, on success or as a failure's data. */
  async recoverRun(): Promise<{ ran: Ran; report: RecoveryReport }> {
    const ran = await this.run(["recover", "--json"]);
    const envelope = envelopeOf(ran);
    if (envelope?.data !== undefined) return { ran, report: envelope.data as unknown as RecoveryReport };
    throw new Error(`recover exited ${ran.code ?? ran.signal} without a report: ${ran.err}${ran.out}`);
  }

  async recover(): Promise<RecoveryReport> {
    return (await this.recoverRun()).report;
  }
}

export type Scenario = (r: RowRun, row: Row) => Promise<void>;

export const OFFLOAD_SCENARIOS: Record<ScenarioOf<typeof OFFLOAD_BRANCH_KINDS>, Scenario> = {
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
      await r.otherCopyOffloads("2026-10-03T00:00:00.000Z");
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
  forkedAfterCommit: async (r, row) => {
    // Another copy's first offload lands after the commit's head check, before release reads the catalog again (F2).
    const ran = await r.run(
      offloadArgs,
      { ...crashAt(row.point), ...pauseAt("offload.committed") },
      async () => {
        await r.otherCopyOffloads();
      },
    );
    killed(ran, "offload");
  },
  held: async (r, row) => {
    // A grace short enough that recover's checked read is taken after it, so the held trash settles (Q16).
    r.offload({ conflictGrace: '"1s"' });
    killed(await r.run(offloadArgs, crashAt(row.point, row.occurrence)), "offload");
    await Bun.sleep(1_100);
  },
};

export const ONLOAD_SCENARIOS: Record<ScenarioOf<typeof ONLOAD_BRANCH_KINDS>, Scenario> = {
  plain: async (r, row) => {
    await r.shelve();
    killed(await r.run(onloadArgs, crashAt(row.point)), "onload");
  },
  reuse: async (r, row) => {
    r.offload({ keepLocalFor: '"1h"' });
    ok(await r.run(offloadArgs), "offload");
    killed(await r.run(onloadArgs, crashAt(row.point)), "onload");
  },
  resume: async (r, row) => {
    await r.shelve();
    killed(await r.run(onloadArgs, crashAt(MATRIX_POINTS.resumeFrom)), "onload");
    killed(await r.run(onloadArgs, crashAt(row.point)), "onload");
  },
};

export const SCENARIOS: { readonly [S in Saga]: Readonly<Record<string, Scenario>> } = {
  offload: OFFLOAD_SCENARIOS,
  onload: ONLOAD_SCENARIOS,
};

export interface RowOptions {
  /** A crash of the row's own, instead of its scenario's. */
  crash?: Scenario;
  /** Harm done after recover, which the row's checks must then report (the damage mode). */
  damage?: (world: World) => void;
  /** More checks, once the row's own ran. */
  after?(r: RowRun, crashedOp: string | undefined): Promise<string[]>;
}

/** Runs `work` on a fresh row in a slot, within `rowMs` of getting it; whatever the row started is killed at its end. */
export const inRow = <T>(
  harness: Harness,
  kind: StoreKind,
  slot: <U>(work: () => Promise<U>) => Promise<U>,
  work: (r: RowRun) => Promise<T>,
  rowMs = ROW_MS,
): Promise<T> =>
  slot(async () => {
    const r = new RowRun(harness, kind);
    let timer: Timer | undefined;
    const running = work(r);
    running.catch(() => {});
    try {
      return await Promise.race([
        running,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`the row took longer than ${rowMs / 1000} s`)), rowMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await r.cleanup();
    }
  });

/** A crash row's work: the crash, recover twice, the row's checks; problems, none when it passed. */
export const rowWork = async (r: RowRun, row: Row, options: RowOptions = {}): Promise<string[]> => {
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
