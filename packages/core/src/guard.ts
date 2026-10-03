// The host port's refusal of protected paths: the authoritative "tests never touch the real home" (run decision D6;
// the bun test tripwire is only a best-effort net). A guarded host checks every file system path it is given, and
// every path it hands a child process, before anything happens; a refused one rejects with PathRefused, an
// exception, because touching a protected path is a bug, never an expected failure.
//
// Who turns it on: nobody by default. A host is guarded only when its creator passes a GuardPolicy. Test helpers do
// (testHost() in ./testing.ts protects the real home from the account database, whatever HOME says, and makes the
// checkout read-only, run decision D7), and the composition root passes guardFromEnv(process.env), which protects
// the real home a test run names in PLAINPORT_TRIPWIRE_REAL_HOME: the tripwire sets it and every child of a test
// inherits it, so a plainport binary a test starts is guarded too. The policy is explicit rather than sniffed from
// "am I under test", so production code never changes behaviour on a guess.
//
// A path is judged twice: as spelled (resolved, case-folded on macOS), before any file system call, so a protected
// path is refused without being touched; then with symlinks resolved, so a link that leads into a protected root is
// refused too. Under a read-only root, reads are allowed and writes refused; under a refused root, both are refused.
//
// Known limits: a refused root that is itself a symlink is matched by its spelling and its parent's real path
// only (resolving it would touch it); a child gets checked its cwd, its arguments that are absolute paths or
// `name=/absolute/path`, and every absolute path in its env values except PATH; what a child does with relative
// paths or inside a shell script is out of sight, and paths given to a child count as reads.

import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { LocalFs } from "./io.ts";
import type { RunSpec } from "./runner/types.ts";

export interface GuardPolicy {
  /** Folders whose contents must never be read or written. */
  refuse: readonly string[];
  /** Folders that may be read but never written, also inside a refused one. */
  readOnly: readonly string[];
}

export const PATH_REFUSED = "ERR_PLAINPORT_PATH_REFUSED";

export class PathRefused extends Error {
  override readonly name = "PathRefused";
  readonly code = PATH_REFUSED;
  constructor(
    readonly op: string,
    readonly path: string,
    readonly root: string,
  ) {
    super(
      `refused: ${op} ${path} is under ${root}, which this host protects. ` +
        'Tests must use a temp folder or the sandboxed HOME (AGENTS.md "Testing").',
    );
  }
}

const fold = process.platform === "darwin" ? (path: string) => path.toLowerCase() : (path: string) => path;
const isUnder = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** The path as the file system will see it: symlinks resolved (dangling ones followed), the missing tail kept. */
const canonical = async (path: string, depth = 0): Promise<string> => {
  const missing: string[] = [];
  let existing = resolve(path);
  for (;;) {
    try {
      return join(await realpath(existing), ...missing.reverse());
    } catch {
      // Missing, or a dangling symlink: look at it, then at its parent.
    }
    try {
      if (depth < 40 && (await lstat(existing)).isSymbolicLink()) {
        const target = resolve(dirname(existing), await readlink(existing));
        return canonical(join(target, ...missing.reverse()), depth + 1);
      }
    } catch {
      // Not there at all.
    }
    const parent = dirname(existing);
    if (parent === existing) return join(existing, ...missing.reverse());
    missing.push(basename(existing));
    existing = parent;
  }
};

interface Root {
  /** As given, for messages. */
  path: string;
  key: string;
}
interface Roots {
  refuse: Root[];
  readOnly: Root[];
}

export class PathGuard {
  private readonly literal: Roots;
  private resolved: Promise<Roots> | undefined;

  constructor(private readonly policy: GuardPolicy) {
    for (const root of [...policy.refuse, ...policy.readOnly]) {
      if (!isAbsolute(root) || resolve(root) === sep)
        throw new Error(`PathGuard: ${root} is not a usable root`);
    }
    const literal = (path: string): Root => ({ path, key: fold(resolve(path)) });
    this.literal = { refuse: policy.refuse.map(literal), readOnly: policy.readOnly.map(literal) };
  }

  /**
   * The roots with symlinks resolved. A refused root is never touched: only its parent is resolved. A read-only
   * root may be read, so it is resolved itself (its parent may lie in a refused root, as the checkout does).
   */
  private roots(): Promise<Roots> {
    const refused = async (path: string): Promise<Root> => ({
      path,
      key: fold(join(await canonical(dirname(resolve(path))), basename(resolve(path)))),
    });
    const readable = async (path: string): Promise<Root> => ({ path, key: fold(await canonical(path)) });
    this.resolved ??= (async () => ({
      refuse: await Promise.all(this.policy.refuse.map(refused)),
      readOnly: await Promise.all(this.policy.readOnly.map(readable)),
    }))();
    return this.resolved;
  }

  private static verdict(roots: Roots, key: string, write: boolean): Root | undefined {
    const readOnly = roots.readOnly.find((root) => isUnder(root.key, key));
    if (readOnly !== undefined) return write ? readOnly : undefined;
    return roots.refuse.find((root) => isUnder(root.key, key));
  }

  /** Rejects with PathRefused if the path is protected for this kind of access. */
  async check(op: string, path: string, write: boolean): Promise<void> {
    const spelled = PathGuard.verdict(this.literal, fold(resolve(path)), write);
    if (spelled !== undefined) throw new PathRefused(op, path, spelled.path);
    const real = PathGuard.verdict(await this.roots(), fold(await canonical(path)), write);
    if (real !== undefined) throw new PathRefused(op, path, real.path);
  }

  /** Checks what a child would be handed: its cwd, absolute path arguments and env paths. */
  async checkRun(spec: RunSpec): Promise<void> {
    const label = basename(spec.command);
    await this.check(`run ${label} in`, spec.cwd, false);
    for (const arg of spec.args ?? []) {
      const equals = arg.indexOf("=/");
      const path = arg.startsWith("/") ? arg : equals === -1 ? undefined : arg.slice(equals + 1);
      if (path !== undefined) await this.check(`run ${label} with argument`, path, false);
    }
    for (const [name, value] of Object.entries(spec.env)) {
      if (name === "PATH") continue;
      for (const piece of value.split(":")) {
        if (piece.startsWith("/")) await this.check(`run ${label} with ${name}=`, piece, false);
      }
    }
  }
}

const READS = [
  "readText",
  "readBytes",
  "readdir",
  "syncDir",
  "realpath",
  "stat",
  "entries",
  "writable",
  "executable",
  "lstat",
  "readlink",
  "readable",
  "freeBytes",
] as const;
const WRITES = [
  "writeTextDurable",
  "writeBytesDurable",
  "unlink",
  "mkdirp",
  "removeTree",
  "rmdir",
  "chmod",
] as const;

/** The file system, with every path checked by the guard first. */
export const guardedFs = (fs: LocalFs, guard: PathGuard): LocalFs => {
  const guarded = { ...fs };
  for (const [names, write] of [
    [READS, false],
    [WRITES, true],
  ] as const) {
    for (const name of names) {
      const call = fs[name] as (path: string, ...rest: unknown[]) => Promise<unknown>;
      (guarded as Record<string, unknown>)[name] = async (path: string, ...rest: unknown[]) => {
        await guard.check(name, path, write);
        return call(path, ...rest);
      };
    }
  }
  for (const name of ["link", "rename"] as const) {
    guarded[name] = async (from, to) => {
      await guard.check(name, from, name === "rename");
      await guard.check(name, to, true);
      return fs[name](from, to);
    };
  }
  return guarded;
};
