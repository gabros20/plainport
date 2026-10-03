// The BlobStore port (DESIGN.md "Plugin interfaces → BlobStore"): where catalog events and the state.json cache
// live on a store. It needs only put, get and prefix listing; create-if-absent is a bonus some stores give.
// @plainport/blob-fs implements it over node:fs for local disks and mounts; rclone and peer stores follow in M2/M3.
//
// As with the Engine (run decision D27), every call returns a Result (AGENTS.md rule 7): an unmounted disk or a
// refused create-only write is an expected failure with a finding, never an exception. `list` returns the whole
// listing at once, sorted by key, because a catalog is a few kilobytes per project.
//
// Keys are `/`-separated paths relative to the store's root, such as `meta/v1/events/<ulid>.json`: no leading or
// trailing `/`, no empty, `.` or `..` segments, no NUL. A bad key is a bug in the caller and throws.

import type { Result } from "@plainport/contract";

export interface BlobCapabilities {
  /** put(…, { ifNotExists: true }) is atomic: of two writers, exactly one creates the key. */
  createIfAbsent: boolean;
  /** put(…, { ifMatch }) replaces only the version with that etag. */
  replaceIfMatch: boolean;
}

export interface BlobEntry {
  key: string;
  size: number;
  etag?: string;
}

export interface PutOptions {
  /** Refuse with store.key-exists when the key is there. Requires capabilities().createIfAbsent. */
  ifNotExists?: boolean;
  /** Replace only this version. Requires capabilities().replaceIfMatch; passing it otherwise is a bug. */
  ifMatch?: string;
}

export interface BlobStore {
  capabilities(): BlobCapabilities;
  /** The key's bytes, or null when there is no such key. */
  get(key: string): Promise<Result<Uint8Array | null>>;
  /**
   * Writes the key. A replacing write is whole: a reader sees the old bytes or the new ones, never a part. A
   * create-only write is whole where the store can link or rename into place; where it cannot (blob-fs on exFAT or
   * FAT, D41) the key is created in place, so a reader may see a torn prefix, and a crash can leave one that the same
   * writer's retry completes under the same name (D42).
   */
  put(key: string, data: Uint8Array, opts?: PutOptions): Promise<Result<{ etag?: string }>>;
  /** Every key starting with `prefix` (which may be ""), sorted by key. */
  list(prefix: string): Promise<Result<BlobEntry[]>>;
  stat(key: string): Promise<Result<{ size: number; etag?: string } | null>>;
  /** Removes the key; a key that is not there is not an error. */
  delete(key: string): Promise<Result<void>>;
}

const KEY_PATTERN = /^(?!\.\.?(?:\/|$))[^/\0]+(?:\/(?!\.\.?(?:\/|$))[^/\0]+)*$/;

/** Whether `key` is a valid blob key (see above). */
export const isBlobKey = (key: string): boolean => KEY_PATTERN.test(key);

/** Throws when `key` is not a valid blob key: a caller handing one over is a bug. */
export const assertBlobKey = (key: string): void => {
  if (!isBlobKey(key)) throw new RangeError(`not a valid blob key: ${JSON.stringify(key)}`);
};

/** A prefix is "" or a key, optionally followed by "/". */
export const assertBlobPrefix = (prefix: string): void => {
  if (prefix === "") return;
  if (!isBlobKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix)) {
    throw new RangeError(`not a valid blob prefix: ${JSON.stringify(prefix)}`);
  }
};
