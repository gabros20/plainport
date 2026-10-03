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
import { isUlid } from "../ulid.ts";
import { CATALOG_EVENT_TYPES, type CatalogEvent, CatalogEventSchema } from "./events.ts";
import { type CatalogState, CatalogStateSchema, compare, FOLD_VERSION, foldCatalog } from "./fold.ts";

/** Where events live on a store, and in a local mirror. */
export const STORE_EVENTS_PREFIX = "meta/v1/events/";
export const MIRROR_EVENTS_PREFIX = "events/";
export const STATE_KEY = "meta/v1/state.json";
/** The fold cached beside a mirror's events. */
export const MIRROR_STATE_KEY = "state.json";

/** A folder of event files: a BlobStore and the prefix the events sit under. */
export interface EventLog {
  store: BlobStore;
  prefix: string;
}

export const storeEventLog = (store: BlobStore): EventLog => ({ store, prefix: STORE_EVENTS_PREFIX });
export const mirrorEventLog = (store: BlobStore): EventLog => ({ store, prefix: MIRROR_EVENTS_PREFIX });

/**
 * The root of a store's event mirror, `<cache>/plainport/<store>`; its events go under `events/`. The store's name is
 * config text, so it is percent-encoded into one folder name that never reaches outside the cache.
 */
export const eventMirrorDir = (paths: PlainportPaths, storeName: string): string => {
  const encoded = encodeURIComponent(storeName);
  return join(paths.cacheDir, /^\.+$/.test(encoded) ? "%2E".repeat(encoded.length) : encoded);
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

const parseEvent = (key: string, id: string, bytes: Uint8Array): CatalogEvent | Finding => {
  let data: unknown;
  try {
    data = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    return skipped(key, `it is not JSON (${(error as Error).message})`);
  }
  const type = typeof data === "object" && data !== null && "type" in data ? data.type : undefined;
  if (typeof type === "string" && !(CATALOG_EVENT_TYPES as readonly string[]).includes(type)) {
    return skipped(key, `this version of plainport does not know the event type ${JSON.stringify(type)}`);
  }
  const checked = CatalogEventSchema.safeParse(data);
  if (!checked.success)
    return skipped(key, `it does not match the event schema: ${describeIssues(checked.error)}`);
  if (checked.data.id !== id)
    return skipped(key, `its id is ${checked.data.id}, not the ${id} its name says`);
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
    if ("code" in parsed) findings.push(parsed);
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

/**
 * Copies one event from one log to the other, if it reads as a whole event. Returns the bytes written, or a
 * catalog.event-skipped finding when the source holds something else (torn, foreign) or the target already holds a
 * different event under the id. appendEvent keeps it create-only and completes the target's own torn copy (D42).
 */
const copyEvent = async (
  from: EventLog,
  to: EventLog,
  id: string,
): Promise<
  | { ok: true; value: { size: number } | Finding | undefined }
  | { ok: false; at: "from" | "to"; failure: Failure }
> => {
  const key = keyOf(from, id);
  const bytes = await from.store.get(key);
  if (!bytes.ok) return { ok: false, at: "from", failure: bytes };
  if (bytes.value === null) return ok(undefined);
  const parsed = parseEvent(key, id, bytes.value);
  if ("code" in parsed) return ok(parsed);
  const written = await appendEvent(to, parsed);
  if (written.ok) return ok({ size: encodeEvent(parsed).length });
  if (written.finding.code === "store.key-exists") {
    return ok(
      skipped(keyOf(to, id), `it differs from the copy in the other log (${key}); both are kept as they are`),
    );
  }
  return { ok: false, at: "to", failure: written };
};

export interface Synced {
  /** Events copied from the store into the mirror. */
  copied: number;
  /** Events the mirror held that the store lacked, uploaded to it. */
  uploaded: number;
  /** Events that could not be copied either way. */
  findings: Finding[];
}

type SyncFailure = { ok: false; side: "store" | "mirror"; failure: Failure };

/** One sync, and the mirror's listing as it stands afterwards; a failure says which side failed. */
const syncLogs = async (
  remote: EventLog,
  mirror: EventLog,
): Promise<{ ok: true; value: Synced & { mirrored: Listed } } | SyncFailure> => {
  const theirs = await listEvents(remote);
  if (!theirs.ok) return { ok: false, side: "store", failure: theirs };
  const mine = await listEvents(mirror);
  if (!mine.ok) return { ok: false, side: "mirror", failure: mine };
  const remoteSizes = sizesById(theirs.value);
  const mirrorSizes = sizesById(mine.value);
  const findings: Finding[] = [];
  let copied = 0;
  let uploaded = 0;
  for (const [id, size] of [...remoteSizes].sort(([a], [b]) => compare(a, b))) {
    // Held under the same name and size: never fetched again. A different size is a torn copy on one side.
    if (mirrorSizes.get(id) === size) continue;
    const result = await copyEvent(remote, mirror, id);
    if (!result.ok)
      return { ok: false, side: result.at === "from" ? "store" : "mirror", failure: result.failure };
    if (result.value === undefined) continue;
    if ("code" in result.value) findings.push(result.value);
    else {
      mirrorSizes.set(id, result.value.size);
      copied++;
    }
  }
  for (const id of [...mirrorSizes.keys()].sort(compare)) {
    if (remoteSizes.has(id)) continue;
    const result = await copyEvent(mirror, remote, id);
    if (!result.ok)
      return { ok: false, side: result.at === "from" ? "mirror" : "store", failure: result.failure };
    // A mirror file that does not read as an event is reported by the mirror's own read; not twice.
    if (result.value !== undefined && !("code" in result.value)) uploaded++;
  }
  // The mirror's listing now: what it held, with what was copied in.
  const entries = new Map(mine.value.entries.map((entry) => [entry.key, entry]));
  const ids = new Map(mine.value.ids);
  for (const [id, size] of mirrorSizes) {
    const key = keyOf(mirror, id);
    entries.set(key, { key, size });
    ids.set(key, id);
  }
  const mirrored = { entries: [...entries.values()].sort((a, b) => compare(a.key, b.key)), ids };
  return ok({ copied, uploaded, findings, mirrored });
};

/**
 * Brings a store and its local mirror to the union of their events (replication is a union), with one listing of
 * each: only events the mirror does not hold under the same name and size are fetched, and only events the store
 * lacks are uploaded. When the store cannot be listed this fails and the mirror is left as it was.
 */
export const syncMirror = async (remote: EventLog, mirror: EventLog): Promise<Result<Synced>> => {
  const synced = await syncLogs(remote, mirror);
  if (!synced.ok) return synced.failure;
  const { copied, uploaded, findings } = synced.value;
  return ok({ copied, uploaded, findings });
};

/** A cached fold: reused only when it was built by this FOLD_VERSION from exactly the events listed now. */
export const StateCacheSchema = z
  .strictObject({
    v: z.literal(1),
    /** The FOLD_VERSION that built it. */
    fold: z.int().positive(),
    /** sha256 over the sorted `<key>\0<size>` of every file listed under the events prefix (D43). */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    count: z.int().nonnegative(),
    state: CatalogStateSchema,
    /** The catalog.event-skipped findings of the read that built it. */
    findings: z.array(FindingSchema),
  })
  .meta({
    title: "CatalogStateCache",
    description: "state.json beside a store's or a mirror's events: a rebuildable cache of the catalog fold",
  });
export type StateCache = z.infer<typeof StateCacheSchema>;

/** Names and sizes: a torn event completed under its own name (D42) changes its size, so the digest too. */
const digestOf = (log: EventLog, entries: BlobEntry[]): string =>
  createHash("sha256")
    .update(entries.map((entry) => `${entry.key.slice(log.prefix.length)}\0${entry.size}`).join("\n"))
    .digest("hex");

const readCache = async (store: BlobStore, key: string): Promise<StateCache | undefined> => {
  const bytes = await store.get(key);
  if (!bytes.ok || bytes.value === null) return undefined;
  try {
    const checked = StateCacheSchema.safeParse(JSON.parse(decoder.decode(bytes.value)));
    return checked.success ? checked.data : undefined;
  } catch {
    return undefined; // not JSON: a cache is never trusted, only rebuilt
  }
};

export interface LoadedCatalog {
  state: CatalogState;
  /** catalog.event-skipped for every file left out, and any event the sync could not copy. */
  findings: Finding[];
  /** Whether a cached fold was reused. */
  cached: boolean;
  /** True when the store could not be reached: the state is the mirror's, as of its last sync. */
  stale: boolean;
  source: "store" | "mirror";
  /** Why the state is stale: the store's store.unreachable finding. */
  unreachable?: Finding;
}

/**
 * The catalog, the one way to read it (D43): syncs the store and this machine's mirror, folds the union and returns
 * it. When the store is unreachable, the mirror's state is returned marked stale. The fold is cached beside the
 * mirror (and, best effort, on the store as meta/v1/state.json) and reused only when it was built by this FOLD_VERSION
 * from the same event names and sizes. A store that fails for another reason, or a mirror that cannot be read, fails.
 */
export const loadCatalog = async (stores: {
  store: BlobStore;
  mirror: BlobStore;
}): Promise<Result<LoadedCatalog>> => {
  const remote = storeEventLog(stores.store);
  const mirror = mirrorEventLog(stores.mirror);
  const synced = await syncLogs(remote, mirror);
  let listed: Listed;
  let unreachable: Finding | undefined;
  let syncFindings: Finding[] = [];
  if (synced.ok) {
    listed = synced.value.mirrored;
    syncFindings = synced.value.findings;
  } else if (synced.side === "store" && synced.failure.finding.code === "store.unreachable") {
    unreachable = synced.failure.finding;
    const own = await listEvents(mirror);
    if (!own.ok) return own;
    listed = own.value;
  } else {
    return synced.failure;
  }
  const stale = unreachable !== undefined;
  const status = {
    stale,
    source: stale ? ("mirror" as const) : ("store" as const),
    ...(unreachable && { unreachable }),
  };

  const digest = digestOf(mirror, listed.entries);
  const count = listed.entries.length;
  const cache = await readCache(stores.mirror, MIRROR_STATE_KEY);
  if (
    cache !== undefined &&
    cache.fold === FOLD_VERSION &&
    cache.digest === digest &&
    cache.count === count
  ) {
    return ok({
      state: cache.state,
      findings: [...syncFindings, ...cache.findings],
      cached: true,
      ...status,
    });
  }
  const read = await readListed(mirror, listed);
  if (!read.ok) return read;
  const state = foldCatalog(read.value.events);
  const next: StateCache = { v: 1, fold: FOLD_VERSION, digest, count, state, findings: read.value.findings };
  const bytes = encoder.encode(`${JSON.stringify(next)}\n`);
  // Caches only: a failed write is ignored, and the next read folds again.
  await stores.mirror.put(MIRROR_STATE_KEY, bytes);
  if (!stale) await stores.store.put(STATE_KEY, bytes);
  return ok({ state, findings: [...syncFindings, ...read.value.findings], cached: false, ...status });
};
