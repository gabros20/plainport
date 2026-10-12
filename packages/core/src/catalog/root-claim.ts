// A store's root claim (ADR-0010, D48, D50): one repository serves one root, and `meta/v1/root.json` holding
// `{ v: 1, root: <ULID> }` says which. The first offload of a root to a store claims it before that root's root-created
// event, so of two roots' first offloads at once at most one claims the store and the others are refused before they
// write anything. A store set up before claims existed has none until its first offload after.
//
// The claim is the elected publication (Q9; DESIGN.md "Remote stores: consistency and publication"), the rule
// bootstrap's store.json uses too: each root stands under `meta/v1/root-claims/` and only a sole candidate publishes,
// on every store whatever its conditional writes. The root's own ULID is the attempt's id. It is recorded in this
// device's registry before the claim, so a re-run of the offload stands again with the same id (D99), and the same root
// claiming from two devices is one attempt, publishing one value. The outcomes are won (the claim is the root's), lost
// (another root holds it: the caller refuses with store.root-mismatch) and contested: no root holds it and this one
// refuses, final (store.root-contested, the quiesced cleanup) or undecided while a rival may still publish
// (store.root-undecided, re-run later). `root.json` keeps format 1's shape, so v0.1.1 reads a claim as before,
// and a claim v0.1.1 wrote (create-only, without candidates) is a published winner like any other.
//
// On a store without hard links the file is created in place (D41): a reader can see it empty or partial while its
// writer is still writing, and a crash can leave it so. A partial file says nothing about whose claim it is: the
// election reads it again a few times (a writer finishes in milliseconds), then refuses with store.failed. A claim is
// never written over (D51).

import { fail, finding, ok, type Result } from "@plainport/contract";
import { z } from "zod";
import type { BlobStore } from "../ports/blob-store.ts";
import { UlidSchema } from "../ulid.ts";
import { type ElectionWrite, elect } from "./publish.ts";

export const ROOT_CLAIM_KEY = "meta/v1/root.json";
/** Where roots stand for the claim (the elected publication's candidates, D99). */
export const ROOT_CLAIMS_PREFIX = "meta/v1/root-claims/";

export const RootClaimSchema = z.strictObject({ v: z.literal(1), root: UlidSchema }).meta({
  title: "RootClaim",
  description: "meta/v1/root.json: the root a store serves, claimed by its first offload",
});
export type RootClaim = z.infer<typeof RootClaimSchema>;

const encode = (root: string): Uint8Array => new TextEncoder().encode(`${JSON.stringify({ v: 1, root })}\n`);

/** The root a claim's bytes name; undefined for bytes that are not a whole, valid claim. */
const rootOf = (bytes: Uint8Array): string | undefined => {
  try {
    const checked = RootClaimSchema.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    return checked.success ? checked.data.root : undefined;
  } catch {
    return undefined;
  }
};

export interface ClaimOptions {
  /** Waits between reads of a partial claim or of the candidates; a timer by default. */
  wait?: (ms: number) => Promise<void>;
  /**
   * The crash seam right after each of the claim's election writes (D52; elect's `after`). The claim runs before the
   * offload's journal opens, and the root's id is in the registry first, so the recovery from a crash there is the
   * offload's re-run, which stands again with the same id.
   */
  after?: (write: ElectionWrite) => void;
}

/**
 * Claims the store for `root` when no root has claimed it, and returns the root that holds the claim: `root` itself,
 * or the other root that holds it (the caller refuses with store.root-mismatch). Nothing is written when the store is
 * already claimed, or while its claim is partial. With no root holding it, this root refuses: store.root-contested
 * when every root that stood refuses, store.root-undecided while one may still publish.
 */
export const claimStoreRoot = async (
  store: BlobStore,
  root: string,
  options: ClaimOptions = {},
): Promise<Result<{ root: string }>> => {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const elected = await elect(store, {
    key: ROOT_CLAIM_KEY,
    candidates: ROOT_CLAIMS_PREFIX,
    id: root,
    value: encode(root),
    winnerOf: rootOf,
    wait,
    ...(options.after === undefined ? {} : { after: options.after }),
  });
  if (!elected.ok) return elected;
  const outcome = elected.value;
  if (outcome.outcome === "won") return ok({ root });
  if (outcome.outcome === "lost") return ok({ root: outcome.winner });
  const others = outcome.candidates.filter((id) => id !== root);
  return outcome.undecided.length === 0
    ? fail(
        finding("store.root-contested", {
          message: `no root holds the store's root claim: this root (${root}) and ${others.join(", ")} each stood for it and each refuses, so none can claim it; nothing was claimed`,
          fix: outcome.fix,
          paths: [ROOT_CLAIMS_PREFIX],
        }),
      )
    : fail(
        finding("store.root-undecided", {
          message: `the store's root claim is not decided: ${outcome.undecided.join(", ")} stood for it and may still claim it, so this root (${root}) refused and claimed nothing`,
          fix: outcome.fix,
          paths: [ROOT_CLAIMS_PREFIX],
        }),
      );
};
