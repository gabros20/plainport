// An in-memory BlobStore for core's tests: the catalog runs against it without a disk. It passes the same contract
// suite as blob-fs (testing/blob-store-contract.ts). `failNext` makes the next call of one method fail, to test how
// callers handle a store that drops out.

import { type Failure, fail, finding, ok } from "@plainport/contract";
import {
  assertBlobKey,
  assertBlobPrefix,
  type BlobEntry,
  type BlobStore,
  type PutOptions,
} from "../ports/blob-store.ts";

export interface MemoryBlobStore extends BlobStore {
  /** The stored bytes by key, for assertions. */
  readonly data: Map<string, Uint8Array>;
  /** The next call of `method` returns store.unreachable instead of running. */
  failNext(method: "get" | "put" | "list" | "stat" | "delete"): void;
}

export const memoryBlobStore = (options: { createIfAbsent?: boolean } = {}): MemoryBlobStore => {
  const data = new Map<string, Uint8Array>();
  const failing = new Set<string>();
  const unreachable = (method: string): Failure | undefined => {
    if (!failing.delete(method)) return undefined;
    return fail(finding("store.unreachable", { message: `the memory store refused ${method} (failNext)` }));
  };
  return {
    data,
    failNext: (method) => {
      failing.add(method);
    },
    capabilities: () => ({ createIfAbsent: options.createIfAbsent ?? true, replaceIfMatch: false }),
    get: (key) => {
      assertBlobKey(key);
      return Promise.resolve(
        unreachable("get") ?? ok(data.has(key) ? new Uint8Array(data.get(key) as Uint8Array) : null),
      );
    },
    put: (key, bytes, opts: PutOptions = {}) => {
      assertBlobKey(key);
      if (opts.ifMatch !== undefined) throw new Error("memoryBlobStore: ifMatch is not supported");
      const refused = unreachable("put");
      if (refused) return Promise.resolve(refused);
      if (opts.ifNotExists && data.has(key)) {
        return Promise.resolve(
          fail(finding("store.key-exists", { message: `${key} already exists`, paths: [key] })),
        );
      }
      data.set(key, new Uint8Array(bytes));
      return Promise.resolve(ok({}));
    },
    list: (prefix) => {
      assertBlobPrefix(prefix);
      const refused = unreachable("list");
      if (refused) return Promise.resolve(refused);
      const entries: BlobEntry[] = [...data.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, bytes]) => ({ key, size: bytes.length }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return Promise.resolve(ok(entries));
    },
    stat: (key) => {
      assertBlobKey(key);
      const bytes = data.get(key);
      return Promise.resolve(unreachable("stat") ?? ok(bytes === undefined ? null : { size: bytes.length }));
    },
    delete: (key) => {
      assertBlobKey(key);
      const refused = unreachable("delete");
      if (refused) return Promise.resolve(refused);
      data.delete(key);
      return Promise.resolve(ok(undefined));
    },
  };
};
