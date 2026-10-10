// A store's identity (D45): `meta/v1/store.json` holds `{ v: 1, id: <ULID> }`, written once when the store is set up
// (plainport init and store setup call ensureStoreIdentity). The local mirror is keyed by that id, never by the store's
// name in config, so a name pointed at another disk, a restored copy of a store folder, or two names for one folder
// never mix catalogs: loadCatalog refuses a store whose id is not the one this device knows (store.identity-changed).
//
// Format 2 (Q2, Q9, Q10): `{ v: 2, id, repo, catalog: { seal }, format: 2 }` adds where the store's restic repository
// lies (`repos/<attempt>` for a store bootstrap set up, `repo` for one upgraded from format 1) and the catalog's seal
// policy, published once by the winner of bootstrap's election (saga/bootstrap.ts). v0.1.x refuses it before writing
// anything, which is what keeps it away from a format-2 store. A format-1 file reads as an M1 store: its repository at
// `repo/`, its catalog plain.
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
/** Where bootstrap's attempts stand for the store's publication (the elected publication's candidates, D99). */
export const STORE_CLAIMS_PREFIX = "meta/v1/store-claims/";
/** Where a store's events live; a store that holds any was in use under its id. */
const EVENTS_PREFIX = "meta/v1/events/";

/** The catalog's seal policy (Q10): plain, or sealed under Catalog seal v1 (Task 10's spec). */
export const SealPolicySchema = z.enum(["none", "v1"]);
export type SealPolicy = z.infer<typeof SealPolicySchema>;

/** Where a store's restic repository lies under its root: M1's `repo`, or a bootstrap attempt's `repos/<ULID>`. */
export const StoreRepoSchema = z
  .string()
  .regex(/^(?:repo|repos\/[0-9A-HJKMNP-TV-Z]{26})$/, "repo or repos/<ULID>");

export const StoreIdentityV1Schema = z.strictObject({ v: z.literal(1), id: UlidSchema });
export type StoreIdentityV1 = z.infer<typeof StoreIdentityV1Schema>;

export const StoreIdentityV2Schema = z.strictObject({
  v: z.literal(2),
  id: UlidSchema,
  repo: StoreRepoSchema,
  catalog: z.strictObject({ seal: SealPolicySchema }),
  format: z.literal(2),
});
export type StoreIdentityV2 = z.infer<typeof StoreIdentityV2Schema>;

export const StoreIdentitySchema = z.union([StoreIdentityV1Schema, StoreIdentityV2Schema]).meta({
  title: "StoreIdentity",
  description:
    "meta/v1/store.json: a store's id (format 1), or its id, repository location and catalog seal policy (format 2), written once",
});
export type StoreIdentity = z.infer<typeof StoreIdentitySchema>;

/** What a store's identity file says, whatever its format. */
export interface StoreDescriptor {
  format: 1 | 2;
  id: string;
  /** The restic repository's location under the store's root. */
  repo: string;
  seal: SealPolicy;
}

const describe = (identity: StoreIdentity): StoreDescriptor =>
  identity.v === 1
    ? { format: 1, id: identity.id, repo: "repo", seal: "none" }
    : { format: 2, id: identity.id, repo: identity.repo, seal: identity.catalog.seal };

const encodeIdentity = (identity: StoreIdentityV1): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(identity)}\n`);

/** The bytes of a format-2 store.json, its id written first so that a torn copy still names whose it was. */
export const encodeStoreIdentityV2 = (store: { id: string; repo: string; seal: SealPolicy }): Uint8Array =>
  new TextEncoder().encode(
    `${JSON.stringify({ v: 2, id: store.id, repo: store.repo, catalog: { seal: store.seal }, format: 2 } satisfies StoreIdentityV2)}\n`,
  );

/** The descriptor `bytes` hold, or undefined for bytes that are not a whole, valid identity file of either format. */
export const parseStoreIdentity = (bytes: Uint8Array): StoreDescriptor | undefined => {
  try {
    const checked = StoreIdentitySchema.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    return checked.success ? describe(checked.data) : undefined;
  } catch {
    return undefined;
  }
};

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
  | { kind: "id"; id: string; descriptor: StoreDescriptor }
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
    ? ok({ kind: "id", id: checked.data.id, descriptor: describe(checked.data) })
    : ok({
        kind: "damaged",
        reason:
          "it matches neither format 1 { v: 1, id: <ULID> } nor format 2 { v: 2, id, repo, catalog: { seal }, format: 2 }",
      });
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
  if (found.value.kind === "id") return m1Only(found.value.descriptor);
  return refuse(found.value);
};

/**
 * The id of a format-1 store. M1's paths (setup, the catalog, recover) bind restic at `repo/`, so on a format-2 store
 * they would read, or `restic init`, a repository the store does not publish: they fail closed with store.unsupported
 * before anything is written, until a format-2 store's `repo` is wired (Task 18). Bootstrap reads format 2 through
 * readStoreDescriptor.
 */
const m1Only = (found: StoreDescriptor): Result<string> =>
  found.format === 1
    ? ok(found.id)
    : fail(
        finding("store.unsupported", {
          message: `the store's ${STORE_IDENTITY_KEY} is format 2 (store ${found.id}, its repository at ${found.repo}), which this command cannot use yet: it reads format-1 stores only; nothing was written`,
          fix: "use this store with a plainport version that sets up and reads format-2 stores, or point this name at a format-1 store",
          paths: [STORE_IDENTITY_KEY],
        }),
      );

/** What the store's identity file says (either format), null when it has none, or a failure as readStoreIdentity's. */
export const readStoreDescriptor = async (store: BlobStore): Promise<Result<StoreDescriptor | null>> => {
  const found = await inspect(store);
  if (!found.ok) return found;
  if (found.value.kind === "absent") return ok(null);
  if (found.value.kind === "id") return ok(found.value.descriptor);
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
  if (found.value.kind === "id") {
    const id = m1Only(found.value.descriptor);
    return id.ok ? ok({ id: id.value, created: false }) : id;
  }
  if (found.value.kind === "damaged" || (found.value.kind === "torn" && found.value.hasEvents))
    return refuse(found.value);
  const identity: StoreIdentityV1 = { v: 1, id: mint() };
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
      fix: "check that the store's path in config.toml points at the disk this device set up under that name; plainport never moves a name to another store, so a different store needs a new name: plainport init --store-path <path> --store <new-name> --yes",
      paths: [STORE_IDENTITY_KEY],
    }),
  );
