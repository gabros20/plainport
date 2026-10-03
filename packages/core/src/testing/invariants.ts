// The invariants DESIGN.md "Testing and fault injection" asserts after every saga test. invariantViolations checks 1
// to 3 on a device; the saga tests call it after each run, and the crash matrix (Task 15) after each recover.
// catalogInvariantViolations checks 4 to 6 on a store's events and its repository's snapshots, which the crash
// matrix asserts on the event set each crash and recover leave (the fold's own property tests cover any history):
//
// 1. A project folder is deleted only if its snapshot was verified and committed. For a folder that is gone (deleted,
//    or renamed into the trash), the deleted copy's own snapshot (the op its stub, its journal or the registry names)
//    has an offloaded event from this device, not discarded and not a fork, whose restic snapshot the store holds;
//    and that snapshot's listing matches `released`, the folder as it stood when release began (captureTree), outside
//    the stripped paths.
// 2. A stub exists if and only if the project is shelved on that machine: the catalog's status is shelved and the
//    folder is gone. A stub there must read back as a stub of the head.
// 3. No staging or trash folder remains from a finished operation: everything in <root>/.plainport-trash/ and
//    <root>/.plainport-staging/ belongs to an operation whose journal is open and unfinished, or released with a
//    keepLocalFor deadline still ahead. A released trash with no deadline is deleted by a detached process after the
//    command returns, so this waits up to `settleMs` for it.
// 4. Folding the same events in any order (and with copies, as a union of stores gives) yields the same state.
// 5. At most one lease: the fold names at most one per project, and no onload operation wrote two onloaded events.
// 6. Nothing but prune --yes deletes a snapshot (M1 has no prune: no snapshot the repository held is ever gone), and
//    nothing discards a snapshot an offloaded or checkpointed event names (D28: discarding is for failed uploads).
//
// Used only by tests.

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { CatalogEvent } from "../catalog/events.ts";
import { type CatalogState, foldCatalog } from "../catalog/fold.ts";
import { readEvents, storeEventLog } from "../catalog/log.ts";
import { type Journal, JournalSchema, journalFile } from "../journal/index.ts";
import type { PlainportPaths } from "../paths.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { Engine, EntryMeta } from "../ports/engine.ts";
import { ProjectRegistrySchema } from "../registry.ts";
import { StubSchema } from "../stub.ts";

export interface InvariantSubject {
  paths: PlainportPaths;
  /** This device's ULID. */
  device: string;
  /** The project: its ULID (undefined when the run failed before it had one) and its folder. */
  project: { id: string | undefined; dir: string };
  /** The folders whose .plainport-trash and .plainport-staging are checked: the project's root. */
  roots: readonly string[];
  store: { name: string; blob: BlobStore; engine: Engine };
  /** The folder as it stood when release began (captureTree at offload.release.trash). Required once it is gone. */
  released?: TreeCapture;
  /** Paths left out of the snapshot on purpose (the strip set), relative to the folder. */
  stripped?: readonly string[];
  /** How long invariant 3 waits for a detached deletion. Default 10 seconds, for a loaded CI runner. */
  settleMs?: number;
  /** The time keepLocalFor deadlines are compared with. Default: now. */
  now?: Date;
}

const present = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const readJournal = (paths: PlainportPaths, op: string): Journal | undefined => {
  try {
    const parsed = JournalSchema.safeParse(JSON.parse(readFileSync(journalFile(paths, op), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

const projectJournals = (subject: InvariantSubject): Journal[] => {
  if (!existsSync(subject.paths.journalDir)) return [];
  return readdirSync(subject.paths.journalDir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => readJournal(subject.paths, n.slice(0, -".json".length)))
    .filter((j): j is Journal => j !== undefined && j.project.id === subject.project.id);
};

/** Trash and staging folders whose operation is finished: no journal, or released with its deadline passed. */
const leftovers = (subject: InvariantSubject, now: Date): string[] => {
  const found: string[] = [];
  for (const root of subject.roots) {
    for (const holder of [".plainport-trash", ".plainport-staging"]) {
      const dir = join(root, holder);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        const journal = readJournal(subject.paths, name);
        const open =
          journal !== undefined &&
          (journal.kind !== "offload" ||
            journal.step !== "offload.release.delete" ||
            (journal.keepUntil !== undefined && Date.parse(journal.keepUntil) > now.getTime()));
        if (!open) found.push(join(dir, name));
      }
    }
  }
  return found;
};

const under = (paths: readonly string[], path: string): boolean =>
  paths.some((p) => path === p || path.startsWith(`${p}/`));

/** Which snapshot the deleted copy became: its stub's, its journal's op, or the registry's base. */
const deletedOp = (subject: InvariantSubject): string | undefined => {
  try {
    const stub = StubSchema.safeParse(JSON.parse(readFileSync(`${subject.project.dir}.plainport`, "utf8")));
    if (stub.success) return stub.data.snapshot;
  } catch {}
  // The newest of the project's journals: an older one may be a kept trash (keepLocalFor) of an earlier offload.
  const journal = projectJournals(subject)
    .filter((j) => j.kind === "offload" && j.project.dir === subject.project.dir)
    .sort((a, b) => (a.op < b.op ? -1 : 1))
    .at(-1);
  if (journal !== undefined) return journal.op;
  try {
    const registry = ProjectRegistrySchema.parse(
      JSON.parse(readFileSync(subject.paths.registryFile, "utf8")),
    );
    return subject.project.id === undefined ? undefined : registry.projects[subject.project.id]?.base;
  } catch {
    return undefined;
  }
};

/** Every invariant 1–3 violation, as sentences; none means all hold. */
export const invariantViolations = async (subject: InvariantSubject): Promise<string[]> => {
  const problems: string[] = [];
  const { dir, id } = subject.project;
  const gone = !present(dir);
  const read = await readEvents(storeEventLog(subject.store.blob));
  if (!read.ok) return [`the store's events could not be read: ${read.finding.message}`];
  const state = foldCatalog(read.value.events);
  const project = id === undefined ? undefined : state.projects[id];

  // 1
  if (gone) {
    const op = deletedOp(subject);
    const event = read.value.events.find(
      (e) => e.type === "offloaded" && e.project === id && e.snapshot === op && e.device === subject.device,
    );
    const stored = event?.type === "offloaded" ? event.stored[subject.store.name] : undefined;
    const listed = await subject.store.engine.list({ tags: ["plainport"] });
    const held = new Set(listed.ok ? listed.value.map((s) => s.id) : []);
    const fork = projectJournals(subject).some(
      (j) => j.op === op && j.kind === "offload" && j.diverged === true,
    );
    if (op === undefined)
      problems.push(`invariant 1: ${dir} is gone, and nothing names the snapshot it became`);
    else if (event === undefined || stored === undefined)
      problems.push(
        `invariant 1: ${dir} is gone, but its snapshot ${op} has no offloaded event in the store`,
      );
    else if ((project?.discarded ?? []).includes(op) || fork)
      problems.push(`invariant 1: ${dir} is gone, but its snapshot ${op} is discarded or a fork`);
    else if (!held.has(stored))
      problems.push(`invariant 1: ${dir} is gone, but the store's repository does not hold ${stored}`);
    else if (subject.released === undefined)
      problems.push(
        `invariant 1: ${dir} is gone, and there is no capture of it to verify its snapshot against`,
      );
    else {
      const entries: EntryMeta[] = [];
      const listing = await subject.store.engine.entries(stored, (e) => entries.push(e));
      if (!listing.ok) problems.push(`invariant 1: the snapshot ${stored} cannot be listed`);
      const stripped = subject.stripped ?? [];
      const seen = new Set<string>();
      const differ: string[] = [];
      for (const e of entries) {
        seen.add(e.path);
        const was = subject.released.get(e.path);
        if (
          was === undefined ||
          was.type !== e.type ||
          was.mode !== e.mode ||
          (e.type === "file" && was.size !== e.size) ||
          (e.type === "symlink" && was.linkTarget !== e.linkTarget)
        )
          differ.push(e.path);
      }
      for (const path of subject.released.keys())
        if (!seen.has(path) && !under(stripped, path)) differ.push(path);
      if (differ.length > 0)
        problems.push(
          `invariant 1: ${dir} is gone, but its snapshot does not match the folder as released: ${differ.sort().join(", ")}`,
        );
    }
  }

  // 2: a stub is a file that reads as one; anything else at the path (D47) is not this project's stub.
  const stub = `${dir}.plainport`;
  const shelved = project?.status === "shelved" && gone;
  const isStub = (() => {
    try {
      return lstatSync(stub).isFile() && StubSchema.safeParse(JSON.parse(readFileSync(stub, "utf8"))).success;
    } catch {
      return false;
    }
  })();
  if (isStub !== shelved) {
    problems.push(
      `invariant 2: the stub ${isStub ? "exists" : "is missing"}, but the project is ${
        shelved
          ? "shelved"
          : `${project?.status ?? "not in the catalog"} with its folder ${gone ? "gone" : "present"}`
      }`,
    );
  } else if (shelved) {
    const parsed = StubSchema.safeParse(JSON.parse(readFileSync(stub, "utf8")));
    if (!parsed.success) problems.push("invariant 2: the stub does not match the stub schema");
    else if (parsed.data.snapshot !== project?.head)
      problems.push(`invariant 2: the stub names ${parsed.data.snapshot}, the head is ${project?.head}`);
  }

  // 3
  const now = subject.now ?? new Date();
  const deadline = Date.now() + (subject.settleMs ?? 10_000);
  let left = leftovers(subject, now);
  while (left.length > 0 && Date.now() < deadline) {
    await Bun.sleep(25);
    left = leftovers(subject, now);
  }
  for (const path of left) problems.push(`invariant 3: ${path} remains from a finished operation`);
  return problems;
};

/** Each entry below a folder: type, size, mode and link target, keyed by relative path. */
export type TreeCapture = Map<string, { type: string; size?: number; mode: number; linkTarget?: string }>;

export const captureTree = (dir: string): TreeCapture => {
  const out: TreeCapture = new Map();
  const walk = (relative: string) => {
    for (const name of readdirSync(relative === "" ? dir : join(dir, relative)).sort()) {
      const path = relative === "" ? name : `${relative}/${name}`;
      const stat = lstatSync(join(dir, path));
      const mode = stat.mode & 0o7777;
      if (stat.isSymbolicLink())
        out.set(path, { type: "symlink", mode, linkTarget: readlinkSync(join(dir, path)) });
      else if (stat.isDirectory()) {
        out.set(path, { type: "dir", mode });
        walk(path);
      } else if (stat.isFile()) out.set(path, { type: "file", size: stat.size, mode });
    }
  };
  walk("");
  return out;
};

export interface CatalogInvariantSubject {
  /** Every event the store holds. */
  events: readonly CatalogEvent[];
  /** The engine ids of every snapshot the repository was seen to hold before (after the crash, say). */
  snapshotsBefore: Iterable<string>;
  /** The engine ids of the snapshots it holds now. */
  snapshotsNow: Iterable<string>;
  /** How many shuffled orders invariant 4 folds besides the reversed one. Default 6. */
  shuffles?: number;
  /** The fold under test; foldCatalog by default (a test of this helper passes a broken one). */
  fold?: (events: readonly CatalogEvent[]) => CatalogState;
}

/** A small seeded generator (mulberry32), so a failing order can be reproduced from the seed in the message. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const shuffled = <T>(list: readonly T[], seed: number): T[] => {
  const random = seeded(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

/** Every invariant 4–6 violation, as sentences; none means all hold. */
export const catalogInvariantViolations = (subject: CatalogInvariantSubject): string[] => {
  const problems: string[] = [];
  const fold = subject.fold ?? foldCatalog;
  const { events } = subject;
  const state = fold(events);
  const expected = JSON.stringify(state);

  // 4
  const orders: [string, CatalogEvent[]][] = [
    ["reversed", [...events].reverse()],
    ["doubled", [...events, ...[...events].reverse()]],
  ];
  for (let seed = 1; seed <= (subject.shuffles ?? 6); seed++)
    orders.push([`shuffle ${seed}`, shuffled(events, seed)]);
  for (const [name, order] of orders)
    if (JSON.stringify(fold(order)) !== expected)
      problems.push(`invariant 4: folding the events ${name} gives another state`);

  // 5: the fold's lease is one by its schema; what a crash could add is a second onloaded event for one onload.
  const onloads = new Map<string, Set<string>>();
  for (const e of events)
    if (e.type === "onloaded") onloads.set(e.op, (onloads.get(e.op) ?? new Set()).add(e.id));
  for (const [op, ids] of onloads)
    if (ids.size > 1) problems.push(`invariant 5: the onload ${op} wrote ${ids.size} onloaded events`);
  for (const [id, project] of Object.entries(state.projects))
    if (project.status === "shelved" && project.lease !== null)
      problems.push(`invariant 5: the project ${id} is shelved, yet ${project.lease.device} holds its lease`);

  // 6
  const now = new Set(subject.snapshotsNow);
  for (const id of new Set(subject.snapshotsBefore))
    if (!now.has(id)) problems.push(`invariant 6: the repository no longer holds ${id}`);
  const made = new Set<string>();
  for (const e of events)
    if (e.type === "offloaded" || e.type === "checkpointed") {
      made.add(e.snapshot);
      for (const stored of Object.values(e.stored)) made.add(stored);
    }
  for (const e of events)
    if (
      e.type === "snapshot-discarded" &&
      (made.has(e.snapshot) || Object.values(e.stored).some((s) => made.has(s)))
    )
      problems.push(`invariant 6: ${e.snapshot} is discarded although an offloaded event names it`);
  return problems;
};
