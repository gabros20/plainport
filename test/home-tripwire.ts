// Home tripwire (ADR-0021): the `bun test` preload that makes "tests never touch the real home" a failing test.
//
// It points HOME, XDG_*, CLAUDE_CONFIG_DIR, CODEX_HOME and GROK_HOME at a per-run temp directory, then patches
// node:fs and Bun's file and spawn APIs so that any test resolving a path under the real home fails: the call
// throws, and a global afterEach fails the test even if the test swallowed the error. Paths are compared after
// resolving symlinks, and case-insensitively on macOS. Reads inside this repository are allowed, because the
// checkout itself usually lives under the real home; writes to it are violations wherever it lives (run
// decision D7).
//
// It catches accidental real-home access by ordinary test code; it is not a security boundary (run decision D6).
// Known limits, by design; the authoritative refusal of real-home paths is the host port's (Task 7):
// - `..` after a symlink: paths are normalized before symlinks are resolved, as path.resolve does.
// - Link versus target: unlink and rename are judged by where a final symlink points, not by the link itself.
// - Already-open descriptors and FileHandles: fchmod, ftruncate, FileHandle methods and the like are not wrapped.
// - Native code, and shell paths inside Bun.$.
// - Child processes handed an absolute real-home path, or an explicit env with the real HOME.
//
// Bun quirks this works around (Bun 1.3.14):
// - os.homedir() and the default environment of Bun.spawn and node:child_process are fixed at process start;
//   assigning process.env does not reach them. So os.homedir is patched and spawns get process.env by default.
// - ESM imports of node:fs snapshot its exports when first imported. This file therefore uses require() and
//   must stay the first preload, so the patched functions are the ones every test file imports.

import { afterAll, afterEach } from "bun:test";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type Fn = (...args: unknown[]) => unknown;
type Patchable = Record<string, unknown>;

const fs: Patchable = require("node:fs");
const fsPromises: Patchable = require("node:fs/promises");
const os: Patchable = require("node:os");

const originalHomedir = os.homedir as () => string;
const originalTmpdir = os.tmpdir as () => string;
const mkdirSync = fs.mkdirSync as (path: string, options: { recursive: true }) => void;
const mkdtempSync = fs.mkdtempSync as (prefix: string) => string;
const rmSync = fs.rmSync as (path: string, options: { recursive: true; force: true }) => void;
const realpathNative = (fs.realpathSync as { native: (path: string) => string }).native;
const lstatSync = fs.lstatSync as (path: string) => { isSymbolicLink(): boolean };
const readlinkSync = fs.readlinkSync as (path: string) => string;

const foldCase =
  process.platform === "darwin" ? (path: string) => path.toLowerCase() : (path: string) => path;

/**
 * The path as the filesystem will see it: the nearest existing ancestor with symlinks resolved (dangling ones
 * followed too), plus the part that does not exist yet. Case-folded on macOS, whose volumes are case-insensitive.
 */
const canonical = (path: string, depth = 0): string => {
  const missing: string[] = [];
  let existing = resolve(path);
  for (;;) {
    try {
      return foldCase(join(realpathNative(existing), ...missing.reverse()));
    } catch {
      // Does not exist (or is a dangling symlink): try its parent.
    }
    try {
      if (depth < 40 && lstatSync(existing).isSymbolicLink()) {
        const target = resolve(dirname(existing), readlinkSync(existing));
        return canonical(join(target, ...missing.reverse()), depth + 1);
      }
    } catch {
      // Not there at all.
    }
    const parent = dirname(existing);
    if (parent === existing) return foldCase(join(existing, ...missing.reverse()));
    missing.push(basename(existing));
    existing = parent;
  }
};

const repoRoot = resolve(import.meta.dir, "..");
// A nested `bun test` (the tripwire's own test runs one) inherits a sandboxed HOME, so the outermost run passes
// the real home down.
const realHome = resolve(process.env.PLAINPORT_TRIPWIRE_REAL_HOME ?? originalHomedir());

const isUnder = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);
const realHomeKey = canonical(realHome);
const repoKey = canonical(repoRoot);

const tmp = resolve(originalTmpdir());
for (const [what, root] of [
  ["the real home", realHomeKey],
  ["the checkout", repoKey],
] as const) {
  if (isUnder(root, canonical(tmp))) {
    throw new Error(
      `home tripwire: the temp directory ${tmp} is in ${what}; set TMPDIR outside it and re-run`,
    );
  }
}

const sandbox = mkdtempSync(join(tmp, "plainport-test-home-"));
const sandboxEnv: Record<string, string> = {
  HOME: sandbox,
  XDG_CONFIG_HOME: join(sandbox, ".config"),
  XDG_DATA_HOME: join(sandbox, ".local", "share"),
  XDG_STATE_HOME: join(sandbox, ".local", "state"),
  XDG_CACHE_HOME: join(sandbox, ".cache"),
  XDG_RUNTIME_DIR: join(sandbox, ".run"),
  CLAUDE_CONFIG_DIR: join(sandbox, ".claude"),
  CODEX_HOME: join(sandbox, ".codex"),
  GROK_HOME: join(sandbox, ".grok"),
  XDG_CONFIG_DIRS: join(sandbox, ".xdg", "config-dirs"),
  XDG_DATA_DIRS: join(sandbox, ".xdg", "data-dirs"),
};
// Any other inherited XDG path variable (XDG_BIN_HOME, ...) is pointed into the sandbox as well.
for (const name of Object.keys(process.env)) {
  if (/^XDG_\w+_(HOME|DIRS?)$/.test(name) && !(name in sandboxEnv)) {
    sandboxEnv[name] = join(sandbox, ".xdg", name.toLowerCase());
  }
}
for (const [name, dir] of Object.entries(sandboxEnv)) {
  mkdirSync(dir, { recursive: true });
  process.env[name] = dir;
}
process.env.PLAINPORT_TEST_HOME = sandbox;
process.env.PLAINPORT_TRIPWIRE_REAL_HOME = realHome;
os.homedir = () => sandbox;
// bun test fires no process "exit" or "beforeExit" for a preload, but a global afterAll here runs once, after the
// last test file, whether the run passed or failed. The exit listener stays for plain `bun` runs.
const removeSandbox = () => rmSync(sandbox, { recursive: true, force: true });
afterAll(removeSandbox);
process.on("exit", removeSandbox);

let violations: string[] = [];

/** Returns and clears the violations recorded since the last call. Only the tripwire's own test uses it. */
export const takeViolations = (): string[] => {
  const taken = violations;
  violations = [];
  return taken;
};

/** True once this preload has patched the process. */
export const tripwireInstalled = (): boolean => os.homedir !== originalHomedir;

afterEach(() => {
  const found = takeViolations();
  if (found.length > 0) throw new Error(found.join("\n"));
});

const toPath = (value: unknown): string | undefined => {
  if (typeof value === "string") return resolve(value);
  if (value instanceof URL) return value.protocol === "file:" ? resolve(fileURLToPath(value)) : undefined;
  if (value instanceof Uint8Array) return resolve(Buffer.from(value).toString());
  return undefined;
};

const guard = (op: string, value: unknown, write: boolean): void => {
  const path = toPath(value);
  if (path === undefined) return;
  const key = canonical(path);
  const inCheckout = isUnder(repoKey, key);
  // Checkout: reads are fine, writes never are. Elsewhere: anything under the real home is refused.
  if (inCheckout ? !write : !isUnder(realHomeKey, key)) return;
  const resolved = key === foldCase(path) ? "" : ` (resolves to ${key})`;
  const where = inCheckout ? `is in the checkout ${repoRoot}` : `is under the real home ${realHome}`;
  const message =
    `home tripwire: ${op} ${path}${resolved} ${where}. ` +
    `Tests must not touch it: use a temp directory or the sandboxed HOME (${sandbox}). See AGENTS.md "Testing".`;
  violations.push(message);
  throw new Error(message);
};

// Which arguments of each node:fs function are paths. readFile, createReadStream and open are classified by
// their flags instead (below), since a write-capable flag turns them into writes.
const reads: Record<string, number[]> = {
  access: [0],
  exists: [0],
  readdir: [0],
  stat: [0],
  lstat: [0],
  statfs: [0],
  realpath: [0],
  readlink: [0],
  opendir: [0],
  watch: [0],
  watchFile: [0],
};
const writes: Record<string, number[]> = {
  appendFile: [0],
  chmod: [0],
  chown: [0],
  lchmod: [0],
  lchown: [0],
  link: [0, 1],
  lutimes: [0],
  mkdir: [0],
  mkdtemp: [0],
  rename: [0, 1],
  rm: [0],
  rmdir: [0],
  symlink: [1],
  truncate: [0],
  unlink: [0],
  utimes: [0],
  writeFile: [0],
  createWriteStream: [0],
};

const { O_ACCMODE = 3, O_CREAT, O_TRUNC, O_APPEND } = fs.constants as Record<string, number>;
const isWriteFlag = (flags: unknown): boolean =>
  typeof flags === "number"
    ? (flags & O_ACCMODE) !== 0 || (flags & ((O_CREAT ?? 0) | (O_TRUNC ?? 0) | (O_APPEND ?? 0))) !== 0
    : typeof flags === "string" && /[wa+]/.test(flags);
// readFile takes { flag }, createReadStream takes { flags }; either may be an encoding string instead.
const optionFlag = (options: unknown): unknown =>
  typeof options === "object" && options !== null
    ? ((options as { flag?: unknown; flags?: unknown }).flag ?? (options as { flags?: unknown }).flags)
    : undefined;

const wrap = (target: Patchable, name: string, check: (args: unknown[]) => void, async = false): void => {
  const original = target[name];
  if (typeof original !== "function") return;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    try {
      check(args);
    } catch (error) {
      if (async) return Promise.reject(error);
      throw error;
    }
    return (original as Fn).apply(this, args);
  };
  // Keep properties such as realpath.native and the util.promisify.custom of exists.
  Object.assign(wrapped, original);
  target[name] = wrapped;
};

for (const target of new Set([fs, fsPromises, fs.promises as Patchable])) {
  const async = target !== fs;
  for (const [table, write] of [
    [reads, false],
    [writes, true],
  ] as const) {
    for (const [name, positions] of Object.entries(table)) {
      for (const variant of [name, `${name}Sync`]) {
        wrap(
          target,
          variant,
          (args) => {
            for (const at of positions) guard(variant, args[at], write);
          },
          async,
        );
      }
    }
  }
  for (const variant of ["open", "openSync"]) {
    wrap(target, variant, (args) => guard(variant, args[0], isWriteFlag(args[1])), async);
  }
  // Copies read their source and write their destination.
  for (const variant of ["copyFile", "copyFileSync", "cp", "cpSync"]) {
    wrap(
      target,
      variant,
      (args) => {
        guard(variant, args[0], false);
        guard(variant, args[1], true);
      },
      async,
    );
  }
  for (const variant of ["readFile", "readFileSync", "createReadStream"]) {
    wrap(target, variant, (args) => guard(variant, args[0], isWriteFlag(optionFlag(args[1]))), async);
  }
}

// realpath.native and realpathSync.native were copied onto the wrappers unguarded.
for (const name of ["realpath", "realpathSync"]) {
  wrap(fs[name] as Patchable, "native", (args) => guard(`${name}.native`, args[0], false));
}

// Temp folders this run makes under the temp directory: `plainport-*` ones still there after the last test are a leak.
// Only this process's own folders are judged, so runs sharing a TMPDIR don't blame each other.
const madeTemp = new Set<string>();
for (const target of new Set([fs, fsPromises, fs.promises as Patchable])) {
  for (const variant of ["mkdtemp", "mkdtempSync"]) {
    const original = target[variant];
    if (typeof original !== "function") continue;
    const remember = (made: unknown) => {
      if (typeof made === "string" && basename(made).startsWith("plainport-") && dirname(made) === tmp)
        madeTemp.add(made);
      return made;
    };
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const last = args.at(-1);
      if (typeof last === "function") {
        args[args.length - 1] = (error: unknown, made: unknown) => {
          remember(made);
          (last as Fn)(error, made);
        };
        return (original as Fn).apply(this, args);
      }
      const made = (original as Fn).apply(this, args);
      return made instanceof Promise ? made.then(remember) : remember(made);
    };
    Object.assign(wrapped, original);
    target[variant] = wrapped;
  }
}

/** The temp folders this run made and left behind. */
export const leakedTempFolders = (): string[] =>
  [...madeTemp].filter((dir) => (fs.existsSync as (path: string) => boolean)(dir));

// After the last test: a leak fails the run (afterAll throws), and the folders are removed so they don't pile up.
afterAll(() => {
  const leaked = leakedTempFolders();
  for (const dir of leaked) rmSync(dir, { recursive: true, force: true });
  if (leaked.length > 0)
    throw new Error(
      `temp folder leak: this run left ${leaked.length} temp folder${leaked.length === 1 ? "" : "s"} in ${tmp} (${leaked
        .map((dir) => basename(dir))
        .join(", ")}); the test that made each must remove it`,
    );
});

const bun = Bun as unknown as Patchable;

// Bun.file is a read until one of its mutators is called.
type BunFileLike = Patchable & { name?: unknown };
const guardFile = (file: BunFileLike, path: unknown): BunFileLike => {
  for (const name of ["write", "delete", "unlink"])
    wrap(file, name, () => guard(`Bun.file().${name}`, path, true), true);
  wrap(file, "writer", () => guard("Bun.file().writer", path, true));
  const slice = file.slice as Fn;
  file.slice = (...args: unknown[]) => guardFile(slice.apply(file, args) as BunFileLike, path);
  return file;
};
const originalFile = bun.file as Fn;
bun.file = function (this: unknown, ...args: unknown[]) {
  guard("Bun.file", args[0], false);
  return guardFile(originalFile.apply(this, args) as BunFileLike, args[0]);
};

const originalWrite = bun.write as Fn;
bun.write = function (this: unknown, ...args: unknown[]) {
  const destination = args[0];
  try {
    const name = destination instanceof Blob && "name" in destination ? destination.name : destination;
    guard("Bun.write", name, true);
  } catch (error) {
    return Promise.reject(error);
  }
  return originalWrite.apply(this, args);
};

// Children get the sandboxed environment. A caller's explicit env is kept, but the sandbox variables it leaves
// out are filled in, so a minimal env (PATH and a few others) doesn't send the child back to the real home.
// node:child_process goes through these.
const sandboxVars = (): Record<string, string | undefined> => ({
  ...sandboxEnv,
  PLAINPORT_TEST_HOME: sandbox,
  PLAINPORT_TRIPWIRE_REAL_HOME: realHome,
});
const withEnv = (options: unknown): Record<string, unknown> => {
  const given = (options ?? {}) as Record<string, unknown>;
  if (given.env == null) return { ...given, env: { ...process.env } };
  const env = { ...(given.env as Record<string, string | undefined>) };
  for (const [name, value] of Object.entries(sandboxVars())) {
    if (env[name] === undefined) env[name] = value;
  }
  return { ...given, env };
};
for (const name of ["spawn", "spawnSync"]) {
  const original = bun[name] as Fn;
  bun[name] = function (this: unknown, ...args: unknown[]) {
    if (Array.isArray(args[0])) args[1] = withEnv(args[1]);
    else args[0] = withEnv(args[0]);
    return original.apply(this, args);
  };
}
