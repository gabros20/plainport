// A store's root claim (ADR-0010, D48, D50): one repository serves one root, and `meta/v1/root.json` holding
// `{ v: 1, root: <ULID> }` says which. The first offload of a root to a store creates it, create-only, before that
// root's root-created event, so of two roots' first offloads at once exactly one claims the store and the other is
// refused before it writes anything. A store set up before claims existed has none until its first offload after.
//
// On a store without hard links the file is created in place (D41), so a crash can leave a strict prefix of it. A
// prefix of this root's own claim is completed, as appendEvent completes its own torn event (D42); any other bytes
// are never replaced.

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

const isPrefix = (bytes: Uint8Array, of: Uint8Array): boolean =>
  bytes.length < of.length && bytes.every((b, i) => b === of[i]);

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

const damaged = () =>
  fail(
    finding("store.failed", {
      message: `the store's root claim ${ROOT_CLAIM_KEY} is not valid and is not a half-written claim by this root; it was left as it is`,
      fix: `check which root the store's catalog serves (its root-created events), write {"v":1,"root":"<that root's ULID>"} to ${ROOT_CLAIM_KEY}, and re-run`,
      paths: [ROOT_CLAIM_KEY],
    }),
  );

/**
 * Claims the store for `root` when no root has claimed it, and returns the root that holds the claim: `root` itself,
 * or the other root that holds it (the caller refuses with store.root-mismatch). Nothing is written when the store is
 * already claimed.
 */
export const claimStoreRoot = async (
  store: BlobStore,
  root: string,
): Promise<Result<{ root: string; created: boolean }>> => {
  const ours = encode(root);
  const found = await read(store);
  if (!found.ok) return found;
  if (found.value.kind === "root") return ok({ root: found.value.root, created: false });
  if (found.value.kind === "bytes" && !isPrefix(found.value.bytes, ours)) return damaged();
  const createOnly = found.value.kind === "absent" && store.capabilities().createIfAbsent;
  const put = await store.put(ROOT_CLAIM_KEY, ours, createOnly ? { ifNotExists: true } : {});
  if (!put.ok && put.finding.code !== "store.key-exists") return put;
  // Read back: a refused create lost to another root, and an in-place write may have raced one (D41).
  const now = await read(store);
  if (!now.ok) return now;
  if (now.value.kind !== "root") return now.value.kind === "absent" && !put.ok ? put : damaged();
  return ok({ root: now.value.root, created: put.ok && now.value.root === root });
};
