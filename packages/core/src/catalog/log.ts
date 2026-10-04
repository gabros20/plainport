// Catalog events on a store, and the two things kept beside them (DESIGN.md "Storage → Layout on every store",
// "Local state per machine"):
//
//   <store root>/meta/v1/events/<ulid>.json   the events, written create-only where the store can do it
//   <store root>/meta/v1/state.json           a cache of the fold, rebuilt whenever the events change
//   ~/.cache/plainport/<store>/events/        this machine's mirror of a store's events, so ls works offline
//
// An event file is one line of JSON. Appending the same event twice is a no-op, so a step that is retried after a
// crash (D24) does not fail on its own earlier write. Reading skips what it cannot use, with catalog.event-skipped,
// and never changes or deletes an event file.

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
import { CATALOG_EVENT_TYPES, type CatalogEvent, CatalogEventSchema } from "./events.ts";
import { type CatalogState, CatalogStateSchema, compare, FOLD_VERSION, foldCatalog } from "./fold.ts";
import { identityChanged, readStoreIdentity } from "./identity.ts";

/** Where events live on a store, and in a local mirror. */
export const STORE_EVENTS_PREFIX = "meta/v1/events/";
export const MIRROR_EVENTS_PREFIX = "events/";
/** The store-side fold cache DESIGN's layout allows. Reads never write to a store (D45), so M1 never writes it. */
export const STATE_KEY = "meta/v1/state.json";
/** The fold cached beside a mirror's events. */
export const MIRROR_STATE_KEY = "state.json";
/** Beside a mirror's events: the store it mirrors, its last sync, and store files it could not copy. */
export const MIRROR_FILE_KEY = "mirror.json";

/** A folder of event files: a BlobStore and the prefix the events sit under. */
export interface EventLog {
  store: BlobStore;
  prefix: string;
}

export const storeEventLog = (store: BlobStore): EventLog => ({ store, prefix: STORE_EVENTS_PREFIX });
export const mirrorEventLog = (store: BlobStore): EventLog => ({ store, prefix: MIRROR_EVENTS_PREFIX });

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
export const encodeEvent = (event: CatalogEvent): Uint8Array => encoder.encode(`${JSON.stringify(event)}\n`);

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
  const key = keyOf(log, checked.data.id);
  const data = encodeEvent(checked.data);
  const createOnly = log.store.capabilities().createIfAbsent;
  const put = await log.store.put(key, data, createOnly ? { ifNotExists: true } : {});
  if (put.ok) return ok(undefined);
  if (put.finding.code !== "store.key-exists") return put;
  const existing = await log.store.get(key);
  if (!existing.ok) return existing;
  if (existing.value === null || sameBytes(existing.value, data))
    return existing.value === null ? put : ok(undefined);
  // A store without hard links creates the key in place (D41), so a crash mid-write can leave a strict prefix of
  // these very bytes. Only this event's own writer makes that prefix; completing it overwrites nothing of anyone's.
  if (
    existing.value.length < data.length &&
    sameBytes(existing.value, data.subarray(0, existing.value.length))
  ) {
    const completed = await log.store.put(key, data);
    return completed.ok ? ok(undefined) : completed;
  }
  return put;
};

const skipped = (key: string, reason: string): Finding =>
  finding("catalog.event-skipped", {
    message: `the catalog event ${key} was left out: ${reason}`,
    fix: "nothing to do if a newer plainport wrote it; otherwise keep the file and report it, plainport never changes it",
    paths: [key],
  });

/**
 * A file left out of the fold. `bytes` says whether the bytes themselves are no event (torn, not JSON): only such a
 * file is remembered as skipped by the mirror (I7). JSON that this version cannot use (a type or a schema it does not
 * know, a name that disagrees with the id) is read again on every sync, since a newer plainport may accept it.
 */
interface Skipped {
  finding: Finding;
  bytes: boolean;
}

const parseEvent = (key: string, id: string, bytes: Uint8Array): CatalogEvent | Skipped => {
  let data: unknown;
  try {
    data = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    return { finding: skipped(key, `it is not JSON (${(error as Error).message})`), bytes: true };
  }
  const type = typeof data === "object" && data !== null && "type" in data ? data.type : undefined;
  if (typeof type === "string" && !(CATALOG_EVENT_TYPES as readonly string[]).includes(type)) {
    return {
      finding: skipped(key, `this version of plainport does not know the event type ${JSON.stringify(type)}`),
      bytes: false,
    };
  }
  const checked = CatalogEventSchema.safeParse(data);
  if (!checked.success) {
    return {
      finding: skipped(key, `it does not match the event schema: ${describeIssues(checked.error)}`),
      bytes: false,
    };
  }
  if (checked.data.id !== id) {
    return {
      finding: skipped(key, `its id is ${checked.data.id}, not the ${id} its name says`),
      bytes: false,
    };
  }
  return checked.data;
};

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
  const parsed = parseEvent(key, id, bytes.value);
  return ok("finding" in parsed ? { skipped: parsed.finding } : { event: parsed });
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
}

const readListed = async (log: EventLog, listed: Listed): Promise<Result<EventsRead>> => {
  const events: CatalogEvent[] = [];
  const findings: Finding[] = [];
  for (const { key } of listed.entries) {
    const id = listed.ids.get(key);
    if (id === undefined) {
      findings.push(skipped(key, "its name is not <ulid>.json"));
      continue;
    }
    const bytes = await log.store.get(key);
    if (!bytes.ok) return bytes;
    if (bytes.value === null) continue; // removed since the listing (a store's own cleanup); nothing to fold
    const parsed = parseEvent(key, id, bytes.value);
    if ("finding" in parsed) findings.push(parsed.finding);
    else events.push(parsed);
  }
  events.sort((a, b) => compare(a.id, b.id));
  return ok({ events, findings });
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
  })
  .meta({ title: "EventMirror", description: "mirror.json beside a store's local event mirror" });
export type MirrorFile = z.infer<typeof MirrorFileSchema>;

/** A cached fold: reused only when it was built by this FOLD_VERSION from exactly the events listed now. */
export const StateCacheSchema = z
  .strictObject({
    v: z.literal(1),
    /** The FOLD_VERSION that built it. */
    fold: z.int().positive(),
    /** sha256 over the sorted `<name>\0<size>` of every file listed under the mirror's events/ (D43). */
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

/** Names and sizes: a torn event completed under its own name (D42) changes its size, so the digest too. */
const digestOf = (log: EventLog, entries: BlobEntry[]): string =>
  createHash("sha256")
    .update(entries.map((entry) => `${entry.key.slice(log.prefix.length)}\0${entry.size}`).join("\n"))
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
 * The ids of event files left out of the fold (catalog.event-skipped on a `<ulid>.json`), sorted: torn, damaged or of a
 * type or schema this version does not know. Any of them may change a project's state, so the fold without them is
 * not known to be whole (D86). A file not named as an event is no event, and leaves the fold certain.
 */
export const uncertainEvents = (findings: readonly Finding[]): string[] => {
  const ids = new Set<string>();
  for (const f of findings) {
    if (f.code !== "catalog.event-skipped") continue;
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
  /** Whether a cached fold was reused. */
  cached: boolean;
  /** True when the store could not be reached: the state is the mirror's, as of syncedAt. */
  stale: boolean;
  source: "store" | "mirror";
  /** When the state was last brought up to date with the store; absent when this device never synced it. */
  syncedAt?: string;
  /** Events this read copied from the store into the mirror. */
  copied: number;
  /** Why the state is stale: the store's store.unreachable finding. */
  unreachable?: Finding;
  /** Why the mirror was not used although the store was reachable; the state was read from the store directly. */
  mirrorFailure?: Finding;
}

/** Folds the mirror's listing, through the cache beside it. Cache writes are best effort. */
const foldMirror = async (
  mirror: EventLog,
  listed: Listed,
): Promise<Result<{ state: CatalogState; findings: Finding[]; cached: boolean }>> => {
  const digest = digestOf(mirror, listed.entries);
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
  const next: StateCache = { v: 1, fold: FOLD_VERSION, digest, count, state, findings: read.value.findings };
  await mirror.store.put(MIRROR_STATE_KEY, encoder.encode(`${JSON.stringify(next)}\n`));
  return ok({ state, findings: read.value.findings, cached: false });
};

/** Which side failed: a store failure decides the outcome, a mirror failure only sends the read to the store. */
type Fault = { ok: false; side: "store" | "mirror"; failure: Failure };
const storeFault = (failure: Failure): Fault => ({ ok: false, side: "store", failure });
const mirrorFault = (failure: Failure): Fault => ({ ok: false, side: "mirror", failure });

/**
 * Copies one store file into the mirror byte for byte, if it reads as a whole event, so its name and size match on
 * both sides and it is never fetched again. A torn mirror copy (a prefix of these bytes) is completed (D42).
 */
const download = async (
  remote: EventLog,
  mirror: EventLog,
  id: string,
): Promise<{ ok: true; value: number | Skipped | undefined } | Fault> => {
  const key = keyOf(remote, id);
  const bytes = await remote.store.get(key);
  if (!bytes.ok) return storeFault(bytes);
  if (bytes.value === null) return ok(undefined);
  const parsed = parseEvent(key, id, bytes.value);
  if ("finding" in parsed) return ok(parsed);
  const target = keyOf(mirror, id);
  const createOnly = mirror.store.capabilities().createIfAbsent;
  const put = await mirror.store.put(target, bytes.value, createOnly ? { ifNotExists: true } : {});
  if (put.ok) return ok(bytes.value.length);
  if (put.finding.code !== "store.key-exists") return mirrorFault(put);
  const held = await mirror.store.get(target);
  if (!held.ok) return mirrorFault(held);
  const mine = held.value;
  if (
    mine !== null &&
    mine.length < bytes.value.length &&
    sameBytes(mine, bytes.value.subarray(0, mine.length))
  ) {
    const completed = await mirror.store.put(target, bytes.value);
    return completed.ok ? ok(bytes.value.length) : mirrorFault(completed);
  }
  if (mine !== null && sameBytes(mine, bytes.value)) return ok(bytes.value.length);
  return ok({
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
): Promise<{ ok: true; value: { listed: Listed; copied: number; findings: Finding[] } } | Fault> => {
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
  const mirrorSizes = sizesById(mine.value);
  const skippedNow: MirrorFile["skipped"] = {};
  const findings: Finding[] = [];
  let copied = 0;
  for (const [id, size] of [...sizesById(theirs.value)].sort(([a], [b]) => compare(a, b))) {
    if (mirrorSizes.get(id) === size) continue;
    const before = known[id];
    if (before !== undefined && before.size === size) {
      skippedNow[id] = before;
      findings.push(before.finding);
      continue;
    }
    const result = await download(remote, mirror, id);
    if (!result.ok) return result;
    if (result.value === undefined) continue;
    if (typeof result.value === "number") {
      mirrorSizes.set(id, result.value);
      copied++;
    } else {
      if (result.value.bytes) skippedNow[id] = { size, finding: result.value.finding };
      findings.push(result.value.finding);
    }
  }
  const file: MirrorFile = {
    v: 1,
    store: storeId,
    fold: FOLD_VERSION,
    lastSyncedAt: now.toISOString(),
    skipped: skippedNow,
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
  return ok({ listed, copied, findings });
};

/** The mirror alone, while the store is unreachable: its state as of its last sync, marked stale. */
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
  const folded = await foldMirror(mirror, listed.value);
  if (!folded.ok) return folded;
  const skippedOnStore = Object.values(recorded.value?.skipped ?? {}).map((entry) => entry.finding);
  const findings = [...skippedOnStore, ...folded.value.findings];
  return ok({
    ...folded.value,
    findings,
    uncertain: uncertainEvents(findings),
    stale: true,
    source: "mirror",
    ...(recorded.value && { syncedAt: recorded.value.lastSyncedAt }),
    copied: 0,
    unreachable,
  });
};

/**
 * The catalog, the one way to read it (D43, D45). It checks the store's identity against `storeId` (what this device
 * recorded for the store: store.identity-changed when it differs), brings this device's mirror up to the store
 * (download only: a read never writes to a store), and folds the mirror's events through the cache beside them.
 *
 * - The store unreachable: the mirror's state, marked stale, with the time of its last sync (none if never synced).
 * - The mirror broken (cannot be listed, read or written, or recorded for another store) while the store is
 *   reachable: the store's events are read and folded directly, with the reason in mirrorFailure.
 * - Any other store failure fails the call.
 */
export const loadCatalog = async (options: {
  store: BlobStore;
  mirror: BlobStore;
  storeId: string;
  now: Date;
}): Promise<Result<LoadedCatalog>> => {
  const remote = storeEventLog(options.store);
  const mirror = mirrorEventLog(options.mirror);
  const offline = (failure: Failure): Promise<Result<LoadedCatalog>> | Failure =>
    failure.finding.code === "store.unreachable"
      ? readOffline(mirror, options.storeId, failure.finding)
      : failure;

  const identity = await readStoreIdentity(options.store);
  if (!identity.ok) return offline(identity);
  if (identity.value !== options.storeId) return identityChanged(options.storeId, identity.value, "store");

  const synced = await syncDown(remote, mirror, options.storeId, options.now);
  let mirrorFailure: Finding | undefined;
  if (synced.ok) {
    const folded = await foldMirror(mirror, synced.value.listed);
    if (folded.ok) {
      const findings = [...synced.value.findings, ...folded.value.findings];
      return ok({
        ...folded.value,
        findings,
        uncertain: uncertainEvents(findings),
        stale: false,
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
  return ok({
    state: foldCatalog(direct.value.events),
    findings: direct.value.findings,
    uncertain: uncertainEvents(direct.value.findings),
    cached: false,
    stale: false,
    source: "store",
    syncedAt: options.now.toISOString(),
    copied: 0,
    mirrorFailure,
  });
};
