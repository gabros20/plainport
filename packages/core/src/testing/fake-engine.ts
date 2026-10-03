// An in-memory Engine for tests: a "repository" that keeps each snapshot's entries and file bytes, so sagas run
// without restic (T0). A snapshot walks the folder as restic would (excludes are exact relative paths, symlinks are
// stored as links), and a file it cannot read fails the snapshot the way restic's exit 3 does: the incomplete
// snapshot is kept in the repository and named in the failure (D28). Hooks let a test edit files while the
// "upload" runs, damage a listing, or fail a call. Used only by *.test.ts files and their helpers.

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  type Stats,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Failure, fail, finding, ok } from "@plainport/contract";
import type {
  Engine,
  EntryMeta,
  RunContext,
  SnapshotFailure,
  SnapshotInfo,
  SnapshotInput,
} from "../ports/engine.ts";
import { formatNs } from "../scan/manifest.ts";

export interface FakeSnapshot {
  info: SnapshotInfo;
  entries: EntryMeta[];
  /** File bytes by path. */
  data: Map<string, Uint8Array>;
  /** Written although some files could not be read (restic exit 3). */
  incomplete: boolean;
}

export interface FakeRepository {
  initialized: boolean;
  password: string | undefined;
  snapshots: FakeSnapshot[];
}

export const fakeRepository = (): FakeRepository => ({
  initialized: false,
  password: undefined,
  snapshots: [],
});

export interface FakeEngineHooks {
  /** Runs while a snapshot "uploads", after the walk started: a test edits files here. `attempt` counts from 1. */
  duringSnapshot?(input: SnapshotInput, attempt: number): void | Promise<void>;
  /** Runs while a listing is read, before its entries are handed out: a test edits files here. */
  duringListing?(snapshot: string): void | Promise<void>;
  /** Rewrites the entries a listing hands out, to fake a snapshot that does not match the folder. */
  listing?(entries: EntryMeta[]): EntryMeta[];
  /** Runs while a restore writes, after the folders and files are in place and before modes and times: a test edits
   * or damages the restored tree here. */
  duringRestore?(target: string): void | Promise<void>;
  /**
   * The next call of this method returns the failure instead of running. A restore writes its folders and the first
   * of its files before it fails, as an interrupted one leaves them.
   */
  failNext?: Partial<Record<"snapshot" | "list" | "entries" | "init" | "restore", Failure>>;
}

/** What each restore was asked, in order. */
export interface RestoreCall {
  snapshot: string;
  target: string;
  overwrite: string;
  /** Files written and files left as they were (an existing file of the same size, with overwrite if-changed). */
  written: number;
  skipped: number;
}

export interface FakeEngine extends Engine {
  readonly repository: FakeRepository;
  readonly hooks: FakeEngineHooks;
  /** Snapshot calls made, in order. */
  readonly calls: SnapshotInput[];
  readonly restores: RestoreCall[];
}

const hex64 = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

const taken = <K extends keyof NonNullable<FakeEngineHooks["failNext"]>>(
  hooks: FakeEngineHooks,
  method: K,
): Failure | undefined => {
  const failure = hooks.failNext?.[method];
  if (failure !== undefined && hooks.failNext !== undefined) delete hooks.failNext[method];
  return failure;
};

const typeOf = (stat: Stats): EntryMeta["type"] =>
  stat.isFile()
    ? "file"
    : stat.isDirectory()
      ? "dir"
      : stat.isSymbolicLink()
        ? "symlink"
        : stat.isSocket()
          ? "socket"
          : stat.isFIFO()
            ? "fifo"
            : stat.isCharacterDevice()
              ? "chardev"
              : "dev";

/** Walks `dir` like restic backup: every entry below it except the excluded paths and what lies inside them. */
const walk = (
  dir: string,
  excludes: ReadonlySet<string>,
): { entries: EntryMeta[]; data: Map<string, Uint8Array>; unreadable: string[] } => {
  const entries: EntryMeta[] = [];
  const data = new Map<string, Uint8Array>();
  const unreadable: string[] = [];
  const visit = (relative: string) => {
    const absolute = relative === "" ? dir : join(dir, relative);
    let names: string[];
    try {
      names = readdirSync(absolute).sort();
    } catch {
      unreadable.push(relative);
      return;
    }
    for (const name of names) {
      const path = relative === "" ? name : `${relative}/${name}`;
      if (excludes.has(path)) continue;
      const full = join(dir, path);
      const stat = lstatSync(full, { bigint: true });
      const type = typeOf(lstatSync(full));
      const entry: EntryMeta = {
        path,
        type,
        mode: Number(stat.mode & 0o7777n),
        mtime: formatNs(stat.mtimeNs),
      };
      if (type === "file") {
        entry.size = Number(stat.size);
        try {
          data.set(path, new Uint8Array(readFileSync(full)));
        } catch {
          unreadable.push(path);
          continue;
        }
      }
      if (type === "symlink") entry.linkTarget = readlinkSync(full);
      entries.push(entry);
      if (type === "dir") visit(path);
    }
  };
  visit("");
  return { entries, data, unreadable };
};

export const fakeEngine = (
  repository: FakeRepository = fakeRepository(),
  hooks: FakeEngineHooks = {},
): FakeEngine => {
  const calls: SnapshotInput[] = [];
  const restores: RestoreCall[] = [];
  const missing = (): Failure =>
    fail(finding("restic.repo-missing", { message: "the fake repository was never initialised" }));
  const find = (id: string) => repository.snapshots.find((s) => s.info.id === id);
  const notFound = (id: string): Failure =>
    fail(finding("restic.snapshot-not-found", { message: `the fake repository has no snapshot ${id}` }));
  return {
    id: "fake",
    repository,
    hooks,
    calls,
    restores,
    init: async () => {
      const failure = taken(hooks, "init");
      if (failure !== undefined) return failure;
      if (repository.initialized)
        return fail(finding("restic.repo-exists", { message: "the fake repository exists already" }));
      repository.initialized = true;
      return ok({ id: hex64() });
    },
    snapshot: async (input: SnapshotInput, ctx: RunContext) => {
      calls.push(input);
      const failure = taken(hooks, "snapshot");
      if (failure !== undefined) return failure;
      if (!repository.initialized) return missing();
      if (ctx.signal?.aborted)
        return fail(finding("process.cancelled", { message: "the fake snapshot was cancelled" }));
      await hooks.duringSnapshot?.(input, calls.length);
      const walked = walk(input.dir, new Set(input.excludes));
      const id = hex64();
      repository.snapshots.push({
        info: {
          id,
          time: new Date().toISOString(),
          hostname: "fake",
          paths: [input.dir],
          tags: [...input.tags],
          ...(input.parent === undefined ? {} : { parent: input.parent }),
        },
        entries: walked.entries,
        data: walked.data,
        incomplete: walked.unreadable.length > 0,
      });
      if (walked.unreadable.length > 0) {
        const failed: SnapshotFailure = {
          ...fail(
            finding("restic.unreadable-files", {
              message: `restic could not read ${walked.unreadable.join(", ")}; snapshot ${id.slice(0, 8)} is incomplete`,
              paths: walked.unreadable,
            }),
          ),
          incomplete: { snapshot: id },
        };
        return failed;
      }
      const files = walked.entries.filter((e) => e.type === "file").length;
      return ok({
        id,
        stats: {
          filesNew: files,
          filesChanged: 0,
          filesUnmodified: 0,
          dirsNew: walked.entries.length - files,
          dirsChanged: 0,
          dirsUnmodified: 0,
          dataAdded: [...walked.data.values()].reduce((sum, d) => sum + d.length, 0),
          totalFilesProcessed: files,
          totalBytesProcessed: [...walked.data.values()].reduce((sum, d) => sum + d.length, 0),
        },
      });
    },
    list: async (filter) => {
      const failure = taken(hooks, "list");
      if (failure !== undefined) return failure;
      if (!repository.initialized) return missing();
      const tags = filter.tags ?? [];
      return ok(
        repository.snapshots.filter((s) => tags.every((t) => s.info.tags.includes(t))).map((s) => s.info),
      );
    },
    entries: async (id, onEntry) => {
      const failure = taken(hooks, "entries");
      if (failure !== undefined) return failure;
      if (!repository.initialized) return missing();
      const snapshot = find(id);
      if (snapshot === undefined) return notFound(id);
      await hooks.duringListing?.(id);
      const listed = hooks.listing?.(snapshot.entries.map((e) => ({ ...e }))) ?? snapshot.entries;
      for (const entry of listed) onEntry({ ...entry });
      return ok({ snapshot: snapshot.info, count: listed.length });
    },
    restore: async (id, target, _ctx, options = {}) => {
      if (!repository.initialized) return missing();
      const snapshot = find(id);
      if (snapshot === undefined) return notFound(id);
      const failure = taken(hooks, "restore");
      const overwrite = options.overwrite ?? "always";
      const call: RestoreCall = { snapshot: id, target, overwrite, written: 0, skipped: 0 };
      restores.push(call);
      mkdirSync(target, { recursive: true });
      const existing = (path: string) => {
        try {
          return lstatSync(path);
        } catch {
          return undefined;
        }
      };
      let bytes = 0;
      let files = 0;
      for (const entry of snapshot.entries) {
        const path = join(target, entry.path);
        const there = existing(path);
        if (entry.type === "dir") mkdirSync(path, { recursive: true });
        else if (entry.type === "symlink") {
          if (there !== undefined && overwrite !== "always") continue;
          if (there !== undefined) rmSync(path, { force: true });
          symlinkSync(entry.linkTarget ?? "", path);
        } else if (entry.type === "file") {
          if (failure !== undefined && files >= 1) continue;
          const data = snapshot.data.get(entry.path) ?? new Uint8Array();
          files++;
          if (
            there !== undefined &&
            (overwrite === "never" || (overwrite === "if-changed" && there.size === data.length))
          ) {
            call.skipped++;
            continue;
          }
          if (there !== undefined) chmodSync(path, 0o600);
          writeFileSync(path, data);
          call.written++;
          bytes += data.length;
        }
      }
      if (failure !== undefined) return failure;
      await hooks.duringRestore?.(target);
      // Modes and times after the contents, deepest first, so a read-only folder is filled before it is closed.
      for (const entry of [...snapshot.entries].reverse()) {
        if (entry.type === "symlink") continue;
        const path = join(target, entry.path);
        if (existing(path) === undefined) continue;
        chmodSync(path, entry.mode);
        const seconds = Date.parse(entry.mtime) / 1000;
        utimesSync(path, seconds, seconds);
      }
      const total = snapshot.entries.filter((e) => e.type === "file").length;
      return ok({
        totalFiles: total,
        filesRestored: call.written,
        filesSkipped: call.skipped,
        filesDeleted: 0,
        totalBytes: bytes,
        bytesRestored: bytes,
        bytesSkipped: 0,
      });
    },
    check: async () => ok({ ok: true, errors: 0, messages: [] }),
  };
};
