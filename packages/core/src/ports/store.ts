// The store opener: how core reaches a store defined in config (DESIGN.md "Storage → Store kinds"). One definition
// gives both layers, the BlobStore for catalog events and the Engine bound to the store's repository, so the two
// always point at the same place. The composition root implements it (blob-fs plus restic in M1; rclone and peer
// stores follow); tests pass a fake engine.

import type { Result } from "@plainport/contract";
import type { CatalogPolicy } from "../catalog/codec.ts";
import type { Store } from "../config/schema.ts";
import type { BootstrapStore } from "../saga/bootstrap.ts";
import type { BlobStore } from "./blob-store.ts";
import type { Engine } from "./engine.ts";
import type { SecretProviders } from "./secrets.ts";

export interface OpenedStore {
  blob: BlobStore;
  engine: Engine;
  /** How the store's catalog events are encoded (codec.ts); plain when absent. Sealed stores arrive with Task 20. */
  catalog?: CatalogPolicy;
}

export interface StoreOpener {
  /** The providers that read a store's `keychain:` and `op:` references (Task 15); `env:` and `file:` need none. */
  secrets?: SecretProviders;
  /** The store's two layers; the engine is bound to its repository and this password. store.unsupported for a
   * kind this build cannot use. Opening reaches nothing: the first call on either layer does. */
  open(name: string, store: Store, password: string): Promise<Result<OpenedStore>>;
  /**
   * The store as bootstrap reaches it (Task 8, DESIGN.md "Bootstrap"): its metadata layer, where it is (never a secret),
   * and an engine at any repository location under its root, with this password. `store add` and `init` set a store up
   * through it; without it, they can only adopt nothing and refuse with store.unsupported.
   */
  bootstrap?(name: string, store: Store, password: string): Promise<Result<BootstrapStore>>;
}
