// The catalog codec: the one place event bytes become events and events become bytes, on every path (live, recovery,
// the mirror, tests). A store's catalog is plain (M1, local stores) or sealed (Catalog seal v1, Q10), by its policy;
// what a store holds is the transport bytes, what the mirror holds is the opened bytes, and the two are never confused.
//
// Decoding never throws and never guesses: bytes that are no usable event come back as a typed skip reason with the
// finding that says why. Every reason feeds D86, since any skipped file may change a project's state. On a sealed
// store a plaintext event is never read (catalog.unsealed-event), and a sealed event that does not open is
// catalog.seal-failed, never taken for an absent or uncommitted one.

import { type Finding, fail, finding, ok, type Result } from "@plainport/contract";
import { describeIssues } from "../config/toml.ts";
import { CATALOG_EVENT_TYPES, type CatalogEvent, CatalogEventSchema } from "./events.ts";
import type { SameEvent } from "./publish.ts";
import { looksSealed, open, seal } from "./seal.ts";

/** Where events live on a store. A sealed event's associated data names its key here. */
export const STORE_EVENTS_PREFIX = "meta/v1/events/";

/** The event key an event is stored under on a store. */
export const storeEventKey = (id: string): string => `${STORE_EVENTS_PREFIX}${id}.json`;

/**
 * How a store's catalog is written and read: plain JSON lines, or sealed under the store's catalog key (32 bytes,
 * derived from the restic master key; Catalog seal v1). Fixed per store at bootstrap; a mirror is always plain.
 */
export type CatalogPolicy = { seal: "plain" } | { seal: "sealed"; storeId: string; key: Uint8Array };

export const PLAIN_CATALOG: CatalogPolicy = Object.freeze({ seal: "plain" });

/** Why a file is no usable event. */
export type SkipReason =
  | "torn"
  | "not-json"
  | "schema"
  | "wrong-id"
  | "unknown-type"
  | "unsealed-event"
  | "seal-failed";

export interface Skip {
  reason: SkipReason;
  /** catalog.event-skipped, catalog.unsealed-event or catalog.seal-failed, naming the file in `paths`. */
  finding: Finding;
  /**
   * Whether the bytes themselves are no event (torn, not JSON): only such a file is remembered as skipped by the
   * mirror (I7). Anything else is read again on every sync, since a newer plainport or the right key may read it.
   */
  bytes: boolean;
}

export type Decoded = { event: CatalogEvent; opened: Uint8Array } | { skip: Skip };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** An event's plain bytes: one line of JSON, in its schema's key order. What a mirror holds. */
export const encodePlain = (event: CatalogEvent): Uint8Array => encoder.encode(`${JSON.stringify(event)}\n`);

/**
 * The transport bytes of an event: its plain line, or on a sealed store that line sealed for its key, as one line.
 * Only a failure to seal (a key of the wrong size) fails.
 */
export const encode = (event: CatalogEvent, policy: CatalogPolicy): Result<Uint8Array> => {
  const plain = encodePlain(event);
  if (policy.seal === "plain") return ok(plain);
  const sealed = seal({
    key: policy.key,
    storeId: policy.storeId,
    eventKey: storeEventKey(event.id),
    plaintext: plain,
  });
  return sealed.ok ? ok(encoder.encode(`${sealed.value}\n`)) : sealed;
};

const skippedFinding = (key: string, reason: string): Finding =>
  finding("catalog.event-skipped", {
    message: `the catalog event ${key} was left out: ${reason}`,
    fix: "nothing to do if a newer plainport wrote it; otherwise keep the file and report it, plainport never changes it",
    paths: [key],
  });

/** catalog.event-skipped for a file left out for a reason of the caller's (a clash in the mirror, a name). */
export const skippedEvent = (key: string, reason: string): Finding => skippedFinding(key, reason);

const skip = (reason: SkipReason, finding: Finding): { skip: Skip } => ({
  skip: { reason, finding, bytes: reason === "torn" || reason === "not-json" },
});

/** The id a key names (`…/<id>.json`). */
const idOfKey = (key: string): string => {
  const name = key.slice(key.lastIndexOf("/") + 1);
  return name.endsWith(".json") ? name.slice(0, -5) : name;
};

/** Text, then JSON: a failure is torn when the bytes do not end their line (a write cut short), else not JSON. */
const parseLine = (key: string, bytes: Uint8Array): { value: unknown } | { skip: Skip } => {
  try {
    return { value: JSON.parse(decoder.decode(bytes)) };
  } catch (error) {
    const whole = bytes.length > 0 && bytes[bytes.length - 1] === 0x0a;
    return whole
      ? skip("not-json", skippedFinding(key, `it is not JSON (${(error as Error).message})`))
      : skip(
          "torn",
          skippedFinding(
            key,
            `it is not JSON, and cut short (a write that did not finish: ${(error as Error).message})`,
          ),
        );
  }
};

/** A plain event's checks: its type known, its schema, its id the one its name says. */
const checkEvent = (key: string, data: unknown, opened: Uint8Array): Decoded => {
  const type = typeof data === "object" && data !== null && "type" in data ? data.type : undefined;
  if (typeof type === "string" && !(CATALOG_EVENT_TYPES as readonly string[]).includes(type)) {
    return skip(
      "unknown-type",
      skippedFinding(key, `this version of plainport does not know the event type ${JSON.stringify(type)}`),
    );
  }
  const checked = CatalogEventSchema.safeParse(data);
  if (!checked.success) {
    return skip(
      "schema",
      skippedFinding(key, `it does not match the event schema: ${describeIssues(checked.error)}`),
    );
  }
  const id = idOfKey(key);
  if (checked.data.id !== id) {
    return skip("wrong-id", skippedFinding(key, `its id is ${checked.data.id}, not the ${id} its name says`));
  }
  return { event: checked.data, opened };
};

/**
 * The event in the bytes stored at `key` (a store's `meta/v1/events/<id>.json`, or a mirror's `events/<id>.json`
 * under the plain policy), with its opened bytes; or the reason it is no usable event.
 */
export const decode = (bytes: Uint8Array, key: string, policy: CatalogPolicy): Decoded => {
  const line = parseLine(key, bytes);
  if ("skip" in line) return line;
  const sealed = looksSealed(bytes);
  if (policy.seal === "plain") {
    if (sealed)
      return skip(
        "seal-failed",
        finding("catalog.seal-failed", {
          message: `the catalog event ${key} was left out: it is sealed, and this store's catalog is plain, so there is no key to open it`,
          fix: "check that the store is the one this device set up; keep the file, plainport never changes it",
          paths: [key],
        }),
      );
    return checkEvent(key, line.value, bytes);
  }
  if (!sealed)
    return skip(
      "unsealed-event",
      finding("catalog.unsealed-event", {
        message: `the catalog event ${key} was left out: it is plaintext, and this store's catalog is sealed, so it may not be one of the store's own events`,
        fix: "keep the file and report it; plainport never reads a plaintext event on a sealed store, and never changes it",
        paths: [key],
      }),
    );
  const opened = open({ key: policy.key, storeId: policy.storeId, eventKey: key, sealed: bytes });
  if (!opened.ok)
    return skip(
      "seal-failed",
      finding("catalog.seal-failed", {
        message: `the catalog event ${key} was left out: ${opened.finding.message}`,
        ...(opened.finding.fix === undefined ? {} : { fix: opened.finding.fix }),
        paths: [key],
      }),
    );
  const inner = parseLine(key, opened.value);
  if ("skip" in inner) return inner;
  return checkEvent(key, inner.value, opened.value);
};

/**
 * Task 6's SameEvent for one event key under a policy: the opened events compared, so a sealed retry (a new nonce,
 * other bytes) is the same event. An existing file that is no event is not the same; one that does not open
 * (catalog.seal-failed) cannot be told, and is returned as that failure.
 */
export const sameEvent =
  (key: string, policy: CatalogPolicy): SameEvent =>
  (existing, intended) => {
    const mine = decode(intended, key, policy);
    if ("skip" in mine) return fail(mine.skip.finding); // never: the writer encoded it
    const theirs = decode(existing, key, policy);
    if ("skip" in theirs) return theirs.skip.reason === "seal-failed" ? fail(theirs.skip.finding) : ok(false);
    return ok(JSON.stringify(theirs.event) === JSON.stringify(mine.event));
  };

/** The finding codes a skipped event carries: every one leaves the fold uncertain (D86). */
export const SKIP_CODES: readonly string[] = [
  "catalog.event-skipped",
  "catalog.unsealed-event",
  "catalog.seal-failed",
];
