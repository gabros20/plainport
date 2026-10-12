// Catalog events on a store, and the two things kept beside them (DESIGN.md "Storage → Layout on every store",
// "Local state per machine"):
//
//   <store root>/meta/v1/events/<ulid>.json   the events, written create-only where the store can do it
//   <store root>/meta/v1/state.json           a cache of the fold, rebuilt whenever the events change
//   ~/.cache/plainport/<store>/events/        this machine's mirror of a store's events, so ls works offline
//
// An event file is one line: plain JSON, or that line sealed on a sealed store. Every byte read and written here goes
// through the codec (codec.ts). Appending the same event twice is a no-op, so a step that is retried after a crash
// (D24) does not fail on its own earlier write. Reading skips what it cannot use, with the codec's finding, and never
// changes or deletes an event file. The mirror holds opened events, and records each store file's name and size.
// A snapshot event names its location by containment (Q11, stored.ts): one `stored` entry, so one with zero or
// several is skipped by the codec as unsupported (stored-multiple) and a writer refuses it.

import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type Failure,
  type Finding,
  FindingSchema,
  fail,
  finding,
  ok,
  type Result,
} from "@plainport/contract";
import { z } from "zod";
import { describeIssues } from "../config/toml.ts";
import type { PlainportPaths } from "../paths.ts";
import type { BlobEntry, BlobStore } from "../ports/blob-store.ts";
import { isUlid, UlidSchema } from "../ulid.ts";
import {
  type CatalogPolicy,
  decode,
  encode,
  encodePlain,
  PLAIN_CATALOG,
  policyFits,
  SKIP_CODES,
  type Skip,
  STORE_EVENTS_PREFIX,
  sameEvent,
  skippedEvent,
  storedCount,
  type Tainted,
} from "./codec.ts";
import { type CatalogEvent, CatalogEventSchema } from "./events.ts";
import { type CatalogState, CatalogStateSchema, compare, FOLD_VERSION, foldCatalog } from "./fold.ts";
import { identityChanged, readUsableStore } from "./identity.ts";

/** Where events live on a store (codec.ts), and in a local mirror. */
export { STORE_EVENTS_PREFIX, type Tainted };
export const MIRROR_EVENTS_PREFIX = "events/";
/** The store-side fold cache DESIGN's layout allows. Reads never write to a store (D45), so M1 never writes it. */
export const STATE_KEY = "meta/v1/state.json";
/** The fold cached beside a mirror's events. */
export const MIRROR_STATE_KEY = "state.json";
/** Beside a mirror's events: the store it mirrors, its last sync, and store files it could not copy. */
export const MIRROR_FILE_KEY = "mirror.json";

/** A folder of event files: a BlobStore, the prefix the events sit under, and how they are encoded there. */
export interface EventLog {
  store: BlobStore;
  prefix: string;
  policy: CatalogPolicy;
}

/** A store's events, under its catalog policy (plain unless the store's is sealed). */
export const storeEventLog = (store: BlobStore, policy: CatalogPolicy = PLAIN_CATALOG): EventLog => ({
  store,
  prefix: STORE_EVENTS_PREFIX,
  policy,
});
/** A mirror's events: always the opened, plain bytes. */
export const mirrorEventLog = (store: BlobStore): EventLog => ({
  store,
  prefix: MIRROR_EVENTS_PREFIX,
  policy: PLAIN_CATALOG,
});

/**
 * The root of a store's event mirror, `<cache>/plainport/<store id>` (D45): keyed by the id in the store's
 * meta/v1/store.json, never by its name in config. Its events go under `events/`. Passing anything but a ULID is a bug.
 */
export const eventMirrorDir = (paths: PlainportPaths, storeId: string): string => {
  if (!isUlid(storeId))
    throw new RangeError(`eventMirrorDir: ${JSON.stringify(storeId)} is not a store id (a ULID)`);
  return join(paths.cacheDir, storeId);
};

const keyOf = (log: EventLog, id: string): string => `${log.prefix}${id}.json`;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
/** An event's plain line, as a plain store and every mirror hold it. */
export const encodeEvent = encodePlain;

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Writes one event, create-only where the store allows. The same event again is a no-op; another under its id fails. */
export const appendEvent = async (log: EventLog, event: CatalogEvent): Promise<Result<void>> => {
  const checked = CatalogEventSchema.safeParse(event);
  if (!checked.success) {
    return fail(
      finding("contract.invalid", {
        message: `a ${String(event.type)} catalog event does not match its schema: ${describeIssues(checked.error)}; nothing was written`,
        fix: "this is a bug in the command that wrote the event; report it with the message above",
      }),
    );
  }
  if (checked.data.type === "onloaded" && checked.data.over === undefined) {
    return fail(
      finding("contract.invalid", {
        message:
          "a new onloaded event must name the head it was written over (over, D43); nothing was written",
        fix: "this is a bug in the command that wrote the event; report it with the message above",
      }),
    );
  }
  const entries = storedCount(checked.data);
  if (entries !== undefined && entries !== 1) {
    return fail(
      finding("contract.invalid", {
        message: `a new ${checked.data.type} event must name its snapshot's location in exactly one store, the one it is appended to (Q11), not ${entries}; nothing was written`,
        fix: "this is a bug in the command that wrote the event; report it with the message above",
      }),
    );
  }
  const key = keyOf(log, checked.data.id);
  const encoded = encode(checked.data, log.policy);
  if (!encoded.ok) return encoded;
  const data = encoded.value;
  const createOnly = log.store.capabilities().createIfAbsent;
  const put = await log.store.put(key, data, createOnly ? { ifNotExists: true } : {});
  if (put.ok) return ok(undefined);
  if (put.finding.code !== "store.key-exists") return put;
  const existing = await log.store.get(key);
  if (!existing.ok) return existing;
  if (existing.value === null) return put;
  // The same event, opened: a retry whose first write landed (a sealed one under another nonce, R2-8).
  const same = await sameEvent(key, log.policy)(existing.value, data);
  if (same.ok && same.value) return ok(undefined);
  // A store without hard links creates the key in place (D41), so a crash mid-write can leave a strict prefix of
  // these very bytes. Only this event's own writer makes that prefix; completing it overwrites nothing of anyone's.
  if (
    existing.value.length < data.length &&
    sameBytes(existing.value, data.subarray(0, existing.value.length))
  ) {
    const completed = await log.store.put(key, data);
    return completed.ok ? ok(undefined) : completed;
  }
  return same.ok ? put : same;
};

const skipped = skippedEvent;

/**
 * The resolved events the fold skipped as invalid (Q18): left out like any event this version cannot use, so they
 * taint the read (uncertainEvents) where they could have mattered.
 */
const invalidResolutions = (log: EventLog, state: CatalogState): Finding[] =>
  Object.values(state.projects)
    .flatMap((project) => project.invalid)
    .sort(compare)
    .map((id) =>
      skipped(
        keyOf(log, id),
        "resolution-invalid: a resolved event with an empty over, a keep in its over, a reference to another project or to the wrong kind of event, or a supersedes that loops",
      ),
    );

/** The event in one file of the log, or why it is left out (the codec's reason). */
const parseEvent = (log: EventLog, key: string, bytes: Uint8Array) => decode(bytes, key, log.policy);

interface Listed {
  /** Every entry under the prefix, sorted by key. */
  entries: BlobEntry[];
  /** Key → event id, for entries named `<ulid>.json`. */
  ids: Map<string, string>;
}

/** The log's listing. Anything in the folder not named `<ulid>.json` is reported when read, never read. */
const listEvents = async (log: EventLog): Promise<Result<Listed>> => {
  const listing = await log.store.list(log.prefix);
  if (!listing.ok) return listing;
  const ids = new Map<string, string>();
  for (const { key } of listing.value) {
    const name = key.slice(log.prefix.length);
    if (name.endsWith(".json") && isUlid(name.slice(0, -5))) ids.set(key, name.slice(0, -5));
  }
  return ok({ entries: listing.value, ids });
};

/**
 * The event stored under one id: null when there is none, or the catalog.event-skipped finding when the bytes there
 * are no whole event (a torn write on a store without hard links, D42, or a damaged file).
 */
export const eventAt = async (
  log: EventLog,
  id: string,
): Promise<Result<{ event: CatalogEvent } | { skipped: Finding } | null>> => {
  const key = keyOf(log, id);
  const bytes = await log.store.get(key);
  if (!bytes.ok) return bytes;
  if (bytes.value === null) return ok(null);
  const parsed = parseEvent(log, key, bytes.value);
  return ok("skip" in parsed ? { skipped: parsed.skip.finding } : { event: parsed.event });
};

/**
 * Whether the store holds this operation's own event under `id` (`ours` decides what that means): "absent" when
 * nothing is there, "ours" only when the file parses, validates and passes `ours`, else the catalog.event-skipped
 * finding that says why it is not. A torn write (D41, D42) or another event is never taken for a record; recovery uses
 * this for every event it relies on. A failure when the store cannot say.
 */
export const eventForOp = async (
  log: EventLog,
  id: string,
  ours: (event: CatalogEvent) => boolean,
): Promise<Result<"absent" | "ours" | Finding>> => {
  const found = await eventAt(log, id);
  if (!found.ok) return found;
  if (found.value === null) return ok("absent");
  if ("skipped" in found.value) return ok(found.value.skipped);
  if (ours(found.value.event)) return ok("ours");
  return ok(skipped(keyOf(log, id), "it is another operation's event, not the one this journal names"));
};

export interface EventsRead {
  /** Every usable event, sorted by id. */
  events: CatalogEvent[];
  /** One catalog.event-skipped per file left out, sorted by key. */
  findings: Finding[];
  /** The stored-multiple events among them (Q11). */
  tainted: Tainted[];
}

const readListed = async (log: EventLog, listed: Listed): Promise<Result<EventsRead>> => {
  const events: CatalogEvent[] = [];
  const findings: Finding[] = [];
  const tainted: Tainted[] = [];
  for (const { key } of listed.entries) {
    const id = listed.ids.get(key);
    if (id === undefined) {
      findings.push(skipped(key, "its name is not <ulid>.json"));
      continue;
    }
    const bytes = await log.store.get(key);
    if (!bytes.ok) return bytes;
    if (bytes.value === null) continue; // removed since the listing (a store's own cleanup); nothing to fold
    const parsed = parseEvent(log, key, bytes.value);
    if ("skip" in parsed) {
      findings.push(parsed.skip.finding);
      if (parsed.skip.taint !== undefined) tainted.push(parsed.skip.taint);
    } else events.push(parsed.event);
  }
  events.sort((a, b) => compare(a.id, b.id));
  return ok({ events, findings, tainted });
};

/** Every event in the log. A store that cannot be listed or read is a failure, never an empty catalog. */
export const readEvents = async (log: EventLog): Promise<Result<EventsRead>> => {
  const listed = await listEvents(log);
  if (!listed.ok) return listed;
  return readListed(log, listed.value);
};

/** Event id → size, from a listing. */
const sizesById = (listed: Listed): Map<string, number> => {
  const sizes = new Map<string, number>();
  for (const { key, size } of listed.entries) {
    const id = listed.ids.get(key);
    if (id !== undefined) sizes.set(id, size);
  }
  return sizes;
};

export const MirrorFileSchema = z
  .strictObject({
    v: z.literal(1),
    /** The id of the store mirrored (its meta/v1/store.json). */
    store: UlidSchema,
    /** The FOLD_VERSION of the reader that wrote `skipped`: another reader starts the list afresh (I7). */
    fold: z.int().positive(),
    lastSyncedAt: z.iso.datetime(),
    /** Store files whose bytes are no event (torn, not JSON), by event id: not fetched again while their size is the
     * same and the reader is the same version, and reported each time. A file this version cannot use although it is
     * JSON (a type or schema it does not know) is never listed here: it is read again on every sync. */
    skipped: z.record(z.string(), z.strictObject({ size: z.int().nonnegative(), finding: FindingSchema })),
    /** The size of the store file each mirrored event was opened from, by event id: the mirror holds opened bytes,
     * so a sealed store's files differ in size from their copies. A file is fetched again when its size on the store
     * is not this one, and the fold cache's digest is taken over these sizes. Recorded only where it differs from the
     * copy's size, and absent when none does (an M1 or plain store's mirror): there the copy's size stands in. */
    transport: z.record(z.string(), z.int().nonnegative()).optional(),
  })
  .meta({ title: "EventMirror", description: "mirror.json beside a store's local event mirror" });
export type MirrorFile = z.infer<typeof MirrorFileSchema>;

/** A cached fold: reused only when it was built by this FOLD_VERSION from exactly the events listed now. */
export const StateCacheSchema = z
  .strictObject({
    v: z.literal(1),
    /** The FOLD_VERSION that built it. */
    fold: z.int().positive(),
    /** sha256 over the sorted `<name>\0<size>` of every file listed under the mirror's events/ (D43), each event's
     * size being its store file's (mirror.json's transport) where recorded. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    count: z.int().nonnegative(),
    state: CatalogStateSchema,
    /** The catalog.event-skipped findings of the read that built it. */
    findings: z.array(FindingSchema),
  })
  .meta({
    title: "CatalogStateCache",
    description: "state.json beside a store's local event mirror: a rebuildable cache of the catalog fold",
  });
export type StateCache = z.infer<typeof StateCacheSchema>;

/**
 * Names and sizes, an event's size being its store file's where the mirror recorded it: a torn event completed under
 * its own name (D42), or any store file that changes size, changes the digest too.
 */
const digestOf = (log: EventLog, listed: Listed, transport: Readonly<Record<string, number>>): string =>
  createHash("sha256")
    .update(
      listed.entries
        .map((entry) => {
          const id = listed.ids.get(entry.key);
          const size = (id === undefined ? undefined : transport[id]) ?? entry.size;
          return `${entry.key.slice(log.prefix.length)}\0${size}`;
        })
        .join("\n"),
    )
    .digest("hex");

/** A JSON document a schema checks; undefined when missing, damaged or of another shape. */
const readJson = async <S extends z.ZodType>(
  store: BlobStore,
  key: string,
  schema: S,
): Promise<Result<z.output<S> | undefined>> => {
  const bytes = await store.get(key);
  if (!bytes.ok) return bytes;
  if (bytes.value === null) return ok(undefined);
  try {
    const checked = schema.safeParse(JSON.parse(decoder.decode(bytes.value)));
    return ok(checked.success ? checked.data : undefined);
  } catch {
    return ok(undefined); // not JSON: a cache is never trusted, only rebuilt
  }
};

/**
 * The ids of event files left out of the fold (any of the codec's skip findings on a `<ulid>.json`), sorted: torn,
 * damaged, of a type or schema this version does not know, plaintext on a sealed store, or not opening. Any of them may change a project's state, so the fold without them is
 * not known to be whole (D86). A file not named as an event is no event, and leaves the fold certain.
 */
export const uncertainEvents = (findings: readonly Finding[]): string[] => {
  const ids = new Set<string>();
  for (const f of findings) {
    if (!SKIP_CODES.includes(f.code)) continue;
    for (const path of f.paths ?? []) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (name.endsWith(".json") && isUlid(name.slice(0, -5))) ids.add(name.slice(0, -5));
    }
  }
  return [...ids].sort(compare);
};

export interface LoadedCatalog {
  state: CatalogState;
  /** catalog.event-skipped for every file left out, on the store or in the mirror. */
  findings: Finding[];
  /** uncertainEvents(findings): events left out that may change state (D86). */
  uncertain: string[];
  /** The stored-multiple events left out, read from the store just now (Q11); none from the mirror alone. */
  tainted: Tainted[];
  /** Whether a cached fold was reused. */
  cached: boolean;
  /** True when the store could not be reached: the state is the mirror's, as of syncedAt. */
  stale: boolean;
  source: "store" | "mirror";
  /** When the state was last brought up to date with the store; absent when this device never synced it. */
  syncedAt?: string;
  /** Events this read copied from the store into the mirror. */
  copied: number;
  /** Why the state is stale: the finding that kept the store from being asked (one of OFFLINE_CODES). */
  unreachable?: Finding;
  /** The store's format (its meta/v1/store.json), when the store answered: what a writer keys `stored` by (Q11). */
  format?: 1 | 2;
  /** Why the mirror was not used although the store was reachable; the state was read from the store directly. */
  mirrorFailure?: Finding;
}

/** Folds the mirror's listing, through the cache beside it. Cache writes are best effort. */
const foldMirror = async (
  mirror: EventLog,
  listed: Listed,
  transport: Readonly<Record<string, number>>,
): Promise<Result<{ state: CatalogState; findings: Finding[]; cached: boolean }>> => {
  const digest = digestOf(mirror, listed, transport);
  const count = listed.entries.length;
  const cache = await readJson(mirror.store, MIRROR_STATE_KEY, StateCacheSchema);
  if (!cache.ok) return cache;
  const hit = cache.value;
  if (hit !== undefined && hit.fold === FOLD_VERSION && hit.digest === digest && hit.count === count) {
    return ok({ state: hit.state, findings: hit.findings, cached: true });
  }
  const read = await readListed(mirror, listed);
  if (!read.ok) return read;
  const state = foldCatalog(read.value.events);
  const findings = [...read.value.findings, ...invalidResolutions(mirror, state)];
  const next: StateCache = { v: 1, fold: FOLD_VERSION, digest, count, state, findings };
  await mirror.store.put(MIRROR_STATE_KEY, encoder.encode(`${JSON.stringify(next)}\n`));
  return ok({ state, findings, cached: false });
};

/** Which side failed: a store failure decides the outcome, a mirror failure only sends the read to the store. */
type Fault = { ok: false; side: "store" | "mirror"; failure: Failure };
const storeFault = (failure: Failure): Fault => ({ ok: false, side: "store", failure });
const mirrorFault = (failure: Failure): Fault => ({ ok: false, side: "mirror", failure });

/**
 * Opens one store file through the codec and copies the opened event into the mirror, so it is never fetched again
 * while the store file keeps its size. A plain store's copy is its bytes as they are; a torn mirror copy (a prefix of
 * the opened bytes) is completed (D42). The sizes of the store file and of the copy, or why the file was left out.
 */
const download = async (
  remote: EventLog,
  mirror: EventLog,
  id: string,
): Promise<{ ok: true; value: { transport: number; opened: number } | Skip | undefined } | Fault> => {
  const key = keyOf(remote, id);
  const bytes = await remote.store.get(key);
  if (!bytes.ok) return storeFault(bytes);
  if (bytes.value === null) return ok(undefined);
  const parsed = parseEvent(remote, key, bytes.value);
  if ("skip" in parsed) return ok(parsed.skip);
  const opened = parsed.opened;
  const sizes = { transport: bytes.value.length, opened: opened.length };
  const target = keyOf(mirror, id);
  const createOnly = mirror.store.capabilities().createIfAbsent;
  const put = await mirror.store.put(target, opened, createOnly ? { ifNotExists: true } : {});
  if (put.ok) return ok(sizes);
  if (put.finding.code !== "store.key-exists") return mirrorFault(put);
  const held = await mirror.store.get(target);
  if (!held.ok) return mirrorFault(held);
  const mine = held.value;
  if (mine !== null && mine.length < opened.length && sameBytes(mine, opened.subarray(0, mine.length))) {
    const completed = await mirror.store.put(target, opened);
    return completed.ok ? ok(sizes) : mirrorFault(completed);
  }
  if (mine !== null && sameBytes(mine, opened)) return ok(sizes);
  return ok({
    reason: "mirror-clash",
    finding: skipped(
      key,
      `the mirror holds other bytes under its name (${target}); both are kept as they are`,
    ),
    bytes: false,
  });
};

/**
 * Brings the mirror up to the store: one listing of each, fetching only files the mirror does not hold under the same
 * name and size and that this version of the reader has not already found to be no event at that size (I7: a list an
 * older or newer reader made is started afresh, and JSON this version cannot use is never on it). It only downloads:
 * a read never writes to a store (D45). Returns the mirror's listing as it stands afterwards.
 */
const syncDown = async (
  remote: EventLog,
  mirror: EventLog,
  storeId: string,
  now: Date,
): Promise<
  | {
      ok: true;
      value: {
        listed: Listed;
        transport: Record<string, number>;
        copied: number;
        findings: Finding[];
        tainted: Tainted[];
      };
    }
  | Fault
> => {
  const theirs = await listEvents(remote);
  if (!theirs.ok) return storeFault(theirs);
  const recorded = await readJson(mirror.store, MIRROR_FILE_KEY, MirrorFileSchema);
  if (!recorded.ok) return mirrorFault(recorded);
  if (recorded.value !== undefined && recorded.value.store !== storeId) {
    return mirrorFault(identityChanged(storeId, recorded.value.store, "local event mirror"));
  }
  const mine = await listEvents(mirror);
  if (!mine.ok) return mirrorFault(mine);
  const known = recorded.value?.fold === FOLD_VERSION ? recorded.value.skipped : {};
  const transportBefore = recorded.value?.transport ?? {};
  const mirrorSizes = sizesById(mine.value);
  const skippedNow: MirrorFile["skipped"] = {};
  const transport: Record<string, number> = {};
  const findings: Finding[] = [];
  const tainted: Tainted[] = [];
  let copied = 0;
  for (const [id, size] of [...sizesById(theirs.value)].sort(([a], [b]) => compare(a, b))) {
    // Held, and opened from a store file of this size (an M1 mirror records none: its copy's size is the file's).
    if (mirrorSizes.has(id) && (transportBefore[id] ?? mirrorSizes.get(id)) === size) {
      if (size !== mirrorSizes.get(id)) transport[id] = size;
      continue;
    }
    const before = known[id];
    if (before !== undefined && before.size === size) {
      skippedNow[id] = before;
      findings.push(before.finding);
      continue;
    }
    const result = await download(remote, mirror, id);
    if (!result.ok) return result;
    if (result.value === undefined) continue;
    if ("transport" in result.value) {
      mirrorSizes.set(id, result.value.opened);
      if (result.value.transport !== result.value.opened) transport[id] = result.value.transport;
      copied++;
    } else {
      if (result.value.bytes) skippedNow[id] = { size, finding: result.value.finding };
      findings.push(result.value.finding);
      if (result.value.taint !== undefined) tainted.push(result.value.taint);
    }
  }
  const file: MirrorFile = {
    v: 1,
    store: storeId,
    fold: FOLD_VERSION,
    lastSyncedAt: now.toISOString(),
    skipped: skippedNow,
    // Only sizes that differ from the copy's (a sealed store's): a plain store's file keeps v0.1.1's strict shape.
    ...(Object.keys(transport).length === 0 ? {} : { transport }),
  };
  const written = await mirror.store.put(MIRROR_FILE_KEY, encoder.encode(`${JSON.stringify(file)}\n`));
  if (!written.ok) return mirrorFault(written);
  const entries = new Map(mine.value.entries.map((entry) => [entry.key, entry]));
  const ids = new Map(mine.value.ids);
  for (const [id, size] of mirrorSizes) {
    const key = keyOf(mirror, id);
    entries.set(key, { key, size });
    ids.set(key, id);
  }
  const listed = { entries: [...entries.values()].sort((a, b) => compare(a.key, b.key)), ids };
  return ok({ listed, transport, copied, findings, tainted });
};

/** Why a store could not be asked at all, as a finding code: the mirror then stands in for it (Task 13). */
export const OFFLINE_CODES: readonly string[] = [
  "store.unreachable",
  "store.secret-missing",
  "store.seal-key-unavailable",
];

/** The mirror alone, while the store cannot be asked (`unreachable` says why): its state as of its last sync, marked stale. */
const readOffline = async (
  mirror: EventLog,
  storeId: string,
  unreachable: Finding,
): Promise<Result<LoadedCatalog>> => {
  const recorded = await readJson(mirror.store, MIRROR_FILE_KEY, MirrorFileSchema);
  if (!recorded.ok) return recorded;
  if (recorded.value !== undefined && recorded.value.store !== storeId) {
    return identityChanged(storeId, recorded.value.store, "local event mirror");
  }
  const listed = await listEvents(mirror);
  if (!listed.ok) return listed;
  const folded = await foldMirror(mirror, listed.value, recorded.value?.transport ?? {});
  if (!folded.ok) return folded;
  const skippedOnStore = Object.values(recorded.value?.skipped ?? {}).map((entry) => entry.finding);
  const findings = [...skippedOnStore, ...folded.value.findings];
  return ok({
    ...folded.value,
    findings,
    uncertain: uncertainEvents(findings),
    tainted: [],
    stale: true,
    source: "mirror",
    ...(recorded.value && { syncedAt: recorded.value.lastSyncedAt }),
    copied: 0,
    unreachable,
  });
};

/**
 * The mirror alone, without asking the store: for a view whose store could not be opened (a secret, the seal key or the
 * network failed). Opens by the pinned store id first (Task 13): a mirror recorded for another store is refused.
 */
export const readMirrorCatalog = (options: {
  mirror: BlobStore;
  storeId: string;
  reason: Finding;
}): Promise<Result<LoadedCatalog>> =>
  readOffline(mirrorEventLog(options.mirror), options.storeId, options.reason);

/**
 * The catalog, the one way to read it (D43, D45). It checks the store's identity against `storeId` (what this device
 * recorded for the store: store.identity-changed when it differs), brings this device's mirror up to the store
 * (download only: a read never writes to a store), and folds the mirror's events through the cache beside them.
 *
 * - The store unreachable: the mirror's state, marked stale, with the time of its last sync (none if never synced).
 * - The mirror broken (cannot be listed, read or written, or recorded for another store) while the store is
 *   reachable: the store's events are read and folded directly, with the reason in mirrorFailure.
 * - Any other store failure fails the call.
 *
 * The store's events are opened under `policy` (plain when absent); the mirror holds them opened.
 */
export const loadCatalog = async (options: {
  store: BlobStore;
  mirror: BlobStore;
  storeId: string;
  now: Date;
  policy?: CatalogPolicy;
}): Promise<Result<LoadedCatalog>> => {
  const remote = storeEventLog(options.store, options.policy);
  const mirror = mirrorEventLog(options.mirror);
  const offline = (failure: Failure): Promise<Result<LoadedCatalog>> | Failure =>
    OFFLINE_CODES.includes(failure.finding.code)
      ? readOffline(mirror, options.storeId, failure.finding)
      : failure;

  const identity = await readUsableStore(options.store);
  if (!identity.ok) return offline(identity);
  const found = identity.value?.id ?? null;
  if (identity.value === null || found !== options.storeId)
    return identityChanged(options.storeId, found, "store");
  const { format } = identity.value;
  const fits = policyFits(options.policy ?? PLAIN_CATALOG, identity.value);
  if (!fits.ok) return fits;

  const synced = await syncDown(remote, mirror, options.storeId, options.now);
  let mirrorFailure: Finding | undefined;
  if (synced.ok) {
    const folded = await foldMirror(mirror, synced.value.listed, synced.value.transport);
    if (folded.ok) {
      const findings = [...synced.value.findings, ...folded.value.findings];
      return ok({
        ...folded.value,
        findings,
        uncertain: uncertainEvents(findings),
        tainted: synced.value.tainted,
        stale: false,
        format,
        source: "store",
        syncedAt: options.now.toISOString(),
        copied: synced.value.copied,
      });
    }
    mirrorFailure = folded.finding;
  } else if (synced.side === "store") {
    return offline(synced.failure);
  } else {
    mirrorFailure = synced.failure.finding;
  }
  // The mirror is only a cache: read the store directly.
  const direct = await readEvents(remote);
  if (!direct.ok) return offline(direct);
  const state = foldCatalog(direct.value.events);
  const findings = [...direct.value.findings, ...invalidResolutions(remote, state)];
  return ok({
    state,
    findings,
    uncertain: uncertainEvents(findings),
    tainted: direct.value.tainted,
    cached: false,
    stale: false,
    format,
    source: "store",
    syncedAt: options.now.toISOString(),
    copied: 0,
    mirrorFailure,
  });
};
