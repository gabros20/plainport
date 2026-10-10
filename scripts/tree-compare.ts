// Tree comparison shared by the gates (M2 Task 3; the M1 gate and the M2 gate use it): what a round trip must keep,
// read from the file system with no help from plainport. `hashTree` records, for every entry under a folder, its
// type, permission bits, content hash (files), link target (symlinks), hard-link mates, extended attributes and BSD
// flags; `compareTrees` names every difference, one line per path. ACLs are not compared.
//
// - Hard links: the mates of a file are the other paths in the same tree that share its inode. Mates under a stripped
//   path are not in the tree, so linking to a stripped path does not count.
// - Extended attributes: read through libc (macOS and Linux) and compared by name and by the hash of the value.
//   `com.apple.provenance` is the kernel's own mark on files that came from a program; it is not data and is left out.
// - BSD flags (uchg, hidden, ...): macOS only, read with /usr/bin/stat; other systems have none to compare here.

import { dlopen, FFIType, type Pointer, read } from "bun:ffi";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export type TreeEntry = {
  type: "file" | "dir" | "symlink" | "other";
  mode: number;
  hash?: string;
  target?: string;
  mtimeMs?: number;
  /** Other paths in the tree that are hard links to this file, sorted. */
  links?: string[];
  /** Extended attribute name → sha256 of its value. */
  xattrs?: Record<string, string>;
  /** BSD flags as `stat` prints them (uchg,hidden), when any is set. */
  flags?: string;
  /** Metadata that could not be read; a tree with any compares as failed, never as "none". */
  unreadable?: string[];
};
export type Tree = Map<string, TreeEntry>;

/** Attributes the kernel sets on its own; they are not part of what a project holds. */
const KERNEL_XATTRS = new Set(["com.apple.provenance"]);

type Got<T> = { ok: true; value: T } | { ok: false; reason: string };
export type XattrApi = {
  list(path: string): Got<string[]>;
  get(path: string, name: string): Got<Buffer>;
};
export type StatRun = (argv: string[]) => { exitCode: number | null; stdout: string; stderr: string };
/** Where a tree's metadata comes from; tests replace it. `xattrs: null` is "no library". */
export type TreeSources = { xattrs?: XattrApi | null; stat?: StatRun };

/** errno labels for the message only; the numbers differ between macOS and Linux. */
const ERRNO_NAMES: Record<number, string> =
  process.platform === "darwin"
    ? { 1: "EPERM", 2: "ENOENT", 13: "EACCES", 22: "EINVAL", 34: "ERANGE", 93: "ENOATTR" }
    : { 1: "EPERM", 2: "ENOENT", 13: "EACCES", 22: "EINVAL", 34: "ERANGE", 61: "ENODATA" };
/**
 * The file system has no extended attributes at all (ENOTSUP is 45 on macOS, 95 on Linux). listxattr then reports
 * "none" rather than unreadable: there is nothing to lose, and the same file system answers the same on both sides.
 * It is the one failed listing that compares as an empty set; getxattr on such a file system stays an error.
 */
const UNSUPPORTED = new Set([45, 95]);

const cstr = (text: string): Buffer => Buffer.from(`${text}\0`);

const xattrApi = (): XattrApi | null => {
  try {
    const darwin = process.platform === "darwin";
    if (!darwin && process.platform !== "linux") return null;
    const lib = darwin
      ? dlopen("libSystem.B.dylib", {
          listxattr: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
          getxattr: {
            args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.i32],
            returns: FFIType.i64,
          },
          __error: { args: [], returns: FFIType.ptr },
        })
      : dlopen("libc.so.6", {
          llistxattr: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
          lgetxattr: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
          __errno_location: { args: [], returns: FFIType.ptr },
        });
    const sym = lib.symbols as unknown as Record<string, (...args: unknown[]) => number | bigint | Pointer>;
    const errno = (): number => {
      const at = (darwin ? sym.__error : sym.__errno_location)?.() as Pointer;
      return at === null ? -1 : read.i32(at);
    };
    const NOFOLLOW = 1;
    const list = (path: string, buf: Buffer | null, size: bigint) =>
      darwin ? sym.listxattr?.(cstr(path), buf, size, NOFOLLOW) : sym.llistxattr?.(cstr(path), buf, size);
    const get = (path: string, name: string, buf: Buffer | null, size: bigint) =>
      darwin
        ? sym.getxattr?.(cstr(path), cstr(name), buf, size, 0, NOFOLLOW)
        : sym.lgetxattr?.(cstr(path), cstr(name), buf, size);
    // The two-step "how big, then read" protocol; a failure carries the errno of the call that failed.
    const read2 = (
      ask: (buf: Buffer | null, size: bigint) => number | bigint | Pointer | undefined,
    ): Got<Buffer> | "unsupported" => {
      const fail = (): Got<Buffer> | "unsupported" => {
        const code = errno();
        return UNSUPPORTED.has(code)
          ? "unsupported"
          : { ok: false, reason: ERRNO_NAMES[code] ?? `errno ${code}` };
      };
      const size = Number(ask(null, 0n));
      if (size < 0) return fail();
      if (size === 0) return { ok: true, value: Buffer.alloc(0) };
      const buf = Buffer.alloc(size);
      const got = Number(ask(buf, BigInt(size)));
      return got < 0 ? fail() : { ok: true, value: buf.subarray(0, got) };
    };
    return {
      list: (path) => {
        const names = read2((buf, size) => list(path, buf, size));
        if (names === "unsupported") return { ok: true, value: [] };
        return names.ok
          ? {
              ok: true,
              value: names.value
                .toString("utf8")
                .split("\0")
                .filter((name) => name !== ""),
            }
          : names;
      },
      get: (path, name) => {
        const value = read2((buf, size) => get(path, name, buf, size));
        return value === "unsupported" ? { ok: false, reason: "ENOTSUP" } : value;
      },
    };
  } catch {
    return null;
  }
};

let defaultApi: XattrApi | null | undefined;
const NO_LIBRARY = "no xattr library on this system";

/** Name → hash of value for a path, or why it could not be read. Only the kernel's own attributes are left out. */
const xattrsOf = (
  api: XattrApi | null,
  path: string,
): { xattrs?: Record<string, string>; unreadable?: string } => {
  if (api === null) return { unreadable: `xattrs (${NO_LIBRARY})` };
  const names = api.list(path);
  if (!names.ok) return { unreadable: `xattrs (${names.reason})` };
  const out: Record<string, string> = {};
  for (const name of [...names.value].sort()) {
    if (KERNEL_XATTRS.has(name)) continue;
    const value = api.get(path, name);
    if (!value.ok) return { unreadable: `xattrs ${name} (${value.reason})` };
    out[name] = createHash("sha256").update(value.value).digest("hex");
  }
  return Object.keys(out).length === 0 ? {} : { xattrs: out };
};

const spawnStat: StatRun = (argv) => {
  const ran = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return { exitCode: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
};

/** One path's BSD flags ("" for none) read with lstat semantics (a symlink's own), or why not. */
const flagsOne = (run: StatRun, path: string): Got<string> => {
  const ran = run(["/usr/bin/stat", "-f", "%Sf\t%N", path]);
  if (ran.exitCode !== 0) return { ok: false, reason: `stat exited ${ran.exitCode}: ${ran.stderr.trim()}` };
  const line = ran.stdout.replace(/\n$/, "");
  const tab = line.indexOf("\t");
  if (tab < 0 || line.slice(tab + 1) !== path)
    return { ok: false, reason: "stat output did not match the path" };
  const flags = line.slice(0, tab);
  return { ok: true, value: flags === "-" ? "" : flags };
};

/** BSD flags per path (macOS). Batches are checked line by line against their paths; a batch that does not line up is re-read one path at a time. */
const flagsOf = (run: StatRun, paths: readonly string[]): Map<string, Got<string>> => {
  const out = new Map<string, Got<string>>();
  if (process.platform !== "darwin") return out;
  for (let at = 0; at < paths.length; at += 200) {
    const chunk = paths.slice(at, at + 200);
    const ran = run(["/usr/bin/stat", "-f", "%Sf\t%N", ...chunk]);
    const lines = ran.stdout.split("\n");
    const aligned =
      ran.exitCode === 0 &&
      lines.length === chunk.length + 1 &&
      chunk.every((path, i) => {
        const line = lines[i] as string;
        const tab = line.indexOf("\t");
        return tab >= 0 && line.slice(tab + 1) === path;
      });
    if (aligned) {
      chunk.forEach((path, i) => {
        const line = lines[i] as string;
        const flags = line.slice(0, line.indexOf("\t"));
        out.set(path, { ok: true, value: flags === "-" ? "" : flags });
      });
    } else for (const path of chunk) out.set(path, flagsOne(run, path));
  }
  return out;
};

const stripped = (path: string, strip: readonly string[]): boolean =>
  strip.some((s) => path === s || path.startsWith(`${s}/`));

/**
 * Every entry under `dir` (the folder itself as "."), minus the stripped paths: its type, permission bits, content
 * hash or link target, hard-link mates, extended attributes and flags.
 */
export const hashTree = (dir: string, strip: readonly string[], sources: TreeSources = {}): Tree => {
  if (sources.xattrs === undefined && defaultApi === undefined) defaultApi = xattrApi();
  const api = sources.xattrs === undefined ? (defaultApi as XattrApi | null) : sources.xattrs;
  const tree: Tree = new Map();
  const inodes = new Map<string, string[]>();
  const visit = (relative: string): void => {
    const full = relative === "." ? dir : join(dir, relative);
    const stat = lstatSync(full);
    const mode = stat.mode & 0o7777;
    const read = xattrsOf(api, full);
    const attrs = {
      ...(read.xattrs === undefined ? {} : { xattrs: read.xattrs }),
      ...(read.unreadable === undefined ? {} : { unreadable: [read.unreadable] }),
    };
    if (stat.isSymbolicLink()) {
      tree.set(relative, { type: "symlink", mode, target: readlinkSync(full), ...attrs });
    } else if (stat.isFile()) {
      const hash = createHash("sha256").update(readFileSync(full)).digest("hex");
      tree.set(relative, { type: "file", mode, hash, mtimeMs: stat.mtimeMs, ...attrs });
    } else if (stat.isDirectory()) {
      tree.set(relative, { type: "dir", mode, ...attrs });
      for (const name of readdirSync(full).sort()) {
        const child = relative === "." ? name : `${relative}/${name}`;
        if (!stripped(child, strip)) visit(child);
      }
    } else {
      tree.set(relative, { type: "other", mode, ...attrs });
    }
    if (!stat.isDirectory() && stat.nlink > 1) {
      const key = `${stat.dev}:${stat.ino}`;
      inodes.set(key, [...(inodes.get(key) ?? []), relative]);
    }
  };
  visit(".");
  for (const group of inodes.values()) {
    if (group.length < 2) continue;
    for (const path of group) {
      const entry = tree.get(path) as TreeEntry;
      entry.links = group.filter((other) => other !== path).sort();
    }
  }
  const paths = [...tree.keys()];
  const flags = flagsOf(
    sources.stat ?? spawnStat,
    paths.map((path) => (path === "." ? dir : join(dir, path))),
  );
  for (const path of paths) {
    const got = flags.get(path === "." ? dir : join(dir, path));
    const entry = tree.get(path) as TreeEntry;
    if (got === undefined) continue;
    if (!got.ok) entry.unreadable = [...(entry.unreadable ?? []), `flags (${got.reason})`];
    else if (got.value !== "") entry.flags = got.value;
  }
  return tree;
};

const names = (list: readonly string[] | undefined): string => (list?.length ? list.join(", ") : "none");

/** What differs between two trees, one line per path, sorted: missing, extra, or changed and how. */
export const compareTrees = (before: Tree, after: Tree): string[] => {
  const problems: string[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(path);
    const b = after.get(path);
    const unreadable = [...(a?.unreadable ?? []), ...(b?.unreadable ?? [])];
    if (unreadable.length > 0) {
      problems.push(`unreadable ${path}: ${[...new Set(unreadable)].join("; ")}`);
      continue;
    }
    if (b === undefined) problems.push(`missing ${path}`);
    else if (a === undefined) problems.push(`extra ${path}`);
    else {
      const how: string[] = [];
      if (a.type !== b.type) how.push(`type ${a.type} → ${b.type}`);
      if (a.mode !== b.mode) how.push(`mode ${a.mode.toString(8)} → ${b.mode.toString(8)}`);
      if (a.type === b.type && a.hash !== b.hash) how.push("content");
      if (a.type === b.type && a.target !== b.target) how.push(`target ${a.target} → ${b.target}`);
      if (names(a.links) !== names(b.links))
        how.push(`hard links with ${names(a.links)} → ${names(b.links)}`);
      for (const name of [
        ...new Set([...Object.keys(a.xattrs ?? {}), ...Object.keys(b.xattrs ?? {})]),
      ].sort()) {
        const was = a.xattrs?.[name];
        const now = b.xattrs?.[name];
        if (was === now) continue;
        how.push(
          now === undefined
            ? `xattr ${name} dropped`
            : was === undefined
              ? `xattr ${name} added`
              : `xattr ${name} value`,
        );
      }
      if ((a.flags ?? "") !== (b.flags ?? "")) how.push(`flags ${a.flags ?? "none"} → ${b.flags ?? "none"}`);
      if (how.length > 0) problems.push(`changed ${path}: ${how.join(", ")}`);
    }
  }
  return problems;
};

/** Files whose modification time differs (reported, not part of byte identity). */
export const mtimeChanges = (before: Tree, after: Tree): number =>
  [...before].filter(([path, a]) => a.type === "file" && after.get(path)?.mtimeMs !== a.mtimeMs).length;
