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
import { type Finding, FindingSchema, fail, finding, ok, type Result } from "@plainport/contract";
import { z } from "zod";
import { describeIssues } from "../config/toml.ts";
import type { PlainportPaths } from "../paths.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import { isUlid } from "../ulid.ts";
import { CATALOG_EVENT_TYPES, type CatalogEvent, CatalogEventSchema } from "./events.ts";
import { type CatalogState, CatalogStateSchema, foldCatalog } from "./fold.ts";

/** Where events live on a store, and in a local mirror. */
export const STORE_EVENTS_PREFIX = "meta/v1/events/";
export const MIRROR_EVENTS_PREFIX = "events/";
export const STATE_KEY = "meta/v1/state.json";

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

/** Event ids from a listing: `<prefix><ulid>.json`. Anything else in the folder is reported, not read. */
const listEvents = async (log: EventLog): Promise<Result<{ keys: string[]; ids: Map<string, string> }>> => {
  const listing = await log.store.list(log.prefix);
  if (!listing.ok) return listing;
  const ids = new Map<string, string>();
  for (const { key } of listing.value) {
    const name = key.slice(log.prefix.length);
    if (name.endsWith(".json") && isUlid(name.slice(0, -5))) ids.set(key, name.slice(0, -5));
  }
  return ok({ keys: listing.value.map((entry) => entry.key), ids });
};

export interface EventsRead {
  /** Every usable event, sorted by id. */
  events: CatalogEvent[];
  /** One catalog.event-skipped per file left out, sorted by key. */
  findings: Finding[];
}

const readListed = async (
  log: EventLog,
  keys: string[],
  ids: Map<string, string>,
): Promise<Result<EventsRead>> => {
  const events: CatalogEvent[] = [];
  const findings: Finding[] = [];
  for (const key of keys) {
    const id = ids.get(key);
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
  events.sort((a, b) => (a.id < b.id ? -1 : 1));
  return ok({ events, findings });
};

/** Every event in the log. A store that cannot be listed or read is a failure, never an empty catalog. */
export const readEvents = async (log: EventLog): Promise<Result<EventsRead>> => {
  const listed = await listEvents(log);
  if (!listed.ok) return listed;
  return readListed(log, listed.value.keys, listed.value.ids);
};

/**
 * Copies the store's events that the mirror lacks into it, and returns the union of both (replication is a union).
 * When the store cannot be read this fails and the mirror is left as it was; readEvents(mirror) still works offline.
 */
export const syncMirror = async (
  remote: EventLog,
  mirror: EventLog,
): Promise<Result<EventsRead & { copied: number }>> => {
  const theirs = await readEvents(remote);
  if (!theirs.ok) return theirs;
  const mine = await readEvents(mirror);
  if (!mine.ok) return mine;
  const have = new Set(mine.value.events.map((e) => e.id));
  let copied = 0;
  for (const event of theirs.value.events) {
    if (have.has(event.id)) continue;
    const written = await appendEvent(mirror, event);
    if (!written.ok) return written;
    copied++;
  }
  const union = new Map<string, CatalogEvent>();
  for (const e of [...mine.value.events, ...theirs.value.events]) union.set(e.id, e);
  return ok({
    events: [...union.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    findings: [...theirs.value.findings, ...mine.value.findings],
    copied,
  });
};

/** state.json: the fold of the events a listing held, reused only while a digest of the listing still matches. */
export const StateCacheSchema = z
  .strictObject({
    v: z.literal(1),
    /** sha256 over the sorted keys under meta/v1/events/; events never change, so the keys identify the set. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    count: z.int().nonnegative(),
    state: CatalogStateSchema,
    /** The catalog.event-skipped findings of the read that built it. */
    findings: z.array(FindingSchema),
  })
  .meta({
    title: "CatalogStateCache",
    description: "meta/v1/state.json: a rebuildable cache of the catalog fold",
  });
export type StateCache = z.infer<typeof StateCacheSchema>;

const digestOf = (keys: string[]): string => createHash("sha256").update(keys.join("\n")).digest("hex");

const readCache = async (store: BlobStore): Promise<StateCache | undefined> => {
  const bytes = await store.get(STATE_KEY);
  if (!bytes.ok || bytes.value === null) return undefined;
  try {
    const checked = StateCacheSchema.safeParse(JSON.parse(decoder.decode(bytes.value)));
    return checked.success ? checked.data : undefined;
  } catch {
    return undefined; // not JSON: a cache is never trusted, only rebuilt
  }
};

export interface LoadedState {
  state: CatalogState;
  findings: Finding[];
  /** Whether state.json was reused. */
  cached: boolean;
}

/**
 * The store's catalog state. state.json is used when it was built from exactly the events listed now; otherwise the
 * events are read and folded, and state.json is rewritten, best effort: it is a cache, so failing to read or write it
 * never fails the call. Listing or reading the events can fail.
 */
export const loadCatalogState = async (store: BlobStore): Promise<Result<LoadedState>> => {
  const log = storeEventLog(store);
  const listed = await listEvents(log);
  if (!listed.ok) return listed;
  const keys = [...listed.value.keys].sort();
  const digest = digestOf(keys);
  const cache = await readCache(store);
  if (cache !== undefined && cache.digest === digest && cache.count === keys.length) {
    return ok({ state: cache.state, findings: cache.findings, cached: true });
  }
  const read = await readListed(log, keys, listed.value.ids);
  if (!read.ok) return read;
  const state = foldCatalog(read.value.events);
  const next: StateCache = { v: 1, digest, count: keys.length, state, findings: read.value.findings };
  await store.put(STATE_KEY, encoder.encode(`${JSON.stringify(next)}\n`));
  return ok({ state, findings: read.value.findings, cached: false });
};
