// A store's root claim (ADR-0010, D48, D50): one repository serves one root, and `meta/v1/root.json` holding
// `{ v: 1, root: <ULID> }` says which. The first offload of a root to a store creates it, create-only, before that
// root's root-created event, so of two roots' first offloads at once exactly one claims the store and the other is
// refused before it writes anything. A store set up before claims existed has none until its first offload after.
//
// On a store without hard links the file is created in place (D41): a reader can see it empty or partial while its
// writer is still writing, and a crash can leave it so. Unlike an event's key, this key is shared by every root, so a
// partial file says nothing about whose claim it is: it is read again a few times (a writer finishes in
// milliseconds), then refused with store.failed. A claim is never written over (D51). A store without create-only
// writes (none in M1) gets a plain write and a read-back; M2+ stores of that kind need a conditional write here.

import { fail, finding, ok, type Result } from "@plainport/contract";
import { z } from "zod";
import type { BlobStore } from "../ports/blob-store.ts";
import { UlidSchema } from "../ulid.ts";

export const ROOT_CLAIM_KEY = "meta/v1/root.json";

export const RootClaimSchema = z.strictObject({ v: z.literal(1), root: UlidSchema }).meta({
  title: "RootClaim",
  description: "meta/v1/root.json: the root a store serves, claimed by its first offload",
});
export type RootClaim = z.infer<typeof RootClaimSchema>;

const encode = (root: string): Uint8Array => new TextEncoder().encode(`${JSON.stringify({ v: 1, root })}\n`);

type Read = { kind: "absent" } | { kind: "root"; root: string } | { kind: "bytes"; bytes: Uint8Array };

const read = async (store: BlobStore): Promise<Result<Read>> => {
  const got = await store.get(ROOT_CLAIM_KEY);
  if (!got.ok) return got;
  if (got.value === null) return ok({ kind: "absent" });
  try {
    const checked = RootClaimSchema.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(got.value)),
    );
    if (checked.success) return ok({ kind: "root", root: checked.data.root });
  } catch {
    // Not UTF-8 or not JSON: judged by its bytes below.
  }
  return ok({ kind: "bytes", bytes: got.value });
};

/** How often a partial claim is read before it is refused, and how long to wait between reads. */
const READS = 5;
const WAIT_MS = 200;

export interface ClaimOptions {
  /** Waits between reads of a partial claim; a timer by default. */
  wait?: (ms: number) => Promise<void>;
}

const partial = () =>
  fail(
    finding("store.failed", {
      message: `the store's root claim ${ROOT_CLAIM_KEY} is empty or partial: another plainport offload is writing it, or one stopped while writing it; nothing was written`,
      fix: `wait for any plainport offload to this store to finish (on this device or another), then re-run; if it stays like this, check ${ROOT_CLAIM_KEY} in the store`,
      paths: [ROOT_CLAIM_KEY],
    }),
  );

/** The claim once it settles: a file another root is still writing in place is read again, READS times in all. */
const settled = async (store: BlobStore, options: ClaimOptions): Promise<Result<Read>> => {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let found = await read(store);
  for (let reads = 1; found.ok && found.value.kind === "bytes" && reads < READS; reads++) {
    await wait(WAIT_MS);
    found = await read(store);
  }
  return found;
};

/**
 * Claims the store for `root` when no root has claimed it, and returns the root that holds the claim: `root` itself,
 * or the other root that holds it (the caller refuses with store.root-mismatch). Nothing is written when the store is
 * already claimed, or while its claim is partial.
 */
export const claimStoreRoot = async (
  store: BlobStore,
  root: string,
  options: ClaimOptions = {},
): Promise<Result<{ root: string; created: boolean }>> => {
  const found = await settled(store, options);
  if (!found.ok) return found;
  if (found.value.kind === "root") return ok({ root: found.value.root, created: false });
  if (found.value.kind === "bytes") return partial();
  const createOnly = store.capabilities().createIfAbsent;
  const put = await store.put(ROOT_CLAIM_KEY, encode(root), createOnly ? { ifNotExists: true } : {});
  if (!put.ok && put.finding.code !== "store.key-exists") return put;
  // Read back: a refused create lost to another root, whose write may still be in progress (D41).
  const now = await settled(store, options);
  if (!now.ok) return now;
  if (now.value.kind === "root")
    return ok({ root: now.value.root, created: put.ok && now.value.root === root });
  return now.value.kind === "bytes" || put.ok ? partial() : put;
};
