// The semantic fake (DESIGN.md "Remote stores: consistency and publication"): the memory store with a switch for
// each way a remote store can be weaker than a local disk, so the catalog, the elected publication and their callers
// are tested against every weakness before any adapter exists.
//
// - delayedVisibility: get and stat do not see a write (or its key's new value) until settle().
// - listOmitsRecent: a listing leaves out keys created since the last settle().
// - truncateListAt: a listing returns only its first n keys (a page the store forgot to follow).
// - tornWrites: a put is in place: readers see the first half of the bytes while it is written, and tearNext() stops
//   the next put there for good (a crash mid-write). With `rename`, rename() moves a key whole.
// - loseAckNext(): the next put (or rename) lands, and the call fails (a lost acknowledgement).
// - cancelNext(): the next put is cancelled and fails; with lateLanding it lands at the next settle(), else never.
//
// Its semantics() describe those switches honestly, unless `profile` is given: a test passes a profile that lies to
// show that the contract's probes (semanticViolations) catch the weakness.

import { fail, finding, ok, type Result } from "@plainport/contract";
import {
  assertBlobKey,
  assertBlobPrefix,
  type BlobEntry,
  type BlobStore,
  capabilitiesOf,
  type PutOptions,
  type StoreSemantics,
} from "../ports/blob-store.ts";
import { MEMORY_SEMANTICS } from "./memory-blob-store.ts";

export interface SemanticFakeOptions {
  delayedVisibility?: boolean;
  listOmitsRecent?: boolean;
  truncateListAt?: number;
  tornWrites?: boolean;
  /** The store has a rename that moves a key whole (with tornWrites: a temp-then-rename store). */
  rename?: boolean;
  lateLanding?: boolean;
  /** Whether put(…, { ifNotExists }) is offered; true by default. */
  conditionalCreate?: boolean;
  durability?: "durable" | "acked-unsynced" | "unknown";
  /** What semantics() reports instead of the honest profile. */
  profile?: StoreSemantics;
}

type Method = "get" | "put" | "list" | "stat" | "delete" | "rename";

export interface SemanticBlobStore extends BlobStore {
  /** The bytes each key holds now, whatever readers are shown. */
  readonly data: Map<string, Uint8Array>;
  readonly calls: Record<Method, number>;
  /** Everything delayed becomes visible, and cancelled puts land when lateLanding is on. */
  settle(): void;
  /** The next `count` calls of `method` land, then fail with store.unreachable. */
  loseAckNext(method?: "put" | "rename", count?: number): void;
  /** The next put fails with process.cancelled without landing now. */
  cancelNext(): void;
  /** The next put leaves the first half of its bytes and fails with store.failed. */
  tearNext(): void;
  /** The next call of `method` fails with `code` and does nothing. */
  failNext(method: Method, code?: "store.unreachable" | "store.failed"): void;
}

const honestProfile = (options: SemanticFakeOptions): StoreSemantics => ({
  ...MEMORY_SEMANTICS,
  readAfterWrite: { value: !options.delayedVisibility, evidence: "asserted" },
  listAfterWrite: { value: !options.listOmitsRecent, evidence: "asserted" },
  listComplete: { value: options.truncateListAt === undefined, evidence: "asserted" },
  publication: {
    value: !options.tornWrites ? "atomic-put" : options.rename ? "temp-then-rename" : "in-place",
    evidence: "asserted",
  },
  conditionalCreate: { value: options.conditionalCreate ?? true, evidence: "asserted" },
  durability: { value: options.durability ?? "durable", evidence: "asserted" },
  cancellation: { value: options.lateLanding ? "may-land-late" : "never-lands-late", evidence: "asserted" },
});

/** Macrotasks a torn put spends with only its first half written, so a concurrent reader can see it. */
const TORN_TICKS = 3;
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export const semanticBlobStore = (options: SemanticFakeOptions = {}): SemanticBlobStore => {
  const semantics = options.profile ?? honestProfile(options);
  const data = new Map<string, Uint8Array>();
  /** Keys written since the last settle(), with the value readers saw before (null: the key did not exist). */
  const before = new Map<string, Uint8Array | null>();
  const late: [string, Uint8Array][] = [];
  const calls: Record<Method, number> = { get: 0, put: 0, list: 0, stat: 0, delete: 0, rename: 0 };
  const failing = new Map<Method, "store.unreachable" | "store.failed">();
  const lostAcks = { put: 0, rename: 0 };
  let cancelPending = false;
  let tearPending = false;

  const refused = (method: Method): Result<never> | undefined => {
    calls[method]++;
    const code = failing.get(method);
    if (code === undefined) return undefined;
    failing.delete(method);
    return fail(finding(code, { message: `the semantic fake refused ${method} (failNext)` }));
  };
  const lostAck = (method: "put" | "rename"): Result<never> | undefined => {
    if (lostAcks[method] === 0) return undefined;
    lostAcks[method]--;
    return fail(
      finding("store.unreachable", { message: `the semantic fake lost the acknowledgement of a ${method}` }),
    );
  };
  const remember = (key: string): void => {
    if (!before.has(key)) {
      const held = data.get(key);
      before.set(key, held === undefined ? null : held);
    }
  };
  /** What a reader is shown for `key`. */
  const shown = (key: string): Uint8Array | undefined => {
    if (options.delayedVisibility && before.has(key)) return before.get(key) ?? undefined;
    return data.get(key);
  };

  const store: SemanticBlobStore = {
    data,
    calls,
    settle: () => {
      before.clear();
      for (const [key, bytes] of late.splice(0)) data.set(key, bytes);
    },
    loseAckNext: (method = "put", count = 1) => {
      lostAcks[method] += count;
    },
    cancelNext: () => {
      cancelPending = true;
    },
    tearNext: () => {
      tearPending = true;
    },
    failNext: (method, code = "store.unreachable") => {
      failing.set(method, code);
    },
    semantics: () => semantics,
    capabilities: () => capabilitiesOf(semantics),
    get: (key) => {
      assertBlobKey(key);
      const bytes = shown(key);
      return Promise.resolve(refused("get") ?? ok(bytes === undefined ? null : new Uint8Array(bytes)));
    },
    stat: (key) => {
      assertBlobKey(key);
      const bytes = shown(key);
      return Promise.resolve(refused("stat") ?? ok(bytes === undefined ? null : { size: bytes.length }));
    },
    list: (prefix) => {
      assertBlobPrefix(prefix);
      const no = refused("list");
      if (no) return Promise.resolve(no);
      let entries: BlobEntry[] = [...data.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .filter(([key]) => !(options.listOmitsRecent && before.get(key) === null))
        .map(([key, bytes]) => ({ key, size: bytes.length }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      if (options.truncateListAt !== undefined) entries = entries.slice(0, options.truncateListAt);
      return Promise.resolve(ok(entries));
    },
    put: (key, bytes, opts: PutOptions = {}) => {
      assertBlobKey(key);
      if (opts.ifMatch !== undefined) throw new Error("semanticBlobStore: ifMatch is not supported");
      if (opts.ifNotExists && options.conditionalCreate === false) {
        throw new Error("semanticBlobStore: ifNotExists on a store without conditional create");
      }
      const no = refused("put");
      if (no) return Promise.resolve(no);
      const copy = new Uint8Array(bytes);
      if (cancelPending) {
        cancelPending = false;
        if (options.lateLanding) late.push([key, copy]);
        return Promise.resolve(
          fail(finding("process.cancelled", { message: `the put of ${key} was cancelled` })),
        );
      }
      if (opts.ifNotExists && data.has(key)) {
        return Promise.resolve(
          fail(finding("store.key-exists", { message: `${key} already exists`, paths: [key] })),
        );
      }
      remember(key);
      const half = copy.subarray(0, Math.floor(copy.length / 2));
      if (tearPending) {
        tearPending = false;
        data.set(key, new Uint8Array(half));
        return Promise.resolve(
          fail(finding("store.failed", { message: `the put of ${key} stopped part way (tearNext)` })),
        );
      }
      if (!options.tornWrites) {
        data.set(key, copy);
        return Promise.resolve(lostAck("put") ?? ok({}));
      }
      data.set(key, new Uint8Array(half));
      return (async () => {
        for (let i = 0; i < TORN_TICKS; i++) await tick();
        data.set(key, copy);
        return lostAck("put") ?? ok({});
      })();
    },
    delete: (key) => {
      assertBlobKey(key);
      const no = refused("delete");
      if (no) return Promise.resolve(no);
      data.delete(key);
      before.delete(key);
      return Promise.resolve(ok(undefined));
    },
  };
  if (options.rename) {
    store.rename = (from, to) => {
      assertBlobKey(from);
      assertBlobKey(to);
      const no = refused("rename");
      if (no) return Promise.resolve(no);
      const bytes = data.get(from);
      if (bytes === undefined) {
        return Promise.resolve(
          fail(finding("store.failed", { message: `cannot rename ${from}: it is not there`, paths: [from] })),
        );
      }
      remember(to);
      data.set(to, bytes);
      data.delete(from);
      before.delete(from);
      return Promise.resolve(lostAck("rename") ?? ok(undefined));
    };
  }
  return store;
};
