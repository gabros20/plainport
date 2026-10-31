// Two or three sandboxed devices on one store, for the race schedules (M2 Task 14, test/support/schedules.ts): each
// device is its own home folder, device id and root, all running the checkout's binary built with the test hook on
// (test/binary-env.ts), and all pointing at one local store folder outside every home.
//
// A device runs a command to its end (run), or starts one that stops at a pause seam (start, PLAINPORT_TEST_PAUSE_AT)
// and goes on only when the test says so, so a schedule can interleave devices at the seams the sagas export.
//
// The binaries' restic is a recorder: a wrapper in the world's tools folder logs every call's arguments, then runs the
// pinned restic (the log's path is in the wrapper: plainport hands restic only a few variables). recorded() hands the log to invariant 6 (no forget, prune or rewrite). The harness itself reads the
// store through the pinned restic directly, so its own reads are not in the log.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localStores } from "../../packages/cli/src/stores.ts";
import { storeEventKey } from "../../packages/core/src/catalog/codec.ts";
import type { CatalogEvent } from "../../packages/core/src/catalog/events.ts";
import { readEvents, storeEventLog } from "../../packages/core/src/catalog/log.ts";
import { type PlainportPaths, resolvePaths } from "../../packages/core/src/paths.ts";
import type { BlobStore } from "../../packages/core/src/ports/blob-store.ts";
import type { Engine } from "../../packages/core/src/ports/engine.ts";
import { testHost } from "../../packages/core/src/testing/host.ts";
import {
  captureTree,
  type InvariantSubject,
  type RecordedCall,
  type TreeCapture,
} from "../../packages/core/src/testing/invariants.ts";
import { removeSettled } from "../../packages/core/src/testing/sandbox.ts";
import { binaryEnv, buildHookedBinary, toolsCopy } from "../binary-env.ts";
import { copyProject, type ProjectTemplate, STRIPPED } from "../crash-matrix/fixture.ts";

export const PASSWORD = "schedules-pw";
const STORE = "local";
const PAUSE_MS = 60_000;

export type Ran = { code: number | null; signal: string | null; out: string; err: string };

/** The last JSON line of a `--json` run, parsed; undefined when there is none. */
export const envelope = (
  ran: Ran,
):
  | {
      ok?: boolean;
      data?: Record<string, unknown>;
      error?: { code?: number; finding?: { code?: string; fix?: string } };
    }
  | undefined => {
  try {
    return JSON.parse(ran.out.trim().split("\n").at(-1) ?? "");
  } catch {
    return undefined;
  }
};

/** What the schedules share across a test file: the hooked binary, the pinned restic, the project template. */
export interface Harness {
  scratch: string;
  binary: string;
  /** The pinned restic's folder: the recorder runs it, and the harness reads the store with it. */
  realTools: string;
  template: ProjectTemplate;
}

/** Builds the binary and the tools once per test file; cleanup with removeHarness. */
export const makeHarness = (template: ProjectTemplate): Harness => {
  const scratch = mkdtempSync(join(tmpdir(), "plainport-schedules-"));
  const binary = buildHookedBinary(join(scratch, "plainport"));
  const realTools = toolsCopy(join(scratch, "real"));
  return { scratch, binary, realTools, template };
};

export const removeHarness = async (harness: Harness): Promise<void> => {
  harness.template.cleanup();
  await removeSettled(harness.scratch);
};

/** A command started at a pause seam: wait for it there, let it go on, and collect its end. */
export interface Started {
  /** Resolves once the command stands at its seam; rejects when it ended or never got there. */
  paused(): Promise<void>;
  /** Lets it go on from the seam. */
  resume(): void;
  /** The file the paused process makes at its seam (a detached delete pauses after its parent ended). */
  pauseFile: string;
  done: Promise<Ran>;
}

export class Device {
  readonly home: string;
  readonly root: string;
  readonly paths: PlainportPaths;
  /** Each project folder as it stood before this device's last offload of it: invariant 1's reference. */
  readonly released = new Map<string, TreeCapture>();
  private readonly children = new Set<Bun.Subprocess>();

  constructor(
    readonly name: string,
    private readonly world: Devices,
  ) {
    this.home = join(world.dir, name);
    this.root = join(this.home, "work");
    mkdirSync(this.root, { recursive: true });
    const paths = resolvePaths({ HOME: this.home }, { cwd: this.home });
    if (!paths.ok) throw new Error(paths.finding.message);
    this.paths = paths.value;
  }

  /** This device's ULID (device.json), once init ran. */
  get id(): string {
    return JSON.parse(readFileSync(this.paths.deviceFile, "utf8")).id;
  }

  /** The project folder at `path` in this device's root. */
  dir(path = "web"): string {
    return join(this.root, path);
  }

  env(extra: Record<string, string> = {}, tools = this.world.tools): Record<string, string> {
    return binaryEnv(this.home, tools, PASSWORD, extra);
  }

  /** Starts the binary; with `pauseAt`, it stops at that seam until resume(). */
  start(
    args: readonly string[],
    options: { pauseAt?: string; extra?: Record<string, string> } = {},
  ): Started {
    const pauseFile = join(this.home, `paused-${this.children.size}`);
    const extra = {
      // Every step and seam this device's binary reaches, with the time: what its release read could see (unseen).
      PLAINPORT_TEST_TRACE_FILE: this.traceFile,
      ...options.extra,
      ...(options.pauseAt === undefined
        ? {}
        : { PLAINPORT_TEST_PAUSE_AT: options.pauseAt, PLAINPORT_TEST_PAUSE_FILE: pauseFile }),
    };
    if (options.pauseAt !== undefined && args[0] === "offload") this.captureBefore(args);
    const child = Bun.spawn([this.world.harness.binary, ...args], {
      cwd: this.home,
      env: this.env(extra),
      stdout: "pipe",
      stderr: "pipe",
    });
    this.children.add(child);
    const done = (async (): Promise<Ran> => {
      const [out, err] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      await child.exited;
      return { code: child.exitCode, signal: child.signalCode, out, err };
    })();
    return {
      done,
      pauseFile,
      paused: async () => {
        const deadline = Date.now() + PAUSE_MS;
        while (!existsSync(pauseFile)) {
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(
              `${this.name}: ${args.join(" ")} ended before ${options.pauseAt}: ${(await done).err}`,
            );
          if (Date.now() > deadline)
            throw new Error(`${this.name}: ${args.join(" ")} never reached ${options.pauseAt}`);
          await Bun.sleep(10);
        }
      },
      resume: () => rmSync(pauseFile, { force: true }),
    };
  }

  /** Runs the binary to its end. An offload first captures the folder it may release (invariant 1). */
  async run(args: readonly string[], extra: Record<string, string> = {}): Promise<Ran> {
    if (args[0] === "offload") this.captureBefore(args);
    return this.start(args, { extra }).done;
  }

  private captureBefore(args: readonly string[]) {
    const path = args[1]?.split(":")[1] ?? "web";
    if (existsSync(this.dir(path))) this.released.set(path, captureTree(this.dir(path)));
  }

  /** `init` for this device: its own root `work`, the shared store. */
  async init(): Promise<void> {
    const ran = await this.run([
      "init",
      "--root",
      `work=${this.root}`,
      "--store-path",
      this.world.store,
      "--device",
      this.name,
      "--yes",
      "--json",
    ]);
    expectCode(ran, 0, `${this.name}: init`);
  }

  /**
   * Waits until no trash of a finished offload is left in this device's root (the detached delete ran); a trash held
   * for the conflict grace (offload.release.held, Q16) stays, and is not waited for.
   */
  async settled(): Promise<void> {
    const trash = join(this.root, ".plainport-trash");
    const held = (op: string): boolean => {
      try {
        return (
          JSON.parse(readFileSync(join(this.paths.journalDir, `${op}.json`), "utf8")).step ===
          "offload.release.held"
        );
      } catch {
        return false;
      }
    };
    const busy = (): boolean => {
      try {
        return readdirSync(trash).some((name) => !name.includes(".") && !held(name));
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 30_000;
    while (busy() && Date.now() < deadline) await Bun.sleep(25);
  }

  /** Invariants 1–3's subject for the project at `path` on this device. */
  async subject(projectId: string, path = "web"): Promise<InvariantSubject> {
    const released = this.released.get(path);
    return {
      now: new Date(),
      paths: this.paths,
      device: this.id,
      project: { id: projectId, dir: this.dir(path) },
      roots: [this.root],
      store: { name: STORE, ...(await this.world.open()) },
      ...(released === undefined ? {} : { released }),
      stripped: STRIPPED,
    };
  }

  /** The trace its binaries append each step and seam to (PLAINPORT_TEST_TRACE_FILE). */
  get traceFile(): string {
    return join(this.home, "steps.trace");
  }

  /**
   * Invariant 1's `unseen`, derived (Q16's residual): the events that landed on the store after this device's last
   * release read the catalog again (its offload.release.reread seam, live or in recover). A file's time is when it
   * landed on the local store; one that landed in the same millisecond counts as seen, so the list is never broader
   * than the truth. Nothing when it never released.
   */
  async unseen(): Promise<string[]> {
    if (!existsSync(this.traceFile)) return [];
    const reads = readFileSync(this.traceFile, "utf8")
      .split("\n")
      .filter((line) => line.endsWith(" offload.release.reread"));
    const at = Number(reads.at(-1)?.split(" ")[0]);
    if (!Number.isFinite(at)) return [];
    return (await this.world.events())
      .filter((e) => statSync(this.world.eventFile(e.id)).mtimeMs >= at + 1)
      .map((e) => e.id);
  }

  /** Kills what is still running (a test that failed while a device stood at a seam). */
  stop() {
    for (const child of this.children)
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {}
      }
  }
}

export const expectCode = (ran: Ran, code: number, what: string): void => {
  if (ran.code !== code)
    throw new Error(`${what} exited ${ran.code ?? ran.signal}, not ${code}: ${ran.err}${ran.out}`);
};

/** Two or three devices on one store. */
export class Devices {
  readonly dir: string;
  readonly store: string;
  readonly devices: Device[];
  /** The binaries' tools folder: the recording restic. */
  readonly tools: string;
  private readonly log: string;

  private constructor(
    readonly harness: Harness,
    names: readonly string[],
  ) {
    this.dir = mkdtempSync(join(harness.scratch, "world-"));
    this.store = join(this.dir, "store");
    this.log = join(this.dir, "restic.log");
    writeFileSync(this.log, "");
    // The recorder: one line per call, its arguments separated by US (0x1f).
    this.tools = join(this.dir, "tools");
    mkdirSync(this.tools);
    const wrapper = join(this.tools, "restic");
    writeFileSync(
      wrapper,
      `#!/bin/sh\n{ for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\n'; } >> '${this.log}'\nexec '${join(harness.realTools, "restic")}' "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    this.devices = names.map((name) => new Device(name, this));
  }

  /** Makes the devices (dev-a, dev-b by default) and runs init on each. */
  static async create(harness: Harness, names: readonly string[] = ["dev-a", "dev-b"]): Promise<Devices> {
    if (names.length < 2 || names.length > 3) throw new Error("two or three devices");
    const world = new Devices(harness, names);
    for (const d of world.devices) await d.init();
    return world;
  }

  device(name: string): Device {
    const found = this.devices.find((d) => d.name === name);
    if (found === undefined) throw new Error(`no device ${name}`);
    return found;
  }

  /** The crash matrix's project, copied into a device's root at `path`. */
  project(on: Device, path = "web"): string {
    copyProject(this.harness.template, on.dir(path));
    return on.dir(path);
  }

  /** The store, opened as the harness's own reader (the pinned restic, not the recorder). */
  async open(): Promise<{ blob: BlobStore; engine: Engine }> {
    const first = this.devices[0] as Device;
    const opened = await localStores(testHost(), first.env({}, this.harness.realTools)).open(
      STORE,
      { kind: "local", path: this.store },
      PASSWORD,
    );
    if (!opened.ok) throw new Error(opened.finding.message);
    return opened.value;
  }

  /** The file the local store keeps an event in. */
  eventFile(id: string): string {
    return join(this.store, ...storeEventKey(id).split("/"));
  }

  async events(): Promise<CatalogEvent[]> {
    const read = await readEvents(storeEventLog((await this.open()).blob));
    if (!read.ok) throw new Error(read.finding.message);
    return read.value.events;
  }

  async snapshots(): Promise<string[]> {
    const listed = await (await this.open()).engine.list({});
    if (!listed.ok) throw new Error(listed.finding.message);
    return listed.value.map((s) => s.id);
  }

  /** Every restic call the devices' binaries made, for invariant 6. */
  recorded(): RecordedCall[] {
    return readFileSync(this.log, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => ({ tool: "restic", args: line.split("\x1f").slice(0, -1) }));
  }

  async cleanup(): Promise<void> {
    for (const d of this.devices) d.stop();
    await removeSettled(this.dir);
  }
}
