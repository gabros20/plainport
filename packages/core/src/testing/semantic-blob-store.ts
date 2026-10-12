// The semantic fake (DESIGN.md "Remote stores: consistency and publication"): the memory store wrapped with a switch
// for each way a remote store can be weaker than a local disk, so the catalog, the elected publication and their
// callers are tested against every weakness before any adapter exists. The memory store holds the bytes and does
// the ordinary work (keys, create-only, failNext); the wrapper only adds the weakness switched on.
//
// - delayedVisibility: get and stat do not see a write (or its key's new value) until settle().
// - listOmitsRecent: a listing leaves out keys created since the last settle().
// - truncateListAt: a listing returns only its first n keys (a page the store forgot to follow).
// - tornWrites: a put is in place: readers see the first half of the bytes while it is written, and tearNext() stops
//   the next put there for good (a crash mid-write). With tempThenRename the put does what a temp-then-rename
//   adapter does (D98): the torn bytes go to its own temporary under TEMP_PREFIX, which is moved onto the key whole.
// - loseAckNext(): the next put lands, and the call fails (a lost acknowledgement).
// - cancelNext(): the next put is cancelled and fails; with lateLanding it lands at the next settle(), else never. A
//   late create-only put keeps its condition: it does not land on a key that exists by then.
//
// Its semantics() describe those switches honestly, unless `profile` is given: a test passes a profile that lies to
// show that the contract's probes (semanticViolations) catch the weakness.

import { fail, finding, ok, type Result } from "@plainport/contract";
import {
  assertBlobKey,
  type BlobStore,
  capabilitiesOf,
  type PutOptions,
  type StoreSemantics,
} from "../ports/blob-store.ts";
import { MEMORY_SEMANTICS, type MemoryBlobStore, memoryBlobStore } from "./memory-blob-store.ts";

/** Where the fake's temp-then-rename put keeps its temporaries (an adapter's reserved prefix, D98). */
export const FAKE_TEMP_PREFIX = "tmp/semantic-fake/";

export interface SemanticFakeOptions {
  delayedVisibility?: boolean;
  listOmitsRecent?: boolean;
  truncateListAt?: number;
  tornWrites?: boolean;
  /** With tornWrites: put() writes a temporary in place and moves it onto the key whole. */
  tempThenRename?: boolean;
  lateLanding?: boolean;
  /** Whether put(…, { ifNotExists }) is offered; true by default. */
  conditionalCreate?: boolean;
  durability?: "durable" | "acked-unsynced" | "unknown";
  /** What semantics() reports instead of the honest profile. */
  profile?: StoreSemantics;
}

type Method = "get" | "put" | "list" | "stat" | "delete";

export interface SemanticBlobStore extends BlobStore {
  /** The bytes each key holds now, whatever readers are shown (the memory store's). */
  readonly data: Map<string, Uint8Array>;
  /** Calls made to the fake, by method. */
  readonly calls: Record<Method, number>;
  /** Everything delayed becomes visible, and cancelled puts land when lateLanding is on. */
  settle(): void;
  /** The next `count` puts land, then fail with store.unreachable. */
  loseAckNext(count?: number): void;
  /** The next put fails with process.cancelled without landing now. */
  cancelNext(): void;
  /** The next put leaves the first half of its bytes and fails with store.failed. */
  tearNext(): void;
  /** The next call of `method` fails with `code` and does nothing (the memory store's failNext). */
  failNext(method: Method, code?: "store.unreachable" | "store.failed"): void;
}

const honestProfile = (options: SemanticFakeOptions): StoreSemantics => ({
  ...MEMORY_SEMANTICS,
  readAfterWrite: { value: !options.delayedVisibility, evidence: "asserted" },
  listAfterWrite: { value: !options.listOmitsRecent, evidence: "asserted" },
  listComplete: { value: options.truncateListAt === undefined, evidence: "asserted" },
  publication: {
    value: !options.tornWrites ? "atomic-put" : options.tempThenRename ? "temp-then-rename" : "in-place",
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
  const inner: MemoryBlobStore = memoryBlobStore({ createIfAbsent: options.conditionalCreate ?? true });
  const data = inner.data;
  /** Keys written since the last settle(), with the value readers saw before (null: the key did not exist). */
  const before = new Map<string, Uint8Array | null>();
  const late: { key: string; bytes: Uint8Array; opts: PutOptions }[] = [];
  const calls: Record<Method, number> = { get: 0, put: 0, list: 0, stat: 0, delete: 0 };
  let lostAcks = 0;
  let cancelPending = false;
  let tearPending = false;
  let temporaries = 0;

  const lostAck = (): Result<never> | undefined => {
    if (lostAcks === 0) return undefined;
    lostAcks--;
    return fail(
      finding("store.unreachable", { message: "the semantic fake lost the acknowledgement of a put" }),
    );
  };
  /** Records what readers saw of `key` before a write that landed (old: its value then, null when absent). */
  const remember = (key: string, old: Uint8Array | null): void => {
    if (!before.has(key)) before.set(key, old);
  };
  /** Whether readers are still shown the old value of `key`. */
  const hidden = (key: string): boolean => options.delayedVisibility === true && before.has(key);
  const exists = (key: string): Result<never> =>
    fail(finding("store.key-exists", { message: `${key} already exists`, paths: [key] }));

  /** A torn put: half the bytes in place (at the key, or at a temporary moved on whole), then the rest. */
  const tornPut = async (
    key: string,
    bytes: Uint8Array,
    opts: PutOptions,
  ): Promise<Result<{ etag?: string }>> => {
    const target = options.tempThenRename ? `${FAKE_TEMP_PREFIX}${++temporaries}` : key;
    const half = bytes.subarray(0, Math.floor(bytes.length / 2));
    const old = data.get(key) ?? null;
    const started = await inner.put(target, half, target === key ? opts : {});
    if (!started.ok) return started;
    if (target === key) remember(key, old);
    if (tearPending) {
      tearPending = false;
      return fail(finding("store.failed", { message: `the put of ${key} stopped part way (tearNext)` }));
    }
    for (let i = 0; i < TORN_TICKS; i++) await tick();
    if (target === key) {
      data.set(key, bytes);
    } else {
      data.delete(target);
      if (opts.ifNotExists && data.has(key)) return exists(key);
      remember(key, data.get(key) ?? null);
      data.set(key, bytes);
    }
    return lostAck() ?? ok({});
  };

  return {
    data,
    calls,
    settle: () => {
      before.clear();
      for (const { key, bytes, opts } of late.splice(0)) {
        if (!(opts.ifNotExists && data.has(key))) data.set(key, bytes);
      }
    },
    loseAckNext: (count = 1) => {
      lostAcks += count;
    },
    cancelNext: () => {
      cancelPending = true;
    },
    tearNext: () => {
      tearPending = true;
    },
    failNext: (method, code) => inner.failNext(method, code),
    semantics: () => semantics,
    capabilities: () => capabilitiesOf(semantics),
    get: async (key) => {
      calls.get++;
      const got = await inner.get(key);
      if (!got.ok || !hidden(key)) return got;
      const shown = before.get(key);
      return ok(shown == null ? null : new Uint8Array(shown));
    },
    stat: async (key) => {
      calls.stat++;
      const got = await inner.stat(key);
      if (!got.ok || !hidden(key)) return got;
      const shown = before.get(key);
      return ok(shown == null ? null : { size: shown.length });
    },
    list: async (prefix) => {
      calls.list++;
      const listed = await inner.list(prefix);
      if (!listed.ok) return listed;
      let entries = listed.value.filter(
        (entry) => !(options.listOmitsRecent && before.get(entry.key) === null),
      );
      if (options.truncateListAt !== undefined) entries = entries.slice(0, options.truncateListAt);
      return ok(entries);
    },
    put: (key, bytes, opts: PutOptions = {}) => {
      assertBlobKey(key);
      calls.put++;
      const copy = new Uint8Array(bytes);
      if (cancelPending) {
        cancelPending = false;
        if (options.lateLanding) late.push({ key, bytes: copy, opts });
        return Promise.resolve(
          fail(finding("process.cancelled", { message: `the put of ${key} was cancelled` })),
        );
      }
      if (opts.ifNotExists && data.has(key)) return Promise.resolve(exists(key));
      if (options.tornWrites) return tornPut(key, copy, opts);
      // Only a put that landed changes what readers are shown later (delayed visibility pins the old value). The
      // memory store writes within the call, so whether it landed is known before anyone else can read; and it stores
      // a fresh copy of the bytes on every write, so a changed reference means a write landed, even of equal bytes.
      const held = data.get(key);
      const landed = (): void => {
        if (data.get(key) !== held) remember(key, held ?? null);
      };
      if (tearPending) {
        tearPending = false;
        const started = inner.put(key, copy.subarray(0, Math.floor(copy.length / 2)), opts);
        landed();
        return started.then((result) =>
          result.ok
            ? fail(finding("store.failed", { message: `the put of ${key} stopped part way (tearNext)` }))
            : result,
        );
      }
      const put = inner.put(key, copy, opts);
      landed();
      return put.then((result) => (result.ok ? (lostAck() ?? result) : result));
    },
    delete: async (key) => {
      calls.delete++;
      const deleted = await inner.delete(key);
      if (deleted.ok) before.delete(key);
      return deleted;
    },
  };
};
