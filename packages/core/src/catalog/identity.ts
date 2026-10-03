// A store's identity (D45): `meta/v1/store.json` holds `{ v: 1, id: <ULID> }`, written once when the store is set up
// (plainport init and store setup call ensureStoreIdentity). The local mirror is keyed by that id, never by the store's
// name in config, so a name pointed at another disk, a restored copy of a store folder, or two names for one folder
// never mix catalogs: loadCatalog refuses a store whose id is not the one this device knows (store.identity-changed).
//
// On a store without hard links (exFAT) the file is created in place (D41), so a crash at setup can leave it empty or
// half-written (m10). Such a file is a strict prefix of a valid identity file. While the store holds no events, no
// mirror can be keyed by the id it was going to have, so setup completes it with a fresh id; once events exist the
// file is never replaced, and the fix says where the id is recorded (each device's registry.json).

import { type Failure, fail, finding, ok, type Result } from "@plainport/contract";
import { z } from "zod";
import type { BlobStore } from "../ports/blob-store.ts";
import { UlidSchema } from "../ulid.ts";

export const STORE_IDENTITY_KEY = "meta/v1/store.json";
/** Where a store's events live; a store that holds any was in use under its id. */
const EVENTS_PREFIX = "meta/v1/events/";

export const StoreIdentitySchema = z
  .strictObject({ v: z.literal(1), id: UlidSchema })
  .meta({ title: "StoreIdentity", description: "meta/v1/store.json: a store's id, written once at setup" });
export type StoreIdentity = z.infer<typeof StoreIdentitySchema>;

const encodeIdentity = (identity: StoreIdentity): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(identity)}\n`);

/** The bytes around the id in the file ensureStoreIdentity writes; a torn file is a strict prefix of head + id + tail. */
const HEAD = '{"v":1,"id":"';
const TAIL = '"}\n';
const ULID_LENGTH = 26;
const ULID_CHARS = /^[0-9A-HJKMNP-TV-Z]$/;

/** Whether `text` is a strict prefix of a valid identity file: what a crash mid-write leaves (an empty file included). */
export const isTornIdentity = (text: string): boolean => {
  if (text.length >= HEAD.length + ULID_LENGTH + TAIL.length) return false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (i < HEAD.length) {
      if (char !== HEAD[i]) return false;
    } else if (i < HEAD.length + ULID_LENGTH) {
      if (!ULID_CHARS.test(char)) return false;
    } else if (char !== TAIL[i - HEAD.length - ULID_LENGTH]) return false;
  }
  return true;
};

const RECOVER_ID =
  'the store was in use under its id, and every device\'s mirror is keyed by it: take the id from the registry.json (under stores) of a device that set this store up, write {"v":1,"id":"<id>"} to meta/v1/store.json, and re-run; plainport never replaces a file that events depend on';

const damaged = (reason: string): Failure =>
  fail(
    finding("store.failed", {
      message: `the store's identity file ${STORE_IDENTITY_KEY} is not valid: ${reason}; it was left as it is`,
      fix: RECOVER_ID,
      paths: [STORE_IDENTITY_KEY],
    }),
  );

const torn = (bytes: number, hasEvents: boolean): Failure =>
  fail(
    finding("store.failed", {
      message: `the store's identity file ${STORE_IDENTITY_KEY} is half-written (${bytes} bytes of a valid file): the setup that wrote it did not finish; it was left as it is`,
      fix: hasEvents
        ? RECOVER_ID
        : "set the store up again with plainport init: it holds no events yet, so nothing is keyed by the id it was going to have, and setup completes the file with a fresh id",
      paths: [STORE_IDENTITY_KEY],
    }),
  );

type Inspected =
  | { kind: "absent" }
  | { kind: "id"; id: string }
  /** A strict prefix of a valid file; `hasEvents` says whether the store was used under it. */
  | { kind: "torn"; bytes: number; hasEvents: boolean }
  | { kind: "damaged"; reason: string };

const inspect = async (store: BlobStore): Promise<Result<Inspected>> => {
  const bytes = await store.get(STORE_IDENTITY_KEY);
  if (!bytes.ok) return bytes;
  if (bytes.value === null) return ok({ kind: "absent" });
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.value);
  } catch (error) {
    return ok({ kind: "damaged", reason: `it is not UTF-8 (${(error as Error).message})` });
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    if (!isTornIdentity(text))
      return ok({ kind: "damaged", reason: `it is not JSON (${(error as Error).message})` });
    const events = await store.list(EVENTS_PREFIX);
    if (!events.ok) return events;
    return ok({ kind: "torn", bytes: bytes.value.length, hasEvents: events.value.length > 0 });
  }
  const checked = StoreIdentitySchema.safeParse(data);
  return checked.success
    ? ok({ kind: "id", id: checked.data.id })
    : ok({ kind: "damaged", reason: "it does not match { v: 1, id: <ULID> }" });
};

const refuse = (found: Exclude<Inspected, { kind: "absent" | "id" }>): Failure =>
  found.kind === "torn" ? torn(found.bytes, found.hasEvents) : damaged(found.reason);

/**
 * The store's id, null when it has none, or a failure when the file cannot be read or is damaged. A half-written file
 * is store.failed too, with a fix that says whether setup may complete it.
 */
export const readStoreIdentity = async (store: BlobStore): Promise<Result<string | null>> => {
  const found = await inspect(store);
  if (!found.ok) return found;
  if (found.value.kind === "absent") return ok(null);
  if (found.value.kind === "id") return ok(found.value.id);
  return refuse(found.value);
};

/**
 * The store's id, writing `{ v: 1, id: mint() }` create-only when it has none. Of two devices setting a store up at
 * once, one id wins and both return it. A half-written file on a store with no events is completed with a fresh id,
 * and the id read back afterwards is the one returned, so two devices completing it at once agree. A damaged file,
 * or a half-written one on a store that holds events, is reported and never replaced.
 */
export const ensureStoreIdentity = async (
  store: BlobStore,
  mint: () => string,
): Promise<Result<{ id: string; created: boolean }>> => {
  const found = await inspect(store);
  if (!found.ok) return found;
  if (found.value.kind === "id") return ok({ id: found.value.id, created: false });
  if (found.value.kind === "damaged" || (found.value.kind === "torn" && found.value.hasEvents))
    return refuse(found.value);
  const identity: StoreIdentity = { v: 1, id: mint() };
  if (found.value.kind === "torn") {
    const completed = await store.put(STORE_IDENTITY_KEY, encodeIdentity(identity));
    if (!completed.ok) return completed;
    const written = await readStoreIdentity(store);
    if (!written.ok) return written;
    return written.value === null
      ? ok({ id: identity.id, created: true })
      : ok({ id: written.value, created: true });
  }
  const createOnly = store.capabilities().createIfAbsent;
  const put = await store.put(
    STORE_IDENTITY_KEY,
    encodeIdentity(identity),
    createOnly ? { ifNotExists: true } : {},
  );
  if (put.ok) return ok({ id: identity.id, created: true });
  if (put.finding.code !== "store.key-exists") return put;
  const winner = await readStoreIdentity(store);
  if (!winner.ok) return winner;
  return winner.value === null ? put : ok({ id: winner.value, created: false });
};

/** store.identity-changed: the store at the configured path is not the one this device synced. */
export const identityChanged = (expected: string, found: string | null, where: string): Failure =>
  fail(
    finding("store.identity-changed", {
      message:
        found === null
          ? `the store has no identity file (${STORE_IDENTITY_KEY}), so it is not the store ${expected} this device knows; nothing was synced`
          : `the ${where} belongs to store ${found}, not the store ${expected} this device knows; nothing was synced`,
      fix: "check that the store's path in config.toml points at the right disk; if the store really changed, set it up again with plainport init",
      paths: [STORE_IDENTITY_KEY],
    }),
  );
