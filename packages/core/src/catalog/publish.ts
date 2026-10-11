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
import { z } from "zod";
import {
  assertBlobKey,
  assertBlobPrefix,
  type BlobStore,
  requireEligible,
  semanticValue,
} from "../ports/blob-store.ts";

/**
 * Whether the value at a key is the event a writer intends (the codec compares opened events; Task 11). A failure
 * says it cannot tell (the existing object does not open: another key, a damaged envelope) and is returned as is.
 */
export type SameEvent = (
  existing: Uint8Array,
  intended: Uint8Array,
) => Result<boolean> | Promise<Result<boolean>>;

/** Byte equality: the SameEvent of a plaintext catalog, and the fake the tests use. */
export const sameBytes: SameEvent = (a, b) => ok(a.length === b.length && a.every((x, i) => x === b[i]));

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
    const same = await input.sameEvent(existing.value, input.data);
    if (!same.ok) return { ...same, mayLand: false };
    return same.value ? ok({ written: false }) : { ...keyExists(input.key, name), mayLand: false };
  }
  const written = await store.put(input.key, input.data);
  if (written.ok) return ok({ written: true });
  // The acknowledgement may be all that was lost.
  const after = await store.get(input.key);
  if (after.ok && after.value !== null) {
    const same = await input.sameEvent(after.value, input.data);
    if (!same.ok) return { ...same, mayLand: true }; // cannot tell what is there: this write may be it
    return same.value ? ok({ written: true }) : { ...keyExists(input.key, name), mayLand: false };
  }
  const neverLate =
    after.ok && after.value === null && semanticValue(semantics.cancellation) === "never-lands-late";
  return { ...written, mayLand: !neverLate };
};

// --- The elected publication -------------------------------------------------------------------------------------

/**
 * One record of the candidate protocol (D99), at `<candidates><id>.json` (decision "candidate"), `<id>.publishing`
 * or `<id>.refused`. A record whose id or decision disagrees with its file name counts for nothing.
 */
export const ElectionRecordSchema = z
  .strictObject({
    v: z.literal(1),
    id: z.string().min(1),
    decision: z.enum(["candidate", "publishing", "refused"]),
  })
  .meta({
    title: "ElectionRecord",
    description:
      "A candidate's record in an elected publication (bootstrap, root claim): its candidacy or its decision",
  });
export type ElectionRecord = z.infer<typeof ElectionRecordSchema>;

/** The election records' JSON Schema, published in schemas/ by `bun run contract`. */
export const electionJsonSchemas = (): Record<"election-record", Record<string, unknown>> => ({
  "election-record": z.toJSONSchema(ElectionRecordSchema, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >,
});

export interface Election {
  /** The key the winner publishes, e.g. meta/v1/store.json. */
  key: string;
  /**
   * The prefix candidates are written under, ending in "/". Each attempt writes `<id>.json` (its candidacy), then
   * either `<id>.publishing` (it listed itself as the sole candidate and will publish) or `<id>.refused` (it saw
   * another candidate and will never publish).
   */
  candidates: string;
  /**
   * This attempt's id (a ULID); the published value names it. The caller journals it before calling elect, since the
   * candidacy is the first write, and recovery or a retry re-runs with that same id: only the same id can refuse or
   * publish for an attempt, so a fresh id would leave the old candidacy undecided for everyone. Letters, digits, "_"
   * and "-" only (no "/" or "."), so it cannot be mistaken for a key or a record's suffix.
   */
  id: string;
  /** What this attempt publishes when it wins; winnerOf(value) must be `id`. */
  value: Uint8Array;
  /** The attempt a published value names; undefined for bytes that name none (torn, damaged, foreign). */
  winnerOf(published: Uint8Array): string | undefined;
  /** The store's name, for messages. */
  store?: string;
  /** Waits between re-reads: the caller's scheduler (a timer in the CLI, a fake in tests). */
  wait(ms: number): Promise<void>;
  /**
   * The caller's crash seam right after each of this attempt's writes returns, whatever it returned: its candidacy,
   * its `.publishing` or `.refused`, and its publication. A caller journals around elect, so the crash matrix kills
   * the attempt here with the write landed and the journal before it (bootstrap's after-effect seams).
   */
  after?(write: ElectionWrite): void;
}

export type ElectionWrite = "candidacy" | "publishing" | "refusal" | "publication";

export type ElectionOutcome =
  | { outcome: "won" }
  /** A winner is published, and named. */
  | { outcome: "lost"; winner: string }
  /**
   * No winner is published and this attempt refuses: it will never publish (D99). `undecided` names visible
   * candidates without a refusal read back from the store; while any is left this is not final (re-run later: it ends
   * lost if one publishes). With none left, this attempt's own refusal included, every visible candidate refuses
   * (R2-7), nobody can win, and only the quiesced cleanup in `fix` helps. Final needs this device's profile to prove
   * list-after-write and complete listings; without them `undecided` keeps this attempt's own id, and `fix` says why.
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

const SUFFIX = { candidate: ".json", publishing: ".publishing", refused: ".refused" } as const;

const record = (id: string, decision: ElectionRecord["decision"]): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify({ v: 1, id, decision } satisfies ElectionRecord)}\n`);

/** The key of attempt `id`'s record `decision` under the candidates prefix `candidates`. */
export const electionKey = (candidates: string, id: string, decision: ElectionRecord["decision"]): string =>
  `${candidates}${id}${SUFFIX[decision]}`;

/** Whether `bytes` are the record `decision` of attempt `id` (a record that names another counts for nothing). */
export const isElectionRecord = (
  bytes: Uint8Array,
  id: string,
  decision: ElectionRecord["decision"],
): boolean => {
  try {
    const checked = ElectionRecordSchema.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    return checked.success && checked.data.id === id && checked.data.decision === decision;
  } catch {
    return false;
  }
};

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Throws RangeError on an election a caller got wrong: a bug, like a bad key. */
const assertElection = (e: Election): void => {
  assertBlobKey(e.key);
  assertBlobPrefix(e.candidates);
  if (!e.candidates.endsWith("/")) {
    throw new RangeError(`elect: candidates ${JSON.stringify(e.candidates)} must end in "/"`);
  }
  if (e.key.startsWith(e.candidates)) {
    throw new RangeError(
      `elect: the published key ${e.key} must not lie under the candidates ${e.candidates}`,
    );
  }
  if (!ID_PATTERN.test(e.id)) {
    throw new RangeError(`elect: the attempt id ${JSON.stringify(e.id)} must be letters, digits, "_" or "-"`);
  }
  if (e.winnerOf(e.value) !== e.id) {
    throw new RangeError(`elect: the value to publish does not name the attempt ${e.id}`);
  }
};

/**
 * Holds the election and, when this attempt wins, publishes its value. A store whose profile fails canElect refuses
 * with store.semantics-unknown before writing anything.
 *
 * One protocol for every device, whatever its own profile of the store (devices may have measured the store
 * differently): write the candidacy, list. As the sole candidate, write `<id>.publishing`, publish, read back.
 * Seeing another candidate, write `<id>.refused` and never publish; the outcome is lost if a winner turns up while
 * re-reading, else contested. Only the final write follows this device's profile: a conditional create where it
 * proves one, a plain put otherwise. A device with a proven conditional create still sees and respects every other
 * device's candidacy, so two devices taking different final writes never both win.
 *
 * Why contested can be final, where this device's profile proves list-after-write and complete listings: a candidate
 * written after this attempt's listing lists after this candidacy was acknowledged, so it sees it and refuses; so every attempt that could still be sole is visible here, and once each
 * has refused nobody can publish. An attempt that has refused, or whose `.publishing` was acknowledged, keeps that
 * decision when re-run (its recovery). A re-run of the same attempt (same id) is otherwise safe: the same keys, and a
 * published value naming it is a win.
 */
export const elect = async (store: BlobStore, e: Election): Promise<Result<ElectionOutcome>> => {
  assertElection(e);
  const name = e.store ?? "in use";
  const semantics = store.semantics();
  const allowed = requireEligible("elect", semantics, { store: name });
  if (!allowed.ok) return allowed;
  const conditional = semanticValue(semantics.conditionalCreate) === true;
  const listsAfterWrite = semanticValue(semantics.listAfterWrite) === true;
  // A final contested rests on listings: a later candidate lists after this one's candidacy and sees it. Without
  // list-after-write and complete listings proven, a lagging lister may still be sole (its conditional create still
  // bounds the winners to one), so a contested here is never final.
  const canProveFinal = listsAfterWrite && semanticValue(semantics.listComplete) === true;

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
      finding(
        "store.failed",
        semanticValue(semantics.readAfterWrite) === true
          ? {
              message: `the store ${name} did not show ${key} right after it was written, which its profile promises; nothing more was written`,
              fix: `the store ${name} does not behave as its semantics profile says; re-run, and if it happens again use another store for this`,
              paths: [key],
            }
          : {
              message: `the store ${name} does not show ${key} yet (its profile does not promise read-after-write); the election is not decided here`,
              fix: "re-run later: the election reads the published key first, and ends won or lost once it shows",
              paths: [key],
            },
      ),
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

  // The candidate protocol, the same on every device.
  const keyOf = (id: string, decision: ElectionRecord["decision"]): string =>
    electionKey(e.candidates, id, decision);
  /**
   * The candidates and their decisions. A candidacy counts by its name alone (more candidates only means more
   * refusals); a decision counts only when its record validates for that attempt, since recovery acts on it.
   */
  const listCandidates = async (): Promise<Result<Candidates>> => {
    const listed = await store.list(e.candidates);
    if (!listed.ok) return listed;
    const ids = new Set<string>();
    const refused = new Set<string>();
    const publishing = new Set<string>();
    for (const { key } of listed.value) {
      const rest = key.slice(e.candidates.length);
      if (rest.includes("/")) continue;
      for (const decision of ["candidate", "publishing", "refused"] as const) {
        const suffix = SUFFIX[decision];
        if (!rest.endsWith(suffix) || rest.length === suffix.length) continue;
        const id = rest.slice(0, -suffix.length);
        if (decision === "candidate") {
          ids.add(id);
          continue;
        }
        const bytes = await store.get(key);
        if (!bytes.ok) return bytes;
        if (bytes.value !== null && isElectionRecord(bytes.value, id, decision)) {
          (decision === "refused" ? refused : publishing).add(id);
        }
      }
    }
    return ok({ ids: [...ids].sort(), refused, publishing });
  };

  const candidacy = keyOf(e.id, "candidate");
  const written = await store.put(candidacy, record(e.id, "candidate"));
  e.after?.("candidacy");
  if (!written.ok) {
    const there = await store.get(candidacy);
    if (!there.ok || there.value === null) return written; // it may still land: a later election sees it, undecided
  }
  const listed = await listCandidates();
  if (!listed.ok) return listed;
  const mine = listed.value;
  if (!mine.ids.includes(e.id)) {
    // Promised by list-after-write; without it (a device electing on its conditional create alone) it may show later.
    if (listsAfterWrite) return notSeen(candidacy);
    mine.ids = [...mine.ids, e.id].sort();
  }
  const others = mine.ids.filter((id) => id !== e.id);

  // A decision already taken by this attempt stands; refusal wins, since a `.publishing` that failed is never acted on.
  const hasRefused = mine.refused.has(e.id);
  if (!hasRefused && (mine.publishing.has(e.id) || others.length === 0)) {
    if (!mine.publishing.has(e.id)) {
      const intent = await store.put(keyOf(e.id, "publishing"), record(e.id, "publishing"));
      e.after?.("publishing");
      if (!intent.ok) {
        const there = await store.get(keyOf(e.id, "publishing"));
        if (!there.ok || there.value === null || !isElectionRecord(there.value, e.id, "publishing"))
          return intent; // never publish on an intent nobody can see
      }
    }
    // The final write is this device's only route choice: create-only where its profile proves it.
    const publication = await store.put(e.key, e.value, conditional ? { ifNotExists: true } : {});
    e.after?.("publication");
    return afterWrite(publication);
  }

  if (!hasRefused) {
    // The refusal must be read back before anything is final (D99): a refusal that did not land leaves this attempt
    // free to act on a .publishing still in flight, so a failure here ends the run with the error, never contested.
    const refusal = await store.put(keyOf(e.id, "refused"), record(e.id, "refused"));
    e.after?.("refusal");
    const back = await store.get(keyOf(e.id, "refused"));
    if (!back.ok) return back;
    if (back.value === null || !isElectionRecord(back.value, e.id, "refused")) {
      return refusal.ok ? notSeen(keyOf(e.id, "refused")) : refusal;
    }
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
    // Final only when every visible candidate, this attempt included, has a refusal read back from the store, and
    // this device's profile proves the listings that argument rests on; otherwise this attempt stays undecided.
    undecided = candidates.filter((id) => !now.value.refused.has(id));
    if (!canProveFinal && undecided.length === 0) undecided = [e.id];
    if (undecided.length === 0) break;
    await e.wait(WAIT_MS);
  }
  const keys = candidates.flatMap((id) => [
    keyOf(id, "candidate"),
    keyOf(id, "refused"),
    keyOf(id, "publishing"),
  ]);
  const fix =
    !canProveFinal && undecided.length === 1 && undecided[0] === e.id
      ? `every visible candidate refuses, but this device's profile of the store ${name} does not prove list-after-write and complete listings, so another attempt this listing could not see may still be sole and win; re-run later with the same id (it ends lost if one won), and leave every candidate in ${e.candidates} where it is`
      : undecided.length > 0
        ? `another attempt (${undecided.join(", ")}) has not decided yet and may still publish; re-run later, and leave every candidate in ${e.candidates} where it is. Re-running an attempt with the same id (its recovery does) decides it. If an attempt will never run again (its device is gone), stop plainport on every device that uses the store ${name} and wait until none is running, then withdraw it by writing its refusal on its behalf (${undecided.map((id) => `${keyOf(id, "refused")} holding {"v":1,"id":"${id}","decision":"refused"}`).join("; ")}) and re-run`
        : `stop plainport on every device that uses the store ${name} and wait until none is running, then remove ${e.candidates}'s files (${keys.join(", ")}) from the store and re-run on one device; removing them while any plainport process runs can elect two winners`;
  return ok({ outcome: "contested", candidates, undecided, fix });
};
