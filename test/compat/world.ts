// One compatibility scenario's world: a sandboxed home, a root with the crash matrix's project in it, a local store at
// ~/ssd, and the two real binaries run against them in turn (v0.1.1 as `old`, the checkout as `current`).
//
// The environment is the crash matrix's (test/crash-matrix/subprocess.test.ts): HOME and the XDG folders inside the
// sandbox, PLAINPORT_TRIPWIRE_REAL_HOME naming the real home so the hooked binaries accept their test rails, the
// restic copy in PLAINPORT_TOOLS_DIR, and a PATH without folders under the real home.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, type Sandbox } from "../../packages/core/src/testing/sandbox.ts";
import {
  copyProject,
  EXTRA_MODE,
  hashTree,
  type ProjectTemplate,
  type TreeHash,
} from "../crash-matrix/fixture.ts";

export const PASSWORD = "compat-pw";
const REAL_HOME = process.env.PLAINPORT_TRIPWIRE_REAL_HOME ?? "";
/** The test's PATH without the folders under the real home, which the binaries' guard refuses (git, lsof, find stay). */
const PATH = (process.env.PATH ?? "/usr/bin:/bin")
  .split(":")
  .filter((p) => REAL_HOME === "" || !(p === REAL_HOME || p.startsWith(`${REAL_HOME}/`)))
  .join(":");

export interface Binaries {
  /** v0.1.1, built from its tag with the test hook on. */
  old: string;
  /** The checkout, built with the test hook on. */
  current: string;
  /** Folder holding the restic both binaries use. */
  tools: string;
  template: ProjectTemplate;
}

export type Ran = { code: number | null; signal: string | null; out: string; err: string };

/** The last JSON line of a `--json` run, parsed; undefined when there is none. */
export const envelope = (
  ran: Ran,
): { ok?: boolean; data?: unknown; error?: { code?: string; finding?: { code?: string } } } | undefined => {
  const line = ran.out.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/** Every finding code a `--json` run printed (NDJSON lines or the envelope's own), for "no catalog.event-skipped". */
export const findingCodes = (ran: Ran): string[] =>
  [...`${ran.out}\n${ran.err}`.matchAll(/"code":"([a-z][a-z0-9.-]+)"/g)].map((m) => m[1] as string);

/** A stable digest of every file below `dir` (names, modes, bytes), for "nothing was written". */
export const treeDigest = (dir: string): string => {
  const hash = createHash("sha256");
  const walk = (folder: string, rel: string) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      const info = statSync(path);
      const here = rel === "" ? name : `${rel}/${name}`;
      if (info.isDirectory()) {
        hash.update(`d ${here}\n`);
        walk(path, here);
      } else {
        hash.update(`f ${here} ${info.mode & 0o7777} ${info.size}\n`);
        hash.update(readFileSync(path));
      }
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return hash.digest("hex");
};

export class World {
  readonly box: Sandbox;
  readonly root: string;
  readonly dir: string;
  readonly store: string;
  reference: TreeHash;
  private readonly children = new Set<Bun.Subprocess>();

  constructor(readonly bins: Binaries) {
    this.box = makeSandbox("plainport-compat-");
    this.root = join(this.box.home, "work");
    this.dir = join(this.root, "web");
    this.store = join(this.box.home, "ssd");
    mkdirSync(this.root, { recursive: true });
    copyProject(bins.template, this.dir);
    this.reference = hashTree(this.dir);
  }

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
      PLAINPORT_TOOLS_DIR: this.bins.tools,
      ...extra,
    };
  }

  /** Starts a binary; stop() kills what is still running when the scenario ends. */
  spawn(binary: string, args: string[], extra: Record<string, string> = {}) {
    const child = Bun.spawn([binary, ...args], {
      cwd: this.box.home,
      env: this.env(extra),
      stdout: "pipe",
      stderr: "pipe",
    });
    this.children.add(child);
    return child;
  }

  /**
   * Runs a binary to its end. With PLAINPORT_TEST_PAUSE_AT in `extra`, `pause` is called while the binary waits at that
   * step (the world is the test's to change), and the binary goes on when it returns.
   */
  async run(
    binary: string,
    args: string[],
    extra: Record<string, string> = {},
    pause?: () => Promise<void> | void,
  ): Promise<Ran> {
    const pauseFile = join(this.box.home, "paused");
    const child = this.spawn(
      binary,
      args,
      pause === undefined ? extra : { ...extra, PLAINPORT_TEST_PAUSE_FILE: pauseFile },
    );
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (pause !== undefined) {
      try {
        const deadline = Date.now() + 60_000;
        while (!existsSync(pauseFile) && child.exitCode === null && Date.now() < deadline)
          await Bun.sleep(10);
        if (!existsSync(pauseFile))
          throw new Error(`${args.join(" ")} never reached ${extra.PLAINPORT_TEST_PAUSE_AT}`);
        await pause();
      } catch (error) {
        this.stop();
        throw error;
      } finally {
        rmSync(pauseFile, { force: true });
      }
    }
    const [out, err] = await output;
    await child.exited;
    return { code: child.exitCode, signal: child.signalCode, out, err };
  }

  old = (args: string[], extra?: Record<string, string>, pause?: () => Promise<void> | void) =>
    this.run(this.bins.old, args, extra, pause);
  current = (args: string[], extra?: Record<string, string>, pause?: () => Promise<void> | void) =>
    this.run(this.bins.current, args, extra, pause);

  /** v0.1.1 sets up the M1 world: one root, one local store at ~/ssd, device mbp. */
  get initArgs(): string[] {
    return [
      "init",
      "--root",
      `work=${this.root}`,
      "--store-path",
      "~/ssd",
      "--device",
      "mbp",
      "--yes",
      "--json",
    ];
  }

  /** What no run may change: the project's tree before it. */
  stop() {
    for (const child of this.children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {}
    }
  }

  cleanup() {
    this.stop();
    try {
      chmodSync(join(this.dir, "src/extra.ts"), EXTRA_MODE);
    } catch {}
    // A detached delete may still be writing into the sandbox for a moment.
    for (let i = 0; i < 20 && existsSync(this.box.home); i++) {
      rmSync(this.box.home, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

export const expectOk = (ran: Ran, what: string): void => {
  if (ran.code !== 0) throw new Error(`${what} exited ${ran.code ?? ran.signal}: ${ran.err}${ran.out}`);
};
