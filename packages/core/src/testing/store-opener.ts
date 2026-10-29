// A store opener for tests of the store commands (T0): every store, whatever its kind, is an in-memory blob store keyed by
// its location, and every repository under it a fake one keyed by `<location>/<repo>`, so devices sharing a world share
// the store. open() binds the engine to the repository the store's store.json publishes (repo/ when it has none or is
// format 1). A blob store can be wrapped (a store that denies deletes, one that stops answering). Used only by
// *.test.ts files and their helpers.

import { ok } from "@plainport/contract";
import { readStoreDescriptor } from "../catalog/identity.ts";
import type { Store } from "../config/schema.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { SecretProviders } from "../ports/secrets.ts";
import type { StoreOpener } from "../ports/store.ts";
import { storeLocation } from "../stores/location.ts";
import { type FakeRepository, fakeEngine, fakeRepository } from "./fake-engine.ts";
import {
  type SemanticBlobStore,
  type SemanticFakeOptions,
  semanticBlobStore,
} from "./semantic-blob-store.ts";

export interface StoreWorld {
  /** The blob store at a location, made on first use. */
  blobAt(location: string): SemanticBlobStore;
  /** The fake repository at `<location>/<repo>`, made on first use. */
  repoAt(location: string, repo: string): FakeRepository;
  /** An opener for one device: its home expands `~`, `wrap` changes what a store's blob layer does. */
  opener(
    home: string,
    options?: { wrap?: (blob: BlobStore) => BlobStore; secrets?: SecretProviders },
  ): StoreOpener;
}

export const storeWorld = (options: SemanticFakeOptions = {}): StoreWorld => {
  const blobs = new Map<string, SemanticBlobStore>();
  const repos = new Map<string, FakeRepository>();
  const blobAt = (location: string): SemanticBlobStore => {
    let blob = blobs.get(location);
    if (blob === undefined) {
      blob = semanticBlobStore(options);
      blobs.set(location, blob);
    }
    return blob;
  };
  const repoAt = (location: string, repo: string): FakeRepository => {
    const key = `${location}/${repo}`;
    let found = repos.get(key);
    if (found === undefined) {
      found = fakeRepository();
      repos.set(key, found);
    }
    return found;
  };
  return {
    blobAt,
    repoAt,
    opener: (home, deviceOptions = {}) => {
      const wrap = deviceOptions.wrap ?? ((blob: BlobStore) => blob);
      const reach = (store: Store) => {
        const location = storeLocation(store, home);
        return { location, blob: wrap(blobAt(location)) };
      };
      return {
        ...(deviceOptions.secrets !== undefined && { secrets: deviceOptions.secrets }),
        open: async (_name, store, password) => {
          const { location, blob } = reach(store);
          const found = await readStoreDescriptor(blob);
          const repo = found.ok && found.value !== null ? found.value.repo : "repo";
          return ok({ blob, engine: fakeEngine(repoAt(location, repo), {}, { password }) });
        },
        bootstrap: async (_name, store, password) => {
          const { location, blob } = reach(store);
          return ok({
            blob,
            location,
            engineAt: (repo: string) => fakeEngine(repoAt(location, repo), {}, { password }),
          });
        },
      };
    },
  };
};
