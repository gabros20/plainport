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

import { dlopen, FFIType, ptr } from "bun:ffi";
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
};
export type Tree = Map<string, TreeEntry>;

/** Attributes the kernel sets on its own; they are not part of what a project holds. */
const KERNEL_XATTRS = new Set(["com.apple.provenance"]);

type XattrApi = { list(path: string): string[]; get(path: string, name: string): Buffer | undefined };

const xattrApi = (): XattrApi | undefined => {
  try {
    if (process.platform === "darwin") {
      const lib = dlopen("libSystem.B.dylib", {
        listxattr: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
        getxattr: {
          args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.i32],
          returns: FFIType.i64,
        },
      });
      const NOFOLLOW = 1;
      return make(
        (path, buf, size) => lib.symbols.listxattr(ptr(cstr(path)), buf, size, NOFOLLOW),
        (path, name, buf, size) =>
          lib.symbols.getxattr(ptr(cstr(path)), ptr(cstr(name)), buf, size, 0, NOFOLLOW),
      );
    }
    if (process.platform === "linux") {
      const lib = dlopen("libc.so.6", {
        llistxattr: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
        lgetxattr: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
      });
      return make(
        (path, buf, size) => lib.symbols.llistxattr(ptr(cstr(path)), buf, size),
        (path, name, buf, size) => lib.symbols.lgetxattr(ptr(cstr(path)), ptr(cstr(name)), buf, size),
      );
    }
  } catch {
    // No libc to ask: extended attributes are not compared.
  }
  return undefined;
};

const cstr = (text: string): Buffer => Buffer.from(`${text}\0`);

type Reader = (path: string, buf: Buffer | null, size: bigint) => number | bigint;
type NamedReader = (path: string, name: string, buf: Buffer | null, size: bigint) => number | bigint;

/** The two-step "how big, then read" protocol of listxattr and getxattr. */
const make = (list: Reader, get: NamedReader): XattrApi => {
  const read = (ask: (buf: Buffer | null, size: bigint) => number | bigint): Buffer | undefined => {
    const size = Number(ask(null, 0n));
    if (size < 0) return undefined;
    if (size === 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(size);
    const got = Number(ask(buf, BigInt(size)));
    return got < 0 ? undefined : buf.subarray(0, got);
  };
  return {
    list: (path) => {
      const names = read((buf, size) => list(path, buf, size));
      return names === undefined
        ? []
        : names
            .toString("utf8")
            .split("\0")
            .filter((name) => name !== "");
    },
    get: (path, name) => read((buf, size) => get(path, name, buf, size)),
  };
};

let api: XattrApi | undefined | null = null;
const xattrs = (path: string): Record<string, string> | undefined => {
  if (api === null) api = xattrApi();
  if (api === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const name of api.list(path).sort()) {
    if (KERNEL_XATTRS.has(name)) continue;
    const value = api.get(path, name);
    out[name] = createHash("sha256")
      .update(value ?? "")
      .digest("hex");
  }
  return Object.keys(out).length === 0 ? undefined : out;
};

/** The BSD flags of each path (macOS), "" for none; chunks keep the command line short. */
const flagsOf = (paths: readonly string[]): Map<string, string> => {
  const out = new Map<string, string>();
  if (process.platform !== "darwin") return out;
  for (let at = 0; at < paths.length; at += 200) {
    const chunk = paths.slice(at, at + 200);
    const ran = Bun.spawnSync(["/usr/bin/stat", "-L", "-f", "%Sf", ...chunk], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const lines = ran.stdout.toString().split("\n");
    chunk.forEach((path, index) => {
      const flags = lines[index]?.trim() ?? "-";
      if (flags !== "-" && flags !== "") out.set(path, flags);
    });
  }
  return out;
};

const stripped = (path: string, strip: readonly string[]): boolean =>
  strip.some((s) => path === s || path.startsWith(`${s}/`));

/**
 * Every entry under `dir` (the folder itself as "."), minus the stripped paths: its type, permission bits, content
 * hash or link target, hard-link mates, extended attributes and flags.
 */
export const hashTree = (dir: string, strip: readonly string[]): Tree => {
  const tree: Tree = new Map();
  const inodes = new Map<string, string[]>();
  const visit = (relative: string): void => {
    const full = relative === "." ? dir : join(dir, relative);
    const stat = lstatSync(full);
    const mode = stat.mode & 0o7777;
    const extended = xattrs(full);
    const attrs = extended === undefined ? {} : { xattrs: extended };
    if (stat.isSymbolicLink()) {
      tree.set(relative, { type: "symlink", mode, target: readlinkSync(full), ...attrs });
    } else if (stat.isFile()) {
      const hash = createHash("sha256").update(readFileSync(full)).digest("hex");
      tree.set(relative, { type: "file", mode, hash, mtimeMs: stat.mtimeMs, ...attrs });
      if (stat.nlink > 1) {
        const key = `${stat.dev}:${stat.ino}`;
        inodes.set(key, [...(inodes.get(key) ?? []), relative]);
      }
    } else if (stat.isDirectory()) {
      tree.set(relative, { type: "dir", mode, ...attrs });
      for (const name of readdirSync(full).sort()) {
        const child = relative === "." ? name : `${relative}/${name}`;
        if (!stripped(child, strip)) visit(child);
      }
    } else {
      tree.set(relative, { type: "other", mode, ...attrs });
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
  const flags = flagsOf(paths.map((path) => (path === "." ? dir : join(dir, path))));
  for (const path of paths) {
    const set = flags.get(path === "." ? dir : join(dir, path));
    if (set !== undefined) (tree.get(path) as TreeEntry).flags = set;
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
