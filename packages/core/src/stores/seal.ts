// A store's catalog seal as this device uses it (Q10; DESIGN.md "Catalog seal v1", "Bootstrap"). The policy is the
// store's, published once in its format-2 meta/v1/store.json and fixed at bootstrap; each device pins the policy it
// first saw in its record of the store (stores/<id>.json), with the key id of the first catalog key it derived. From
// then on:
//   - a store that shows another policy than the pin is refused (store.identity-changed), either way: a plain pin never
//     reads a store that turned sealed, and a sealed pin never reads one that turned plain, whose plaintext events
//     anyone who can write to the store could have put there;
//   - a key whose id differs from the pinned one fails closed (catalog.seal-failed): M2 never rotates a catalog key.
// A sealed store's catalog key comes from the engine (Engine.catalogKey: the repository's master key, read in the
// runner's sensitive mode); a plain store needs no key and no secret (D108).

import { type Failure, fail, finding, ok, type Result } from "@plainport/contract";
import { type CatalogPolicy, PLAIN_CATALOG } from "../catalog/codec.ts";
import { readStoreDescriptor, type SealPolicy, STORE_IDENTITY_KEY } from "../catalog/identity.ts";
import type { LocalIo } from "../io.ts";
import type { PlainportPaths } from "../paths.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { Engine, RunContext } from "../ports/engine.ts";
import { pinSeal, readStoreSeal, type SealPin } from "../stores-state.ts";

const named = (policy: SealPolicy): string => (policy === "v1" ? "sealed (v1)" : "plain");

/** store.identity-changed for a store whose seal policy is not the one this device pinned. */
export const sealFlipped = (name: string, id: string, pinned: SealPolicy, found: SealPolicy): Failure =>
  fail(
    finding("store.identity-changed", {
      message: `store ${name} (${id}) says its catalog is ${named(found)}, but this device pinned it ${named(pinned)} when it first used the store (Q10); a store's seal policy never changes, so its ${STORE_IDENTITY_KEY} was replaced or this is not the store it was; nothing was read or written`,
      fix: `check ${STORE_IDENTITY_KEY} on the store against the seal policy it was set up with; a store set up anew needs a new name: plainport store add <new-name> …`,
      paths: [STORE_IDENTITY_KEY],
    }),
  );

/** The pin against what the store publishes now: ok when there is no pin yet or they agree. */
export const checkSealPin = (
  name: string,
  id: string,
  found: SealPolicy,
  pin: SealPin | undefined,
): Result<void> =>
  pin === undefined || pin.policy === found ? ok(undefined) : sealFlipped(name, id, pin.policy, found);

/** Pins the policy the store publishes (first contact), or checks it against the pin. */
export const pinStoreSeal = async (
  io: LocalIo,
  paths: PlainportPaths,
  store: { name: string; id: string },
  found: SealPolicy,
  at: string,
): Promise<Result<SealPin>> => {
  const pinned = await pinSeal(io, paths, store.id, found, at);
  if (!pinned.ok) return pinned;
  const checked = checkSealPin(store.name, store.id, found, pinned.value);
  return checked.ok ? pinned : checked;
};

/** Codes a key derivation passes on as they are: a store not reached, a secret not read, a run stopped. */
const PASSED_ON = ["store.unreachable", "store.secret-missing", "process.cancelled"];

const keyUnavailable = (name: string, cause: Failure): Failure =>
  PASSED_ON.includes(cause.finding.code)
    ? cause
    : fail(
        finding("store.seal-key-unavailable", {
          message: `store ${name}'s catalog is sealed and its key could not be derived from its repository (${cause.finding.code}: ${cause.finding.message})`,
          fix: cause.finding.fix ?? `check store ${name}'s secret and repository, then re-run`,
        }),
      );

const kidChanged = (name: string, id: string, pinned: string, found: string): Failure =>
  fail(
    finding("catalog.seal-failed", {
      message: `store ${name} (${id}) gave a catalog key with id ${found}, but this device pinned key id ${pinned}: the store's repository is not the one whose key sealed its catalog (Catalog seal v1 never rotates a key in M2); nothing was read or written`,
      fix: `check that store ${name}'s repository (its ${STORE_IDENTITY_KEY} repo) is the one it was set up with; a store set up anew needs a new name: plainport store add <new-name> …`,
      paths: [STORE_IDENTITY_KEY],
    }),
  );

export interface StoreCatalogOptions {
  /** Pin what the store shows when this device has no pin yet (a write path's first contact); views only check. */
  pin: boolean;
  at: () => string;
  ctx?: RunContext;
}

/**
 * The catalog policy to read and write the store `id` (this device's id for `name`) with: the opener's own when it
 * gives one (a test's fake), else the one the store's meta/v1/store.json publishes, with the key a sealed one needs.
 * The pin is checked either way. A store without an identity, or with another id, is not refused here: the catalog
 * read refuses it with store.identity-changed, by its own check; until then it reads as plain.
 */
export const storeCatalog = async (
  io: LocalIo,
  paths: PlainportPaths,
  store: { name: string; id: string; blob: BlobStore; engine: Engine; catalog?: CatalogPolicy },
  options: StoreCatalogOptions,
): Promise<Result<CatalogPolicy>> => {
  const found = await readStoreDescriptor(store.blob);
  if (!found.ok) return found;
  const descriptor = found.value;
  if (descriptor === null || descriptor.id !== store.id) return ok(store.catalog ?? PLAIN_CATALOG);
  const who = { name: store.name, id: store.id };
  const pin = options.pin
    ? await pinStoreSeal(io, paths, who, descriptor.seal, options.at())
    : await readStoreSeal(io, paths, store.id);
  if (!pin.ok) return pin;
  const checked = checkSealPin(store.name, store.id, descriptor.seal, pin.value);
  if (!checked.ok) return checked;
  if (store.catalog !== undefined) return ok(store.catalog);
  if (descriptor.seal === "none") return ok(PLAIN_CATALOG);

  const derived = await store.engine.catalogKey(store.id, options.ctx);
  if (!derived.ok) return keyUnavailable(store.name, derived);
  const { key, kid } = derived.value;
  const pinnedKid = pin.value?.kid;
  if (pinnedKid !== undefined && pinnedKid !== kid) return kidChanged(store.name, store.id, pinnedKid, kid);
  if (pinnedKid === undefined && options.pin) {
    const withKid = await pinSeal(io, paths, store.id, descriptor.seal, options.at(), kid);
    if (!withKid.ok) return withKid;
    if (withKid.value.kid !== undefined && withKid.value.kid !== kid)
      return kidChanged(store.name, store.id, withKid.value.kid, kid);
  }
  return ok({ seal: "sealed", storeId: store.id, key });
};

/**
 * Whether a view must resolve the store's secret to read its catalog (D105, D108): the store publishes a sealed
 * catalog, or this device pinned it sealed (then storeCatalog refuses the store that turned plain).
 */
export const sealedByPin = async (
  io: LocalIo,
  paths: PlainportPaths,
  id: string,
): Promise<Result<boolean>> => {
  const pin = await readStoreSeal(io, paths, id);
  return pin.ok ? ok(pin.value?.policy === "v1") : pin;
};
