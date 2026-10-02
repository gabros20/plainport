// Home tripwire (ADR-0021): the `bun test` preload that makes "tests never touch the real home" a failing test.
//
// It points HOME, XDG_*, CLAUDE_CONFIG_DIR, CODEX_HOME and GROK_HOME at a per-run temp directory, then patches
// node:fs and Bun's file and spawn APIs so that any test resolving a path under the real home fails: the call
// throws, and a global afterEach fails the test even if the test swallowed the error. Reads inside this
// repository are allowed, because the checkout itself usually lives under the real home.
//
// Bun quirks this works around (Bun 1.3.14):
// - os.homedir() and the default environment of Bun.spawn and node:child_process are fixed at process start;
//   assigning process.env does not reach them. So os.homedir is patched and spawns get process.env by default.
// - ESM imports of node:fs snapshot its exports when first imported. This file therefore uses require() and
//   must stay the first preload, so the patched functions are the ones every test file imports.

import { afterEach } from "bun:test";
import { join, resolve, sep } from "node:path";
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

const repoRoot = resolve(import.meta.dir, "..");
// A nested `bun test` (the tripwire's own test runs one) inherits a sandboxed HOME, so the outermost run passes
// the real home down.
const realHome = resolve(process.env.PLAINPORT_TRIPWIRE_REAL_HOME ?? originalHomedir());

const isUnder = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);

const tmp = resolve(originalTmpdir());
if (isUnder(realHome, tmp)) {
  throw new Error(
    `home tripwire: the temp directory ${tmp} is under the real home ${realHome}; set TMPDIR outside it and re-run`,
  );
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
};
for (const [name, dir] of Object.entries(sandboxEnv)) {
  mkdirSync(dir, { recursive: true });
  process.env[name] = dir;
}
process.env.PLAINPORT_TEST_HOME = sandbox;
process.env.PLAINPORT_TRIPWIRE_REAL_HOME = realHome;
os.homedir = () => sandbox;
process.on("exit", () => rmSync(sandbox, { recursive: true, force: true }));

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
  if (path === undefined || !isUnder(realHome, path)) return;
  if (!write && isUnder(repoRoot, path)) return;
  const message =
    `home tripwire: ${op} ${path} is under the real home ${realHome}. ` +
    `Tests must not touch it: use a temp directory or the sandboxed HOME (${sandbox}). See AGENTS.md "Testing".`;
  violations.push(message);
  throw new Error(message);
};

// Which arguments of each node:fs function are paths.
const reads: Record<string, number[]> = {
  access: [0],
  exists: [0],
  readFile: [0],
  readdir: [0],
  stat: [0],
  lstat: [0],
  statfs: [0],
  realpath: [0],
  readlink: [0],
  opendir: [0],
  createReadStream: [0],
  watch: [0],
  watchFile: [0],
};
const writes: Record<string, number[]> = {
  appendFile: [0],
  chmod: [0],
  chown: [0],
  copyFile: [0, 1],
  cp: [0, 1],
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

const isWriteFlag = (flags: unknown): boolean =>
  typeof flags === "number" ? (flags & 3) !== 0 : typeof flags === "string" && /[wa+]/.test(flags);

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
}

const bun = Bun as unknown as Patchable;

wrap(bun, "file", (args) => guard("Bun.file", args[0], false));

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

// Children get the sandboxed environment unless the caller passes one. node:child_process goes through these.
const withEnv = (options: unknown): Record<string, unknown> => {
  const given = (options ?? {}) as Record<string, unknown>;
  return given.env == null ? { ...given, env: { ...process.env } } : given;
};
for (const name of ["spawn", "spawnSync"]) {
  const original = bun[name] as Fn;
  bun[name] = function (this: unknown, ...args: unknown[]) {
    if (Array.isArray(args[0])) args[1] = withEnv(args[1]);
    else args[0] = withEnv(args[0]);
    return original.apply(this, args);
  };
}
