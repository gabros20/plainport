// Publication on a store (DESIGN.md "Remote stores: consistency and publication"): how an event reaches its key
// whole, and the elected publication that bootstrap and the root claim share (Q9).
//
// The port's put() is a whole, replacing write on every store that passes `append` (D98): an `atomic-put` backend shows
// an object only when complete, and a `temp-then-rename` adapter uploads to its own temporary and moves it onto the
// key inside put(). Core uses put() and conditional create only, and never sees a temporary.
//
// An event key is a fresh ULID from its one writer, so nobody else writes it. A write's acknowledgement can be lost,
// so a publish reads the key first and compares what is there through the injected SameEvent (R2-8): the same event
// already published is a no-op, so a retry gives one event, not two. A put that failed is read back: there, it
// landed; absent on a store that never lands a put late, it never will; otherwise it counts as possibly landed.

import { type Failure, fail, finding, type Ok, ok, type Result } from "@plainport/contract";
import { type BlobStore, requireEligible, semanticValue } from "../ports/blob-store.ts";

/** Whether the value at a key is the event a writer intends (the codec compares opened events; Task 11). */
export type SameEvent = (existing: Uint8Array, intended: Uint8Array) => boolean | Promise<boolean>;

/** Byte equality: the SameEvent of a plaintext catalog, and the fake the tests use. */
export const sameBytes: SameEvent = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

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
  input: { key: string; data: Uint8Array; sameEvent: SameEvent; store?: string },
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
  const written = await store.put(input.key, input.data);
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

// --- The elected publication -------------------------------------------------------------------------------------

export interface Election {
  /** The key the winner publishes, e.g. meta/v1/store.json. */
  key: string;
  /**
   * The prefix candidates are written under, ending in "/". Each attempt writes `<id>.json` (its candidacy), then
   * either `<id>.publishing` (it listed itself as the sole candidate and will publish) or `<id>.refused` (it saw
   * another candidate and will never publish).
   */
  candidates: string;
  /** This attempt's id (a ULID); the published value names it. */
  id: string;
  /** What this attempt publishes when it wins. */
  value: Uint8Array;
  /** The attempt a published value names; undefined for bytes that name none (torn, damaged, foreign). */
  winnerOf(published: Uint8Array): string | undefined;
  /** The store's name, for messages. */
  store?: string;
  /** Waits between re-reads: the caller's scheduler (a timer in the CLI, a fake in tests). */
  wait(ms: number): Promise<void>;
}

export type ElectionOutcome =
  | { outcome: "won" }
  /** A winner is published, and named. */
  | { outcome: "lost"; winner: string }
  /**
   * No winner is published and this attempt refuses: it will never publish. `undecided` names visible candidates
   * that have not refused; while any is left this is not final (re-run later: it ends lost if one publishes). With
   * none left every visible candidate refuses (R2-7), nobody can win, and only the quiesced cleanup in `fix` helps.
   */
  | { outcome: "contested"; candidates: string[]; undecided: string[]; fix: string };

/** How often the published value or the candidates are read again, and the wait between reads. */
const READS = 5;
const WAIT_MS = 200;

type Published = { kind: "absent" } | { kind: "winner"; winner: string } | { kind: "unreadable" };

interface Candidates {
  /** Every attempt with a candidacy, sorted. */
  ids: string[];
  refused: Set<string>;
  publishing: Set<string>;
}

const CANDIDACY = ".json";
const REFUSED = ".refused";
const PUBLISHING = ".publishing";

const marker = (bytes: string): Uint8Array => new TextEncoder().encode(`${bytes}\n`);

/**
 * Holds the election and, when this attempt wins, publishes its value. A store whose profile fails canElect refuses
 * with store.semantics-unknown before writing anything.
 *
 * - Where conditional create is proven, the value is created conditionally and read back.
 * - Otherwise (the sole-candidate rule, on a store with visibility both ways and complete listings): write the
 *   candidacy, list. As the sole candidate, write `<id>.publishing`, publish, read back. Seeing another candidate,
 *   write `<id>.refused` and never publish; the outcome is lost if a winner turns up while re-reading, else contested.
 *
 * Why contested can be final: a candidate written after this attempt's listing lists after this candidacy was
 * acknowledged, so it sees it and refuses; so every attempt that could still be sole is visible here, and once each
 * has refused nobody can publish. An attempt that has refused, or whose `.publishing` was acknowledged, keeps that
 * decision when re-run (its recovery). A re-run of the same attempt (same id) is otherwise safe: the same keys, and a
 * published value naming it is a win.
 */
export const elect = async (store: BlobStore, e: Election): Promise<Result<ElectionOutcome>> => {
  const name = e.store ?? "in use";
  const semantics = store.semantics();
  const allowed = requireEligible("elect", semantics, { store: name });
  if (!allowed.ok) return allowed;

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
      await e.wait(WAIT_MS);
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
  /** After the publishing write: the published value names the winner, or the write failed / is not seen. */
  const afterWrite = async (write: Result<unknown>): Promise<Result<ElectionOutcome>> => {
    const found = await settled();
    if (found.ok && found.value.kind === "winner") return decided(found.value.winner);
    if (!write.ok && write.finding.code !== "store.key-exists") return write;
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
  const keyOf = (id: string, suffix: string): string => `${e.candidates}${id}${suffix}`;
  const listCandidates = async (): Promise<Result<Candidates>> => {
    const listed = await store.list(e.candidates);
    if (!listed.ok) return listed;
    const ids = new Set<string>();
    const refused = new Set<string>();
    const publishing = new Set<string>();
    for (const { key } of listed.value) {
      const rest = key.slice(e.candidates.length);
      if (rest.includes("/")) continue;
      for (const [suffix, into] of [
        [CANDIDACY, ids],
        [REFUSED, refused],
        [PUBLISHING, publishing],
      ] as const) {
        if (rest.endsWith(suffix) && rest.length > suffix.length) into.add(rest.slice(0, -suffix.length));
      }
    }
    return ok({ ids: [...ids].sort(), refused, publishing });
  };

  const candidacy = keyOf(e.id, CANDIDACY);
  const written = await store.put(candidacy, marker(JSON.stringify({ v: 1, id: e.id })));
  if (!written.ok) {
    const there = await store.get(candidacy);
    if (!there.ok || there.value === null) return written; // it may still land: a later election sees it, undecided
  }
  const listed = await listCandidates();
  if (!listed.ok) return listed;
  const mine = listed.value;
  if (!mine.ids.includes(e.id)) return notSeen(candidacy);
  const others = mine.ids.filter((id) => id !== e.id);

  // A decision already taken by this attempt stands; refusal wins, since a `.publishing` that failed is never acted on.
  const hasRefused = mine.refused.has(e.id);
  if (!hasRefused && (mine.publishing.has(e.id) || others.length === 0)) {
    if (!mine.publishing.has(e.id)) {
      const intent = await store.put(keyOf(e.id, PUBLISHING), marker(JSON.stringify({ v: 1, id: e.id })));
      if (!intent.ok) {
        const there = await store.get(keyOf(e.id, PUBLISHING));
        if (!there.ok || there.value === null) return intent; // never publish on an intent nobody can see
      }
    }
    return afterWrite(await store.put(e.key, e.value));
  }

  if (!hasRefused) {
    // Best effort: a refusal that does not land leaves this attempt undecided to others, which only delays them.
    await store.put(keyOf(e.id, REFUSED), marker(JSON.stringify({ v: 1, id: e.id })));
  }
  let undecided: string[] = others;
  let candidates = mine.ids;
  for (let reads = 0; reads < READS; reads++) {
    const found = await readPublished();
    if (!found.ok) return found;
    if (found.value.kind === "winner") return decided(found.value.winner);
    const now = await listCandidates();
    if (!now.ok) return now;
    candidates = now.value.ids;
    undecided = candidates.filter((id) => id !== e.id && !now.value.refused.has(id));
    if (undecided.length === 0) break;
    await e.wait(WAIT_MS);
  }
  const keys = candidates.flatMap((id) => [keyOf(id, CANDIDACY), keyOf(id, REFUSED), keyOf(id, PUBLISHING)]);
  const fix =
    undecided.length > 0
      ? `another attempt (${undecided.join(", ")}) has not decided yet and may still publish; re-run later, and leave every candidate in ${e.candidates} where it is`
      : `stop plainport on every device that uses the store ${name} and wait until none is running, then remove ${e.candidates}'s files (${keys.join(", ")}) from the store and re-run on one device; removing them while any plainport process runs can elect two winners`;
  return ok({ outcome: "contested", candidates, undecided, fix });
};
