// Bootstrap (DESIGN.md "Bootstrap", Q9, Q10, D99): setting a store up is exclusive and recoverable. Two devices running
// `restic init` at one location can leave two master keys in one repository, so no attempt ever shares a location:
//
//   1. journal bootstrap.begin with a fresh attempt id (a ULID), before anything is written to the store;
//   2. restic init at repos/<attempt>/, this attempt's own repository, with this device's password;
//   3. journal bootstrap.elect.start, then stand in the elected publication of meta/v1/store.json (publish.ts elect,
//      candidates under meta/v1/store-claims/): write the candidacy, list, and only as the sole candidate
//   4. publish store.json v2 { v: 2, id: <attempt>, repo: repos/<attempt>, catalog: { seal }, format: 2 },
//   5. read it back (elect's read-back), journal bootstrap.published,
//   6. record the id under the store's name in this device's registry.json (the D85 pin), and close the journal.
//
// The election ends won (published, as above), lost (another attempt published first: store.bootstrap-lost names it;
// this attempt records nothing and never touches the winner's repository) or contested (no winner, and this attempt
// refused): final when every visible candidate's refusal is read back (store.bootstrap-contested, the quiesced cleanup),
// undecided while one may still publish (store.bootstrap-undecided: the journal stays, and a re-run decides it with the
// same id). A losing or contested attempt writes nothing after its candidacy but its own refusal (D99), and its
// repository stays for `store test` to list; plainport never deletes a repository.
//
// A store that already has a store.json is adopted instead, without an election and without writing to it: its
// published repository (repos/<id> for format 2, repo/ for an M1 store) must open with this device's password before
// the id is recorded. A name already pinned to an id only ever reaches that same store (D85).
//
// Recovery (recoverBootstraps, or a re-run of the setup, which resumes the open attempt) routes by BOOTSTRAP_RECOVERY:
//
//   bootstrap.begin, bootstrap.initialised   candidacy-check: the store's store.json names this attempt (a lost journal
//                                           write, D24): record it; its candidacy is on the store: re-elect; otherwise
//                                           roll back (nothing published; a repository made is left)
//   bootstrap.elect.start                   re-elect with the journaled id: won, record; lost; contested; or pending
//                                           (undecided, or the store did not answer)
//   bootstrap.published                     record: read store.json back, check it names this attempt, record the id
//
// A resumed or recovered attempt first checks that its store's name still reaches the location it began on (journaled at
// bootstrap.begin), and refuses with store.identity-changed otherwise, writing nothing there.
//
// The attempt id is the only thing a re-run needs: the repository's location, the candidacy, the value published and
// the store's id all derive from it. A publication torn in place by a crash (a linkless volume, D41) is completed only by
// its own attempt's recovery, when the torn bytes already name it and its `.publishing` record stands.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { type Failure, type Finding, fail, failWith, finding, ok, type Result } from "@plainport/contract";
import {
  encodeStoreIdentityV2,
  identityChanged,
  parseStoreIdentity,
  readStoreDescriptor,
  type SealPolicy,
  STORE_CLAIMS_PREFIX,
  STORE_IDENTITY_KEY,
  type StoreDescriptor,
} from "../catalog/identity.ts";
import { type ElectionWrite, elect, electionKey, isElectionRecord } from "../catalog/publish.ts";
import { assertSystemError, type LocalIo } from "../io.ts";
import {
  type BootstrapJournal,
  bootstrapJournalFile,
  readBootstrapJournals,
  removeBootstrapJournal,
  writeBootstrapJournal,
} from "../journal/index.ts";
import { acquireLock } from "../lock.ts";
import type { PlainportPaths } from "../paths.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { Engine } from "../ports/engine.ts";
import { readRegistry, updateRegistry } from "../registry.ts";
import { ulid } from "../ulid.ts";
import { withFix, writeFailed } from "./journaled.ts";

export const BOOTSTRAP_STEPS = [
  "bootstrap.begin",
  "bootstrap.initialised",
  "bootstrap.elect.start",
  "bootstrap.published",
] as const;
export type BootstrapStep = (typeof BOOTSTRAP_STEPS)[number];

/**
 * The crash seams right after a side effect, with no journal write (D52), and the step each follows: a fault there
 * leaves the effect done and the journal at that step.
 */
export const BOOTSTRAP_AFTER_EFFECT = {
  "bootstrap.init.done": "bootstrap.begin",
  "bootstrap.candidacy.written": "bootstrap.elect.start",
  "bootstrap.publishing.written": "bootstrap.elect.start",
  "bootstrap.refusal.written": "bootstrap.elect.start",
  "bootstrap.publication.written": "bootstrap.elect.start",
  "bootstrap.recorded": "bootstrap.published",
} as const satisfies Record<string, BootstrapStep>;
export type BootstrapAfterEffect = keyof typeof BOOTSTRAP_AFTER_EFFECT;

const SEAM_OF: Readonly<Record<ElectionWrite, BootstrapAfterEffect>> = {
  candidacy: "bootstrap.candidacy.written",
  publishing: "bootstrap.publishing.written",
  refusal: "bootstrap.refusal.written",
  publication: "bootstrap.publication.written",
};

/** Points a plain run (alone on the store) does not reach, and what reaching them needs. */
export const BOOTSTRAP_BRANCHES = {
  rival: {
    when: "another attempt's candidacy is visible when this one lists, so this one refuses",
    reaches: ["bootstrap.refusal.written"],
  },
} as const satisfies Record<string, { when: string; reaches: readonly string[] }>;

/**
 * How recovery settles a bootstrap journal at a step (D64), the table of the file comment. A step missing here (a later
 * version's) is pending, never routed by default.
 */
export type BootstrapRule = "candidacy-check" | "re-elect" | "record";

export const BOOTSTRAP_RECOVERY = {
  "bootstrap.begin": "candidacy-check",
  "bootstrap.initialised": "candidacy-check",
  "bootstrap.elect.start": "re-elect",
  "bootstrap.published": "record",
} as const satisfies Record<BootstrapStep, BootstrapRule>;

/**
 * What recovery did with one attempt. published: this attempt's store.json is on the store and its id recorded here.
 * lost: another attempt published first. contested: no winner, every visible candidate refuses (final). rolled-back:
 * its candidacy never reached the store, so nothing was published. pending: not settled now (undecided, a store that
 * did not answer, a lock held); the journal stays and the finding says why.
 */
export const BOOTSTRAP_RECOVERY_OUTCOMES = [
  "published",
  "lost",
  "contested",
  "rolled-back",
  "pending",
] as const;
export type BootstrapRecoveryOutcome = (typeof BOOTSTRAP_RECOVERY_OUTCOMES)[number];

/** The outcomes each rule may reach, for the crash matrix to check a settled attempt against. */
export const BOOTSTRAP_RULE_OUTCOMES: Readonly<Record<BootstrapRule, readonly BootstrapRecoveryOutcome[]>> = {
  "candidacy-check": ["rolled-back", "published", "lost", "contested", "pending"],
  "re-elect": ["published", "lost", "contested", "pending"],
  record: ["published", "pending"],
};

export interface BootstrapPorts {
  io: LocalIo;
  paths: PlainportPaths;
  /** The host's crash seam, reached at every journal step and after-effect seam. */
  faultAt(point: string): void;
  clock(): Date;
  log(level: "info" | "warn", message: string): void;
  /** Waits between the election's re-reads: a timer in the CLI, a fake in tests. */
  wait(ms: number): Promise<void>;
}

/** The store being set up: its metadata layer, and its restic repository at a location under its root. */
export interface BootstrapStore {
  blob: BlobStore;
  /**
   * Where the store is, as config resolves it (a local path, an sftp: or s3: location), never a secret. It is journaled
   * at bootstrap.begin, and a resumed or recovered attempt refuses (store.identity-changed) when the name now reaches
   * another location: its repository was made there, and publishing it anywhere else would name a repository the store
   * does not have.
   */
  location: string;
  /** An engine bound to the repository at `repo` (relative to the store's root) and this device's password. */
  engineAt(repo: string): Engine;
}

export interface BootstrapTarget {
  /** The store's name in config. */
  name: string;
  /** The catalog's seal policy to publish if this attempt wins (Q10). */
  seal: SealPolicy;
}

export type BootstrapDone =
  /** This attempt won the election: its store.json is published and its id recorded on this device. */
  | { outcome: "published"; id: string; repo: string; format: 2 }
  /** The store was set up already: its repository opened with this device's password, and its id is recorded. */
  | { outcome: "adopted"; id: string; repo: string; format: 1 | 2 };

export interface RecoveredBootstrap {
  attempt: string;
  /** The store's name in config. */
  store: string;
  /** The journal step recovery found. */
  step: string;
  outcome: BootstrapRecoveryOutcome;
  /** published, lost: the published store's id. */
  id?: string;
  /** Why it is not published: lost, contested or pending's finding. */
  finding?: Finding;
}

export interface BootstrapRecoveryReport {
  operations: RecoveredBootstrap[];
  /** Bootstrap journal files this version cannot read: never touched. */
  unreadable: string[];
}

/** One attempt's settlement: its outcome, and the failure behind it when it published nothing. */
type Settled =
  | { outcome: "published"; id: string; repo: string }
  | { outcome: "rolled-back" }
  | { outcome: "lost"; winner: string; problem: Failure }
  | { outcome: "contested" | "pending"; problem: Failure };
/** An election's settlement: it never rolls back, since its candidacy may be on the store. */
type Elected = Exclude<Settled, { outcome: "rolled-back" }>;

/** `locks/bootstrap-<the first 32 hex digits of the name's SHA-256>.lock`: one length whatever the store's name. */
const lockFile = (paths: PlainportPaths, name: string): string =>
  join(
    paths.locksDir,
    `bootstrap-${createHash("sha256").update(name, "utf8").digest("hex").slice(0, 32)}.lock`,
  );

/** Runs `body` under this device's lock for setting the store `name` up: one attempt per store at a time here. */
const withStoreLock = async <T>(
  ports: BootstrapPorts,
  name: string,
  body: () => Promise<Result<T>>,
): Promise<Result<T>> => {
  const path = lockFile(ports.paths, name);
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    await ports.io.fs.mkdirp(ports.paths.locksDir);
    lock = await acquireLock(ports.io, path, {
      timeoutMs: 0,
      now: ports.clock,
      held: (holder, _path, ours) =>
        finding("store.locked", {
          message: ours
            ? `this process is already setting store ${name} up`
            : `store ${name} is being set up by ${holder === undefined ? "a process whose lock file cannot be read" : `plainport process ${holder.pid} on ${holder.host}, started ${holder.startedAt}`}`,
          fix:
            ours || holder !== undefined
              ? "wait for the other plainport run to finish, then re-run"
              : `delete ${path} if no plainport is running, then re-run`,
          paths: [path],
        }),
    });
  } catch (error) {
    return writeFailed(error, `taking the lock ${path}`, false, path);
  }
  if (!lock.ok) return lock;
  try {
    return await body();
  } finally {
    await lock.value.release();
  }
};

/** Records `id` under the store's name in this device's registry, unless the name is pinned to another id (D85). */
const recordId = async (ports: BootstrapPorts, name: string, id: string): Promise<Result<void>> => {
  const updated = await updateRegistry(ports.io, ports.paths, (registry) => {
    const current = registry.stores?.[name];
    if (current !== undefined && current !== id) return identityChanged(current, id, `store ${name}`);
    return ok(current === id ? registry : { ...registry, stores: { ...registry.stores, [name]: id } });
  });
  return updated.ok ? ok(undefined) : updated;
};

/** The same failure with the fix that names the store's pin (D85). */
const pinRefusal = (name: string, pinned: string, found: string | null): Failure =>
  withFix(
    identityChanged(pinned, found, `store named ${name}`),
    `point stores.${name} back at the store this device set up as ${name} (${pinned}); to set another store up, give it a new name in config.toml`,
  );

/** Adopts a store that is set up already: its repository must open with this device's password before it is recorded. */
const adopt = async (
  ports: BootstrapPorts,
  store: BootstrapStore,
  name: string,
  found: StoreDescriptor,
  pinned: string | undefined,
): Promise<Result<BootstrapDone>> => {
  if (pinned !== undefined && pinned !== found.id) return pinRefusal(name, pinned, found.id);
  // A probe that opens the repository with this device's password. Task 18's restic engine must make it without taking
  // restic's lock (--no-lock, or reading the config), so adopting writes nothing to the winner's repository either.
  const opens = await store.engineAt(found.repo).list({ tags: ["plainport"] });
  if (!opens.ok) {
    if (opens.finding.code === "restic.wrong-password")
      return withFix(
        opens,
        `store ${name} was set up as ${found.id} with another password: set stores.${name}.secret to a reference to that store's password, then re-run; nothing was recorded`,
      );
    return opens;
  }
  const recorded = await recordId(ports, name, found.id);
  if (!recorded.ok) return recorded;
  return ok({ outcome: "adopted", id: found.id, repo: found.repo, format: found.format });
};

/**
 * Sets the store up (see the file comment): adopts it when it is set up already, resumes this device's open attempt
 * for it if one is journaled, else runs a new attempt. Lost and contested are failures carrying the election's data.
 */
export const runBootstrap = (
  ports: BootstrapPorts,
  store: BootstrapStore,
  target: BootstrapTarget,
): Promise<Result<BootstrapDone>> =>
  withStoreLock(ports, target.name, async () => {
    let open: BootstrapJournal[];
    try {
      open = (await readBootstrapJournals(ports.io, ports.paths)).journals;
    } catch (error) {
      return writeFailed(error, "reading the bootstrap journals", false, ports.paths.journalDir);
    }
    // An attempt left open here is decided by re-running it with its id, never by a new attempt beside it (D99).
    for (const journal of open.filter((j) => j.store.name === target.name)) {
      const settled = await settle(ports, store, journal);
      if (settled.outcome === "published")
        return ok({ outcome: "published", id: settled.id, repo: settled.repo, format: 2 });
      if (settled.outcome !== "rolled-back") return settled.problem;
    }

    const registry = await readRegistry(ports.io, ports.paths);
    if (!registry.ok) return registry;
    const pinned = registry.value.stores?.[target.name];
    const found = await readStoreDescriptor(store.blob);
    if (!found.ok) return found;
    if (found.value !== null) return adopt(ports, store, target.name, found.value, pinned);
    if (pinned !== undefined) return pinRefusal(target.name, pinned, null);

    const at = ports.clock();
    const attempt = ulid(at.getTime());
    const journal: BootstrapJournal = {
      v: 1,
      op: attempt,
      kind: "bootstrap",
      step: "bootstrap.begin",
      startedAt: at.toISOString(),
      updatedAt: at.toISOString(),
      pid: ports.io.proc.pid,
      host: ports.io.proc.hostname(),
      store: { name: target.name, location: store.location },
      repo: `repos/${attempt}`,
      seal: target.seal,
      history: [],
    };
    const begun = await step(ports, journal, "bootstrap.begin");
    if (!begun.ok) return begun;
    const made = await store.engineAt(journal.repo).init();
    ports.faultAt("bootstrap.init.done");
    if (!made.ok) {
      // Nothing reached the store's catalog: the attempt ends here, its partial repository (if any) left as it is.
      await close(ports, journal);
      return made;
    }
    const initialised = await step(ports, journal, "bootstrap.initialised");
    if (!initialised.ok) return initialised;
    const settled = await electAndFinish(ports, store, journal);
    return settled.outcome === "published"
      ? ok({ outcome: "published", id: settled.id, repo: settled.repo, format: 2 })
      : settled.problem;
  });

/** Journals a step atomically, then reaches the crash seam. An I/O error is fs.write-failed, never an exception. */
const step = async (
  ports: BootstrapPorts,
  journal: BootstrapJournal,
  name: BootstrapStep,
): Promise<Result<void>> => {
  const at = ports.clock().toISOString();
  journal.step = name;
  journal.updatedAt = at;
  journal.history.push({ step: name, at });
  try {
    await writeBootstrapJournal(ports.io, ports.paths, journal);
  } catch (error) {
    return writeFailed(
      error,
      `writing the bootstrap journal at ${name}`,
      false,
      bootstrapJournalFile(ports.paths, journal.op),
    );
  }
  ports.faultAt(name);
  return ok(undefined);
};

/** Removes the journal: the attempt is settled. */
const close = async (ports: BootstrapPorts, journal: BootstrapJournal): Promise<void> => {
  try {
    await removeBootstrapJournal(ports.io, ports.paths, journal.op);
  } catch (error) {
    assertSystemError(error);
    ports.log(
      "warn",
      `the bootstrap journal ${bootstrapJournalFile(ports.paths, journal.op)} could not be removed; plainport recover removes it`,
    );
  }
};

const publicationOf = (journal: BootstrapJournal): Uint8Array =>
  encodeStoreIdentityV2({ id: journal.op, repo: journal.repo, seal: journal.seal });

/**
 * A store.json this attempt's own publication left torn in place (a crash on a linkless volume, D41) is completed with
 * the value it was writing. Only when the torn bytes are a strict prefix of that value that already holds its whole id,
 * and its `.publishing` record stands: then nobody else wrote them. Anything else is left for elect to refuse.
 */
const completeOwnTorn = async (store: BootstrapStore, journal: BootstrapJournal): Promise<Result<void>> => {
  const got = await store.blob.get(STORE_IDENTITY_KEY);
  if (!got.ok || got.value === null || parseStoreIdentity(got.value) !== undefined) return ok(undefined);
  const value = publicationOf(journal);
  const torn = got.value;
  const prefix = torn.length < value.length && torn.every((byte, i) => byte === value[i]);
  if (!prefix || !new TextDecoder().decode(torn).includes(`"id":"${journal.op}"`)) return ok(undefined);
  const intent = await store.blob.get(electionKey(STORE_CLAIMS_PREFIX, journal.op, "publishing"));
  if (!intent.ok) return intent;
  if (intent.value === null || !isElectionRecord(intent.value, journal.op, "publishing"))
    return ok(undefined);
  const completed = await store.blob.put(STORE_IDENTITY_KEY, value);
  return completed.ok ? ok(undefined) : completed;
};

/** Stands in the election with the journaled id and finishes what its outcome asks (journal at bootstrap.elect.start). */
const electAndFinish = async (
  ports: BootstrapPorts,
  store: BootstrapStore,
  journal: BootstrapJournal,
): Promise<Elected> => {
  const name = journal.store.name;
  const keep = (problem: Failure): Elected => ({ outcome: "pending", problem });
  if (journal.step !== "bootstrap.elect.start") {
    const started = await step(ports, journal, "bootstrap.elect.start");
    if (!started.ok) return keep(started);
  } else {
    // Only a resumed attempt can have torn its own publication; a fresh one has published nothing yet.
    const completed = await completeOwnTorn(store, journal);
    if (!completed.ok) return keep(completed);
  }
  const elected = await elect(store.blob, {
    key: STORE_IDENTITY_KEY,
    candidates: STORE_CLAIMS_PREFIX,
    id: journal.op,
    value: publicationOf(journal),
    winnerOf: (bytes) => parseStoreIdentity(bytes)?.id,
    store: name,
    wait: (ms) => ports.wait(ms),
    after: (write) => ports.faultAt(SEAM_OF[write]),
  });
  if (!elected.ok) {
    const torn =
      elected.finding.code === "store.failed" && (elected.finding.paths ?? []).includes(STORE_IDENTITY_KEY);
    return keep(
      torn
        ? withFix(
            elected,
            `stop plainport on every device that uses the store ${name} and wait until none is running; then, if ${STORE_IDENTITY_KEY} is still empty or partial, remove it from the store and run plainport recover on this device (the attempt ${journal.op} re-runs with its id)`,
          )
        : elected,
    );
  }
  const outcome = elected.value;
  if (outcome.outcome === "won") {
    const published = await step(ports, journal, "bootstrap.published");
    if (!published.ok) return keep(published);
    return record(ports, store, journal);
  }
  if (outcome.outcome === "lost") {
    await close(ports, journal);
    return {
      outcome: "lost",
      winner: outcome.winner,
      problem: failWith(
        finding("store.bootstrap-lost", {
          message: `store ${name} was set up by another attempt, ${outcome.winner}, which published it first; this attempt (${journal.op}) stopped after its candidacy, recorded nothing, and left its own repository ${journal.repo} in the store as it is (plainport never deletes a repository)`,
          fix: `to use the store from this device, re-run the setup with the store's password (stores.${name}.secret): it adopts the published store once its repository opens with that password`,
          paths: [STORE_IDENTITY_KEY],
        }),
        { outcome: "lost", attempt: journal.op, winner: outcome.winner },
      ),
    };
  }
  const data = {
    outcome: "contested",
    attempt: journal.op,
    candidates: outcome.candidates,
    undecided: outcome.undecided,
  };
  if (outcome.undecided.length === 0) {
    await close(ports, journal);
    return {
      outcome: "contested",
      problem: failWith(
        finding("store.bootstrap-contested", {
          message: `store ${name} has no winner: every attempt that stood (${outcome.candidates.join(", ")}) refuses, so nothing was published; this attempt's repository ${journal.repo} was left in the store as it is`,
          fix: outcome.fix,
          paths: [STORE_CLAIMS_PREFIX],
        }),
        data,
      ),
    };
  }
  // Undecided: this attempt refused for good, and keeps its journal so a re-run with its id ends it lost or contested.
  return {
    outcome: "pending",
    problem: failWith(
      finding("store.bootstrap-undecided", {
        message: `store ${name} is not set up yet: ${outcome.undecided.join(", ")} stood and ${outcome.undecided.length === 1 ? "has" : "have"} not decided, so this attempt (${journal.op}) refused; nothing was published by it`,
        fix: outcome.fix,
        paths: [STORE_CLAIMS_PREFIX],
      }),
      data,
    ),
  };
};

/** Reads store.json back, checks it names this attempt, records the id here, and closes the journal. */
const record = async (
  ports: BootstrapPorts,
  store: BootstrapStore,
  journal: BootstrapJournal,
): Promise<Elected> => {
  const name = journal.store.name;
  const keep = (problem: Failure): Elected => ({ outcome: "pending", problem });
  const back = await readStoreDescriptor(store.blob);
  if (!back.ok) return keep(back);
  if (back.value === null || back.value.id !== journal.op || back.value.repo !== journal.repo)
    return keep(
      fail(
        finding("store.failed", {
          message: `store ${name}'s ${STORE_IDENTITY_KEY} ${back.value === null ? "is gone" : `names ${back.value.id}`}, not this attempt (${journal.op}), which published it; nothing was recorded`,
          fix: `stop plainport on every device that uses the store ${name}, check ${STORE_IDENTITY_KEY} in the store (only the winning attempt writes it, and its recovery only completes a copy a crash tore), then run plainport recover`,
          paths: [STORE_IDENTITY_KEY],
        }),
      ),
    );
  const recorded = await recordId(ports, name, journal.op);
  if (!recorded.ok) return keep(recorded);
  ports.faultAt("bootstrap.recorded");
  await close(ports, journal);
  return { outcome: "published", id: journal.op, repo: journal.repo };
};

/** Settles one open attempt by its step's rule (BOOTSTRAP_RECOVERY). */
const settle = async (
  ports: BootstrapPorts,
  store: BootstrapStore,
  journal: BootstrapJournal,
): Promise<Settled> => {
  const rule: BootstrapRule | undefined = Object.hasOwn(BOOTSTRAP_RECOVERY, journal.step)
    ? BOOTSTRAP_RECOVERY[journal.step as BootstrapStep]
    : undefined;
  if (rule === undefined)
    return {
      outcome: "pending",
      problem: fail(
        finding("journal.pending", {
          message: `the setup of store ${journal.store.name} (attempt ${journal.op}) stopped at ${journal.step}, a step this version of plainport does not know; it was left as it is`,
          fix: "run plainport recover with the plainport version that wrote it",
          paths: [bootstrapJournalFile(ports.paths, journal.op)],
        }),
      ),
    };
  if (journal.store.location !== store.location)
    return {
      outcome: "pending",
      problem: withFix(
        identityChanged(journal.store.location, store.location, `store named ${journal.store.name}`),
        `point stores.${journal.store.name} back at ${journal.store.location}, where the setup began (attempt ${journal.op}, its repository ${journal.repo}), then re-run or run plainport recover; nothing was written to ${store.location}`,
      ),
    };
  if (rule === "record") return record(ports, store, journal);
  if (rule === "re-elect") return electAndFinish(ports, store, journal);
  // candidacy-check: the world decides, never the journal's last word (D24).
  const published = await readStoreDescriptor(store.blob);
  if (published.ok && published.value?.id === journal.op) {
    const stepped = await step(ports, journal, "bootstrap.published");
    if (!stepped.ok) return { outcome: "pending", problem: stepped };
    return record(ports, store, journal);
  }
  const candidacy = await store.blob.get(electionKey(STORE_CLAIMS_PREFIX, journal.op, "candidate"));
  if (!candidacy.ok) return { outcome: "pending", problem: candidacy };
  if (candidacy.value !== null) return electAndFinish(ports, store, journal);
  await close(ports, journal);
  return { outcome: "rolled-back" };
};

/**
 * Settles every open bootstrap journal on this device (the file comment's table), each under its store's lock, with
 * the store `open` reaches by name. What it cannot settle now stays journaled, its finding saying why.
 */
export const recoverBootstraps = async (
  ports: BootstrapPorts,
  open: (name: string) => Promise<Result<BootstrapStore>>,
): Promise<Result<BootstrapRecoveryReport>> => {
  let read: Awaited<ReturnType<typeof readBootstrapJournals>>;
  try {
    read = await readBootstrapJournals(ports.io, ports.paths);
  } catch (error) {
    return writeFailed(error, "reading the bootstrap journals", false, ports.paths.journalDir);
  }
  const operations: RecoveredBootstrap[] = [];
  for (const journal of read.journals) {
    const entry = { attempt: journal.op, store: journal.store.name, step: journal.step };
    const store = await open(journal.store.name);
    if (!store.ok) {
      operations.push({ ...entry, outcome: "pending", finding: store.finding });
      continue;
    }
    const settled = await withStoreLock(
      ports,
      journal.store.name,
      async (): Promise<Result<Settled | undefined>> => {
        // Read again under the lock: a setup re-run may have settled it since.
        let again: Awaited<ReturnType<typeof readBootstrapJournals>>;
        try {
          again = await readBootstrapJournals(ports.io, ports.paths);
        } catch (error) {
          return writeFailed(error, "reading the bootstrap journals", false, ports.paths.journalDir);
        }
        const now = again.journals.find((j) => j.op === journal.op);
        return ok(now === undefined ? undefined : await settle(ports, store.value, now));
      },
    );
    if (!settled.ok) {
      operations.push({ ...entry, outcome: "pending", finding: settled.finding });
      continue;
    }
    const s = settled.value;
    if (s === undefined) continue;
    operations.push(
      s.outcome === "published"
        ? { ...entry, outcome: "published", id: s.id }
        : s.outcome === "rolled-back"
          ? { ...entry, outcome: "rolled-back" }
          : s.outcome === "lost"
            ? { ...entry, outcome: "lost", finding: s.problem.finding, id: s.winner }
            : { ...entry, outcome: s.outcome, finding: s.problem.finding },
    );
    ports.log(
      s.outcome === "published" || s.outcome === "rolled-back" ? "info" : "warn",
      `bootstrap ${journal.op} of store ${journal.store.name} at ${journal.step}: ${s.outcome}`,
    );
  }
  return ok({ operations, unreadable: read.unreadable });
};
