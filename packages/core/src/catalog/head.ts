// What an operation reads of a store's catalog before it writes there (DESIGN.md "Offload process" step 7, "Catalog
// and data model"): the catalog itself through the one read path (a stale read is store.unreachable, never trusted for
// a write), whether the project's head is still the snapshot this working copy came from, and whether the store
// serves another root (ADR-0010, D48). Offload uses it now; onload's lease check reads the same head.

import { type Finding, fail, finding, ok, type Result, shellWord } from "@plainport/contract";
import type { BlobStore } from "../ports/blob-store.ts";
import type { CatalogState } from "./fold.ts";
import { loadCatalog } from "./log.ts";

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * A reader of the store's catalog for writing on top of it: the folded state when the store answered, the store's
 * own finding (store.unreachable when it gave none) when only the mirror's stale copy could be read. The read's
 * findings go to `report`.
 */
export const catalogReader =
  (options: {
    store: BlobStore;
    mirror: BlobStore;
    storeId: string;
    storeName: string;
    now(): Date;
    report(finding: Finding): void;
  }): (() => Promise<Result<CatalogState>>) =>
  async () => {
    const read = await loadCatalog({
      store: options.store,
      mirror: options.mirror,
      storeId: options.storeId,
      now: options.now(),
    });
    if (!read.ok) return read;
    if (read.value.stale)
      return fail(
        read.value.unreachable ??
          finding("store.unreachable", { message: `store ${options.storeName} could not be reached` }),
      );
    for (const f of read.value.findings) options.report(f);
    return ok(read.value.state);
  };

export type HeadCheck = { kind: "ok" } | { kind: "moved" | "incomplete"; finding: Finding };

/** The catalog's view of the head this working copy should offload on top of; a refusal when it is not that. */
export const headCheck = (
  state: CatalogState,
  id: string,
  base: string | undefined,
  address: string,
): HeadCheck => {
  const project = state.projects[id];
  const kept = project !== undefined && (project.heads.length > 0 || project.conflicts.length > 0);
  if (project !== undefined && project.missing.length > 0) {
    return {
      kind: "incomplete",
      finding: finding("catalog.incomplete", {
        message: `the catalog names ${plural(project.missing.length, "snapshot")} of ${address} it does not hold (${project.missing.join(", ")}), so its head is unknown; nothing was offloaded`,
        fix: "connect the store that holds them, or run plainport doctor",
      }),
    };
  }
  if (!kept) {
    if (base === undefined) return { kind: "ok" };
    return {
      kind: "incomplete",
      finding: finding("catalog.incomplete", {
        message: `this copy of ${address} came from snapshot ${base}, which the store's catalog does not hold`,
        fix: "check that the root's store is the one the project was onloaded from, or run plainport doctor",
      }),
    };
  }
  const moved = (detail: string) => ({
    kind: "moved" as const,
    finding: finding("catalog.head-moved", {
      message: `${address} ${detail}; nothing local was deleted`,
      fix: `plainport resolve ${shellWord(address)} settles which copy wins (M2); until then keep this folder`,
    }),
  });
  if (project.conflicts.length > 0 || project.head === null) return moved("is conflicted in the catalog");
  if (project.head !== base)
    return moved(
      `was offloaded from another copy since this one was made: the head is ${project.head}, this copy came from ${base ?? "no snapshot"}`,
    );
  return { kind: "ok" };
};

/** A root of the store's catalog other than `rootId` (by key when known): the store already serves it (D48). */
export const otherRoot = (state: CatalogState, rootId: string): string | undefined => {
  const roots = new Set(Object.keys(state.roots));
  for (const project of Object.values(state.projects)) roots.add(project.root);
  roots.delete(rootId);
  const [other] = [...roots].sort();
  return other === undefined ? undefined : (state.roots[other]?.key ?? other);
};

export const rootMismatch = (store: string, root: string, other: string): Finding =>
  finding("store.root-mismatch", {
    message: `store ${store} already holds root ${other}'s snapshots; one repository serves one root (ADR-0010), so root ${root} was not offloaded there`,
    fix: `give root ${root} its own store: plainport init --store-path <path> --store <name> --yes, then set roots.${root}.store to it`,
  });
