// A store's identity (D45): `meta/v1/store.json` holds `{ v: 1, id: <ULID> }`, written once when the store is set up
// (plainport init and store setup call ensureStoreIdentity). The local mirror is keyed by that id, never by the store's
// name in config, so a name pointed at another disk, a restored copy of a store folder, or two names for one folder
// never mix catalogs: loadCatalog refuses a store whose id is not the one this device knows (store.identity-changed).

import { type Failure, fail, finding, ok, type Result } from "@plainport/contract";
import { z } from "zod";
import type { BlobStore } from "../ports/blob-store.ts";
import { UlidSchema } from "../ulid.ts";

export const STORE_IDENTITY_KEY = "meta/v1/store.json";

export const StoreIdentitySchema = z
  .strictObject({ v: z.literal(1), id: UlidSchema })
  .meta({ title: "StoreIdentity", description: "meta/v1/store.json: a store's id, written once at setup" });
export type StoreIdentity = z.infer<typeof StoreIdentitySchema>;

const damaged = (reason: string): Failure =>
  fail(
    finding("store.failed", {
      message: `the store's identity file ${STORE_IDENTITY_KEY} is not valid: ${reason}; it was left as it is`,
      fix: `restore ${STORE_IDENTITY_KEY} from a backup of the store; plainport never replaces it, since the store's mirrors are keyed by it`,
      paths: [STORE_IDENTITY_KEY],
    }),
  );

/** The store's id, null when it has none, or a failure when the file cannot be read or is damaged. */
export const readStoreIdentity = async (store: BlobStore): Promise<Result<string | null>> => {
  const bytes = await store.get(STORE_IDENTITY_KEY);
  if (!bytes.ok) return bytes;
  if (bytes.value === null) return ok(null);
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.value));
  } catch (error) {
    return damaged(`it is not JSON (${(error as Error).message})`);
  }
  const checked = StoreIdentitySchema.safeParse(data);
  return checked.success ? ok(checked.data.id) : damaged("it does not match { v: 1, id: <ULID> }");
};

/**
 * The store's id, writing `{ v: 1, id: mint() }` create-only when it has none. Of two devices setting a store up at
 * once, one id wins and both return it. A damaged file is reported and never replaced.
 */
export const ensureStoreIdentity = async (
  store: BlobStore,
  mint: () => string,
): Promise<Result<{ id: string; created: boolean }>> => {
  const current = await readStoreIdentity(store);
  if (!current.ok) return current;
  if (current.value !== null) return ok({ id: current.value, created: false });
  const identity: StoreIdentity = { v: 1, id: mint() };
  const createOnly = store.capabilities().createIfAbsent;
  const put = await store.put(
    STORE_IDENTITY_KEY,
    new TextEncoder().encode(`${JSON.stringify(identity)}\n`),
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
