// The store opener: how core reaches a store defined in config (DESIGN.md "Storage → Store kinds"). One definition
// gives both layers, the BlobStore for catalog events and the Engine bound to the store's repository, so the two
// always point at the same place. The composition root implements it (blob-fs plus restic in M1; rclone and peer
// stores follow); tests pass a fake engine.

import type { Finding, Result } from "@plainport/contract";
import type { CatalogPolicy } from "../catalog/codec.ts";
import type { Store } from "../config/schema.ts";
import type { BlobStore, StoreSemantics } from "./blob-store.ts";
import type { Engine } from "./engine.ts";
import type { SecretProviders } from "./secrets.ts";

export interface OpenedStore {
  blob: BlobStore;
  /** Bound to the repository the store publishes (its store.json's `repo`, read on the engine's first call). */
  engine: Engine;
  /** How the store's catalog events are encoded (codec.ts); plain when absent. Sealed stores arrive with Task 20. */
  catalog?: CatalogPolicy;
  /**
   * Where the store is, as its config resolves it (a folder, sftp:<host>:<path>, s3:<endpoint>/<bucket>/<path>), never
   * a secret; bootstrap journals it. Absent from an opener that cannot set stores up (test fakes).
   */
  location?: string;
  /** An engine bound to the repository at `repo` under the store's root, with this password (bootstrap's). */
  engineAt?(repo: string): Engine;
  /** Warnings about the store's configuration found while opening it (store.assertion-ignored, D111). */
  findings?: readonly Finding[];
}

/** An S3 store's key pair, read from its own references (Q7), for the opener to give its two layers. */
export interface StoreCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface StoreOpener {
  /** The providers that read a store's `keychain:` and `op:` references (Task 15); `env:` and `file:` need none. */
  secrets?: SecretProviders;
  /**
   * The store's two layers; the engine is bound to its repository and this password, an S3 store's to its key pair
   * too (without one, an S3 store does not open: store.secret-missing). store.unsupported for a kind this build cannot
   * use. Opening reaches nothing: the first call on either layer does.
   */
  open(
    name: string,
    store: Store,
    password: string,
    credentials?: StoreCredentials,
  ): Promise<Result<OpenedStore>>;
  /**
   * The store's semantics profile alone, from config and this device's measurement: no secret is read and nothing is
   * reached (recover's release gate, review phase 5 I2). Without it, a caller opens the store with no secret.
   */
  profile?(name: string, store: Store): Promise<Result<StoreSemantics>>;
}
