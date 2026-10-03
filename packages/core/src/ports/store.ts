// The store opener: how core reaches a store defined in config (DESIGN.md "Storage → Store kinds"). One definition
// gives both layers, the BlobStore for catalog events and the Engine bound to the store's repository, so the two
// always point at the same place. The composition root implements it (blob-fs plus restic in M1; rclone and peer
// stores follow); tests pass a fake engine.

import type { Result } from "@plainport/contract";
import type { Store } from "../config/schema.ts";
import type { BlobStore } from "./blob-store.ts";
import type { Engine } from "./engine.ts";

export interface OpenedStore {
  blob: BlobStore;
  engine: Engine;
}

export interface StoreOpener {
  /** The store's two layers; the engine is bound to its repository and this password. store.unsupported for a
   * kind this build cannot use. Opening reaches nothing: the first call on either layer does. */
  open(name: string, store: Store, password: string): Promise<Result<OpenedStore>>;
}
