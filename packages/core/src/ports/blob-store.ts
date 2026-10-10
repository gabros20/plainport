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
//
// Every store also states its semantics (DESIGN.md "Remote stores: consistency and publication", Q8): typed
// properties, each with its evidence or unknown. Each operation has one eligibility predicate over that profile, and
// an operation whose predicate fails refuses with store.semantics-unknown, naming the property, while the store stays
// usable for the others. capabilities() stays for its callers and derives from the profile (capabilitiesOf).

import { fail, finding, ok, type Result } from "@plainport/contract";
import { z } from "zod";

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

export const EvidenceSchema = z.enum(["measured", "documented", "asserted"]);
/** How a property is known: measured by `store test`, documented by the backend, or asserted by the owner. */
export type Evidence = z.infer<typeof EvidenceSchema>;

/** A property's value with its evidence, or "unknown"; unknown fails every predicate that names the property. */
const property = <T extends z.ZodType>(value: T) =>
  z.union([z.literal("unknown"), z.strictObject({ value, evidence: EvidenceSchema })]);

export const PublicationSchema = z.enum(["atomic-put", "temp-then-rename", "in-place"]);
export const DurabilitySchema = z.enum(["durable", "acked-unsynced", "unknown"]);
export const CancellationSchema = z.enum(["never-lands-late", "may-land-late"]);

export const StoreSemanticsSchema = z
  .strictObject({
    /** A get right after an acknowledged put sees it. */
    readAfterWrite: property(z.boolean()),
    /** A list right after an acknowledged put names it. */
    listAfterWrite: property(z.boolean()),
    /** A listing returns every key under the prefix, across every page. */
    listComplete: property(z.boolean()),
    /**
     * How a value becomes visible: whole on a plain put (`atomic-put`), whole only through rename() of a temporary
     * (`temp-then-rename`; a put is in place), or never whole (`in-place`: a reader may see a torn prefix).
     */
    publication: property(PublicationSchema),
    /** put(…, { ifNotExists: true }) is atomic: of racing writers exactly one creates the key. */
    conditionalCreate: property(z.boolean()),
    /** Whether an acknowledged write survives the server's crash or power loss. */
    durability: property(DurabilitySchema),
    /** Whether a put that failed or was cancelled can still land afterwards. */
    cancellation: property(CancellationSchema),
  })
  .meta({
    title: "StoreSemantics",
    description: "What a store guarantees, each property with its evidence (Q8)",
  });
export type StoreSemantics = z.infer<typeof StoreSemanticsSchema>;
export type SemanticProperty = keyof StoreSemantics;

/** A store nothing is known about: it can be read, and nothing else. */
export const UNKNOWN_SEMANTICS: StoreSemantics = Object.freeze<StoreSemantics>({
  readAfterWrite: "unknown",
  listAfterWrite: "unknown",
  listComplete: "unknown",
  publication: "unknown",
  conditionalCreate: "unknown",
  durability: "unknown",
  cancellation: "unknown",
});

/** A property's value, or "unknown". */
export const semanticValue = <T>(p: "unknown" | { value: T }): T | "unknown" =>
  p === "unknown" ? "unknown" : p.value;

/** The capabilities a profile gives: create-if-absent only when conditional create is known to hold. */
export const capabilitiesOf = (semantics: StoreSemantics): BlobCapabilities => ({
  createIfAbsent: semanticValue(semantics.conditionalCreate) === true,
  replaceIfMatch: false,
});

export type Eligibility = { eligible: true } | { eligible: false; missing: SemanticProperty[] };

const verdict = (missing: SemanticProperty[]): Eligibility =>
  missing.length === 0 ? { eligible: true } : { eligible: false, missing };

/** Reading the catalog (and ls) needs only a listing that works, which the call itself shows. */
export const canRead = (_semantics: StoreSemantics): Eligibility => ({ eligible: true });

/** Appending an event needs whole publication and read-after-write. */
export const canAppend = (s: StoreSemantics): Eligibility => {
  const missing: SemanticProperty[] = [];
  if (semanticValue(s.readAfterWrite) !== true) missing.push("readAfterWrite");
  const publication = semanticValue(s.publication);
  if (publication !== "atomic-put" && publication !== "temp-then-rename") missing.push("publication");
  return verdict(missing);
};

/**
 * An election needs a conditional create, or else (the sole-candidate fallback) visibility both ways and complete
 * listings. A missing conditional create alone only routes elections to the fallback, so it is never named.
 */
export const canElect = (s: StoreSemantics): Eligibility => {
  if (semanticValue(s.conditionalCreate) === true) return verdict([]);
  const missing: SemanticProperty[] = [];
  for (const p of ["readAfterWrite", "listAfterWrite", "listComplete"] as const) {
    if (semanticValue(s[p]) !== true) missing.push(p);
  }
  return verdict(missing);
};

/** A commit needs append and elect. */
export const canCommit = (s: StoreSemantics): Eligibility => {
  const append = canAppend(s);
  const elect = canElect(s);
  const missing = [...(append.eligible ? [] : append.missing), ...(elect.eligible ? [] : elect.missing)];
  return verdict([...new Set(missing)]);
};

export interface ReleaseProof {
  /** Q21's proof: no earlier than the grace period after the commit, the event re-read and restic lists the snapshot. */
  postGraceProof?: boolean;
}

/** Deleting a local folder needs commit, and a durable store or an acked-unsynced one with Q21's post-grace proof. */
export const canRelease = (s: StoreSemantics, proof: ReleaseProof = {}): Eligibility => {
  const commit = canCommit(s);
  const missing = commit.eligible ? [] : [...commit.missing];
  const durability = semanticValue(s.durability);
  if (!(durability === "durable" || (durability === "acked-unsynced" && proof.postGraceProof === true))) {
    missing.push("durability");
  }
  return verdict(missing);
};

export const STORE_OPERATIONS = ["read", "append", "elect", "commit", "release"] as const;
export type StoreOperation = (typeof STORE_OPERATIONS)[number];

/** The predicate of each operation. */
export const eligibility = (
  op: StoreOperation,
  semantics: StoreSemantics,
  proof: ReleaseProof = {},
): Eligibility => {
  switch (op) {
    case "read":
      return canRead(semantics);
    case "append":
      return canAppend(semantics);
    case "elect":
      return canElect(semantics);
    case "commit":
      return canCommit(semantics);
    case "release":
      return canRelease(semantics, proof);
  }
};

const DOING: Record<StoreOperation, string> = {
  read: "read its catalog",
  append: "append catalog events",
  elect: "hold an election (bootstrap or root claim)",
  commit: "commit an offload",
  release: "release a folder after an offload",
};

const describeProperty = (semantics: StoreSemantics, p: SemanticProperty): string => {
  const value = semantics[p];
  return value === "unknown" ? `${p} is unknown` : `${p} is ${String(value.value)} (${value.evidence})`;
};

/** Ok when `op` is eligible on the profile; otherwise store.semantics-unknown, naming each property it lacks. */
export const requireEligible = (
  op: StoreOperation,
  semantics: StoreSemantics,
  context: { store: string; proof?: ReleaseProof },
): Result<void> => {
  const verdictOf = eligibility(op, semantics, context.proof);
  if (verdictOf.eligible) return ok(undefined);
  const lacks = verdictOf.missing.map((p) => describeProperty(semantics, p)).join("; ");
  return fail(
    finding("store.semantics-unknown", {
      message: `the store ${context.store} cannot ${DOING[op]}: its ${lacks}; nothing was written for it`,
      fix: `use a store whose profile provides ${verdictOf.missing.join(", ")} for this (a local disk provides every property); the store ${context.store} stays usable for what its profile allows`,
    }),
  );
};

export interface BlobStore {
  /** What the store guarantees (Q8). */
  semantics(): StoreSemantics;
  /** Derived from semantics() (capabilitiesOf); kept for its callers. */
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
  /**
   * Moves `from` to `to`, appearing whole at `to`. Required where semantics().publication is `temp-then-rename`
   * (catalog/publish.ts uploads to a temporary and renames); other stores need not have it.
   */
  rename?(from: string, to: string): Promise<Result<void>>;
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
