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
  /** Calls made so far, by method, to count round trips. */
  readonly calls: Record<Method, number>;
  /** The next call of `method` returns `code` (store.unreachable by default) instead of running. */
  failNext(method: Method, code?: "store.unreachable" | "store.failed"): void;
}

type Method = "get" | "put" | "list" | "stat" | "delete";

export const memoryBlobStore = (
  options: {
    createIfAbsent?: boolean /** Puts of keys ending with this fail with store.failed. */;
    refusePutsUnder?: string;
  } = {},
): MemoryBlobStore => {
  const data = new Map<string, Uint8Array>();
  const failing = new Map<string, "store.unreachable" | "store.failed">();
  const calls: Record<Method, number> = { get: 0, put: 0, list: 0, stat: 0, delete: 0 };
  const unreachable = (method: Method): Failure | undefined => {
    calls[method]++;
    const code = failing.get(method);
    if (code === undefined) return undefined;
    failing.delete(method);
    return fail(finding(code, { message: `the memory store refused ${method} (failNext)` }));
  };
  return {
    data,
    calls,
    failNext: (method, code = "store.unreachable") => {
      failing.set(method, code);
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
      if (options.refusePutsUnder !== undefined && key.endsWith(options.refusePutsUnder)) {
        return Promise.resolve(fail(finding("store.failed", { message: `the memory store refuses ${key}` })));
      }
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
