// Publication on a store (DESIGN.md "Remote stores: consistency and publication"): how a value reaches a key whole,
// and the elected publication that bootstrap and the root claim share (Q9).
//
// An event is published whole: an `atomic-put` store takes a plain put of the key; a `temp-then-rename` store takes
// the bytes at `meta/v1/tmp/<op>-<nonce>` and a rename onto the key, so no torn key is ever visible under
// `meta/v1/events/`. A temporary left by a failure is swept only by its own operation's recovery (sweepTemporaries).
//
// An event key is a fresh ULID from its one writer, so nobody else writes it. A write's acknowledgement can be lost,
// so a publish reads the key first and compares what is there through the injected SameEvent (R2-8): the same event
// already published is a no-op, so a retry gives one event, not two. A put that failed is read back: there, it
// landed; absent on a store that never lands a put late, it never will; otherwise it counts as possibly landed.

import { type Failure, fail, finding, type Ok, ok, type Result } from "@plainport/contract";
import { type BlobStore, requireEligible, semanticValue } from "../ports/blob-store.ts";

/** Where temporaries go: `<op>-<nonce>` under it. */
export const TEMP_PREFIX = "meta/v1/tmp/";

/** Whether the value at a key is the event a writer intends (the codec compares opened events; Task 11). */
export type SameEvent = (existing: Uint8Array, intended: Uint8Array) => boolean | Promise<boolean>;

/** Byte equality: the SameEvent of a plaintext catalog, and the fake the tests use. */
export const sameBytes: SameEvent = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const randomNonce = (): string =>
  [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");

export const temporaryKey = (op: string, nonce: string): string => `${TEMP_PREFIX}${op}-${nonce}`;

export interface PublishContext {
  /** The operation the write belongs to; it names the temporaries. */
  op: string;
  /** The store's name, for messages. */
  store?: string;
  /** The temporary's nonce; random by default. */
  nonce?: () => string;
}

/** Writes `data` at `key` whole, as the store's publication allows; no read first. */
const writeWhole = async (
  store: BlobStore,
  key: string,
  data: Uint8Array,
  context: PublishContext,
): Promise<Result<void>> => {
  const publication = semanticValue(store.semantics().publication);
  if (publication === "atomic-put") {
    const put = await store.put(key, data);
    return put.ok ? ok(undefined) : put;
  }
  if (publication !== "temp-then-rename" || store.rename === undefined) {
    throw new Error(`publish: ${key} cannot be written whole on this store; check canAppend first`);
  }
  const temporary = temporaryKey(context.op, (context.nonce ?? randomNonce)());
  const put = await store.put(temporary, data);
  if (!put.ok) return put;
  return store.rename(temporary, key);
};

const keyExists = (key: string, store: string): Failure =>
  fail(
    finding("store.key-exists", {
      message: `${key} in the store ${store} holds another event under this event's id; it was left as it was`,
      fix: "this is a bug in the command that wrote the event (event ids are fresh ULIDs); report it, and keep the file",
      paths: [key],
    }),
  );

export type PublishFailure = Failure & {
  /** The write may still land: a reader may find the event later, so the caller must not act as if it never will. */
  mayLand: boolean;
};

/**
 * Publishes one event whole at `key`, after reading what is there: the same event (by `sameEvent`) is a no-op
 * (written: false), another is store.key-exists. A store whose profile cannot append refuses with
 * store.semantics-unknown before anything is written.
 */
export const publishEvent = async (
  store: BlobStore,
  input: PublishContext & { key: string; data: Uint8Array; sameEvent: SameEvent },
): Promise<Ok<{ written: boolean }> | PublishFailure> => {
  const name = input.store ?? "in use";
  const semantics = store.semantics();
  const allowed = requireEligible("append", semantics, { store: name });
  if (!allowed.ok) return { ...allowed, mayLand: false };
  const existing = await store.get(input.key);
  if (!existing.ok) return { ...existing, mayLand: false };
  if (existing.value !== null) {
    return (await input.sameEvent(existing.value, input.data))
      ? ok({ written: false })
      : { ...keyExists(input.key, name), mayLand: false };
  }
  const written = await writeWhole(store, input.key, input.data, input);
  if (written.ok) return ok({ written: true });
  // The acknowledgement may be all that was lost.
  const after = await store.get(input.key);
  if (after.ok && after.value !== null && (await input.sameEvent(after.value, input.data))) {
    return ok({ written: true });
  }
  const neverLate =
    after.ok && after.value === null && semanticValue(semantics.cancellation) === "never-lands-late";
  return { ...written, mayLand: !neverLate };
};

/** Removes the temporaries `op` left; only that operation's recovery calls it. */
export const sweepTemporaries = async (
  store: BlobStore,
  op: string,
): Promise<Result<{ removed: string[] }>> => {
  const listed = await store.list(`${TEMP_PREFIX}${op}-`);
  if (!listed.ok) return listed;
  const removed: string[] = [];
  for (const { key } of listed.value) {
    const deleted = await store.delete(key);
    if (!deleted.ok) return deleted;
    removed.push(key);
  }
  return ok({ removed });
};

// --- The elected publication -------------------------------------------------------------------------------------

export interface Election {
  /** The key the winner publishes, e.g. meta/v1/store.json. */
  key: string;
  /** The prefix candidates are written under, ending in "/": `<candidates><id>.json`. */
  candidates: string;
  /** This attempt's id (a ULID); the published value names it. */
  id: string;
  /** The operation the attempt belongs to; it names temporaries. */
  op: string;
  /** What this attempt publishes when it wins. */
  value: Uint8Array;
  /** The attempt a published value names; undefined for bytes that name none (torn, damaged, foreign). */
  winnerOf(published: Uint8Array): string | undefined;
  /** The candidate's bytes; `{"v":1,"id":<id>}` by default. Only its name counts. */
  candidate?: Uint8Array;
  /** The store's name, for messages. */
  store?: string;
  /** Waits between re-reads; a timer by default. */
  wait?: (ms: number) => Promise<void>;
}

export type ElectionOutcome =
  | { outcome: "won" }
  /** A winner is published, and named. */
  | { outcome: "lost"; winner: string }
  /** No winner: every visible candidate refuses. Safe and expected (R2-7); the fix is the quiesced cleanup. */
  | { outcome: "contested"; candidates: string[]; fix: string };

/** How often a published value is read while it is unreadable or not there yet, and the wait between reads. */
const READS = 5;
const WAIT_MS = 200;

type Published = { kind: "absent" } | { kind: "winner"; winner: string } | { kind: "unreadable" };

/**
 * Holds the election and, when this attempt wins, publishes its value. Routes: a conditional create of the key where
 * the profile proves one; otherwise the sole-candidate rule: write a candidate, list the candidates, and publish only
 * as the sole candidate (or when the published key already names this attempt), then read back. A store whose
 * profile cannot elect or append refuses with store.semantics-unknown before writing anything.
 *
 * A re-run of the same attempt (same id) is safe: its candidate is the same key, and a published value naming it is
 * a win.
 */
export const elect = async (store: BlobStore, e: Election): Promise<Result<ElectionOutcome>> => {
  const name = e.store ?? "in use";
  const semantics = store.semantics();
  for (const op of ["elect", "append"] as const) {
    const allowed = requireEligible(op, semantics, { store: name });
    if (!allowed.ok) return allowed;
  }
  const wait = e.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  const readPublished = async (): Promise<Result<Published>> => {
    const got = await store.get(e.key);
    if (!got.ok) return got;
    if (got.value === null) return ok({ kind: "absent" });
    const winner = e.winnerOf(got.value);
    return ok(winner === undefined ? { kind: "unreadable" } : { kind: "winner", winner });
  };
  /** The published value once it settles: one still being written in place is read again, READS times in all. */
  const settled = async (): Promise<Result<Published>> => {
    let found = await readPublished();
    for (let reads = 1; found.ok && found.value.kind === "unreadable" && reads < READS; reads++) {
      await wait(WAIT_MS);
      found = await readPublished();
    }
    return found;
  };
  const decided = (winner: string): Result<ElectionOutcome> =>
    ok(winner === e.id ? { outcome: "won" } : { outcome: "lost", winner });
  const unreadable = (): Failure =>
    fail(
      finding("store.failed", {
        message: `${e.key} in the store ${name} names no attempt (empty, partial or damaged); nothing was published`,
        fix: `wait for any plainport process using this store to finish, then re-run; if it stays like this, check ${e.key} in the store`,
        paths: [e.key],
      }),
    );
  const notSeen = (key: string): Failure =>
    fail(
      finding("store.failed", {
        message: `the store ${name} did not show ${key} right after it was written, which its profile promises; nothing more was written`,
        fix: `the store ${name} does not behave as its semantics profile says; re-run, and if it happens again use another store for this`,
        paths: [key],
      }),
    );
  /** After the write: the published value names the winner, or the write failed / is not seen. */
  const afterWrite = async (write: Result<unknown>): Promise<Result<ElectionOutcome>> => {
    const found = await settled();
    if (found.ok && found.value.kind === "winner") return decided(found.value.winner);
    if (!write.ok && !(write.finding.code === "store.key-exists")) return write;
    if (!found.ok) return found;
    return found.value.kind === "unreadable" ? unreadable() : notSeen(e.key);
  };

  const first = await settled();
  if (!first.ok) return first;
  if (first.value.kind === "winner") return decided(first.value.winner);
  if (first.value.kind === "unreadable") return unreadable();

  if (semanticValue(semantics.conditionalCreate) === true) {
    return afterWrite(await store.put(e.key, e.value, { ifNotExists: true }));
  }

  // The sole-candidate rule.
  const candidateKey = `${e.candidates}${e.id}.json`;
  const candidate = e.candidate ?? new TextEncoder().encode(`${JSON.stringify({ v: 1, id: e.id })}\n`);
  const written = await writeWhole(store, candidateKey, candidate, { op: e.op });
  if (!written.ok) {
    const there = await store.get(candidateKey);
    if (!there.ok || there.value === null) return written; // it may still land: a later election sees it, and is contested
  }
  const listed = await store.list(e.candidates);
  if (!listed.ok) return listed;
  const ids = listed.value
    .map(({ key }) => key.slice(e.candidates.length))
    .filter((rest) => rest.endsWith(".json") && !rest.includes("/"))
    .map((rest) => rest.slice(0, -".json".length))
    .sort();
  if (!ids.includes(e.id)) return notSeen(candidateKey);
  if (ids.length > 1) {
    // Another candidate is visible: refuse, unless a winner turns up while re-reading.
    for (let reads = 0; reads < READS; reads++) {
      await wait(WAIT_MS);
      const found = await readPublished();
      if (!found.ok) return found;
      if (found.value.kind === "winner") return decided(found.value.winner);
    }
    const keys = ids.map((id) => `${e.candidates}${id}.json`);
    return ok({
      outcome: "contested",
      candidates: ids,
      fix: `stop plainport on every device that uses the store ${name} and wait until none is running, then remove the candidates ${keys.join(", ")} from the store and re-run on one device; removing them while any plainport process runs can elect two winners`,
    });
  }
  return afterWrite(await writeWhole(store, e.key, e.value, { op: e.op }));
};
