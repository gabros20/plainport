// What an operation reads of a store's catalog before it writes there (DESIGN.md "Offload process" step 7, "Catalog
// and data model"): the catalog itself through the one read path (a stale read is store.unreachable, never trusted for
// a write), whether the project's head is still the snapshot this working copy came from, and whether the store
// serves another root (ADR-0010, D48). Offload uses it now; onload's lease check reads the same head.
//
// A fold that left out an event it could not read or use is not known to be whole (D86): when the snapshot this
// device knows of a project (its stub's, its registry entry's base) is named by no readable event, the head the fold
// shows may be older than one that exists, so a head-dependent default refuses with catalog.head-uncertain. The way on
// is that newest known snapshot, named with --snapshot: its restic snapshot is found by its op tag (unfoldedSnapshot),
// so onload restores it and removes its stub as usual; any other snapshot is refused while the doubt stands.

import { type Finding, fail, finding, ok, type Result, shellWord } from "@plainport/contract";
import type { BlobStore } from "../ports/blob-store.ts";
import type { Engine, RunContext } from "../ports/engine.ts";
import type { ProjectRegistry } from "../registry.ts";
import type { Stub } from "../stub.ts";
import type { CatalogProject, CatalogState } from "./fold.ts";
import { loadCatalog } from "./log.ts";

/** A catalog read for writing: the fold, and the events it left out that may change state (D86). */
export type CatalogRead = CatalogState & { uncertain: readonly string[] };

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
  }): (() => Promise<Result<CatalogRead>>) =>
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
    return ok({ ...read.value.state, uncertain: read.value.uncertain });
  };

/** Whether a readable event names `snapshot`: one the project holds, discarded, or named as a base it lacks. */
const named = (project: CatalogProject | undefined, snapshot: string): boolean =>
  project !== undefined &&
  (project.snapshots[snapshot] !== undefined ||
    project.discarded.includes(snapshot) ||
    project.missing.includes(snapshot));

export interface HeadDoubt {
  finding: Finding;
  /** The newest snapshot this device knows that no readable event names: the one --snapshot may restore. */
  newest: string;
}

/**
 * catalog.head-uncertain (D86) when the read left out events that may change state and a snapshot this device knows
 * of the project (`known`: its stub's, its registry entry's base) is named by none of the readable ones; else
 * undefined. `said.what` says what was not done ("nothing was restored"), `said.instead` the way on, given the
 * newest such snapshot.
 */
export const headUncertain = (
  read: CatalogState & { uncertain?: readonly string[] },
  id: string,
  known: readonly (string | undefined)[],
  address: string,
  said: { what: string; instead: (newest: string) => string },
): HeadDoubt | undefined => {
  const uncertain = read.uncertain ?? [];
  if (uncertain.length === 0) return undefined;
  const project = read.projects[id];
  const unnamed = [
    ...new Set(known.filter((s): s is string => s !== undefined && !named(project, s))),
  ].sort();
  const newest = unnamed.at(-1);
  if (newest === undefined) return undefined;
  const latest = project?.head ?? null;
  return {
    newest,
    finding: finding("catalog.head-uncertain", {
      message: `this device knows snapshot ${unnamed.join(" and ")} of ${address}, which no readable catalog event names, and the catalog left out ${plural(uncertain.length, "event")} it could not read or use (${uncertain.join(", ")}); its head${latest === null ? "" : ` ${latest}`} may be older than the newest snapshot, so ${said.what}`,
      fix: `${said.instead(newest)}; or upgrade plainport if a newer version wrote ${uncertain.length === 1 ? "that event" : "those events"}`,
    }),
  };
};

/** The restic tag that holds the project folder's own mode (Q5 ii), in octal: `plainport:mode=0755`. */
export const rootModeTag = (mode: number): string =>
  `plainport:mode=${(mode & 0o7777).toString(8).padStart(4, "0")}`;

/** The folder mode a snapshot's tags record; undefined when none does (a snapshot from before the tag). */
export const rootModeOfTags = (tags: readonly string[]): number | undefined => {
  for (const tag of tags) {
    const octal = /^plainport:mode=([0-7]{1,5})$/.exec(tag)?.[1];
    if (octal === undefined) continue;
    const mode = Number.parseInt(octal, 8);
    if (mode <= 0o7777) return mode;
  }
  return undefined;
};

/**
 * The restic id of `snapshot`, a snapshot of project `id` whose event the catalog could not read (D86): the one
 * snapshot in the repository tagged with its op, leaving out any the catalog names as discarded, with the folder mode
 * its tag records (the event, which holds rootMode, being the unreadable one). snapshot.not-found when there is none,
 * or more than one to choose from.
 */
export const unfoldedSnapshot = async (
  engine: Engine,
  options: { id: string; snapshot: string; discarded: readonly string[]; address: string; ctx?: RunContext },
): Promise<Result<{ id: string; rootMode?: number }>> => {
  const listed = await engine.list(
    { tags: ["plainport", `plainport:project=${options.id}`, `plainport:op=${options.snapshot}`] },
    options.ctx,
  );
  if (!listed.ok) return listed;
  const found = listed.value.filter((s) => !options.discarded.includes(s.id));
  const [only] = found;
  if (found.length === 1 && only !== undefined) {
    const rootMode = rootModeOfTags(only.tags);
    return ok({ id: only.id, ...(rootMode === undefined ? {} : { rootMode }) });
  }
  return fail(
    finding("snapshot.not-found", {
      message:
        found.length === 0
          ? `the repository holds no snapshot tagged as ${options.snapshot} of ${options.address}, and the catalog cannot read the event that names it; nothing was restored`
          : `the repository holds ${found.length} snapshots tagged as ${options.snapshot} of ${options.address} (${found.map((s) => s.id).join(", ")}), and the event that says which one was kept cannot be read; nothing was restored`,
      fix: "upgrade plainport if a newer version wrote the unreadable event; until then restore an older snapshot side by side: plainport restore <project> --snapshot <id> --to <path>",
    }),
  );
};

/**
 * The project as this device's own records know it (D88), for --snapshot under doubt when no readable event names it at
 * all (its first offload's event unreadable): its root's ULID from its stub, when the stub is this project's at this
 * root and path, else from registry.json, with no snapshots folded. Undefined when neither record says.
 */
export const recordedProject = (options: {
  id: string;
  root: string;
  path: string;
  stub: Stub | undefined;
  registry: ProjectRegistry;
}): CatalogProject | undefined => {
  const { id, root, path, stub, registry } = options;
  const entry = registry.projects[id];
  if (entry !== undefined && (entry.root !== root || entry.path !== path)) return undefined;
  const ours = stub !== undefined && stub.project === id && stub.root === root && stub.path === path;
  const rootId = ours ? stub.rootId : entry !== undefined ? registry.roots?.[root] : undefined;
  if (rootId === undefined) return undefined;
  return {
    root: rootId,
    path,
    status: "shelved",
    head: null,
    heads: [],
    lease: null,
    conflicts: [],
    missing: [],
    discarded: [],
    snapshots: {},
  };
};

export type HeadCheck = { kind: "ok" } | { kind: "moved" | "incomplete"; finding: Finding };

/** The catalog's view of the head this working copy should offload on top of; a refusal when it is not that. */
export const headCheck = (
  state: CatalogState & { uncertain?: readonly string[] },
  id: string,
  base: string | undefined,
  address: string,
): HeadCheck => {
  // A fold that may lack the event naming this copy's base cannot say whether the head moved (D86).
  const uncertain = headUncertain(state, id, [base], address, {
    what: "nothing was offloaded",
    instead: () => "keep this folder as it is until the catalog reads whole",
  });
  if (uncertain !== undefined) return { kind: "incomplete", finding: uncertain.finding };
  const project = state.projects[id];
  const kept = project !== undefined && (project.heads.length > 0 || project.conflicts.length > 0);
  if (project !== undefined && project.missing.length > 0) {
    return {
      kind: "incomplete",
      finding: finding("catalog.incomplete", {
        message: `the catalog names ${plural(project.missing.length, "snapshot")} of ${address} it does not hold (${project.missing.join(", ")}), so its head is unknown; nothing was offloaded`,
        fix: "connect the store that holds them, then re-run",
      }),
    };
  }
  if (!kept) {
    if (base === undefined) return { kind: "ok" };
    return {
      kind: "incomplete",
      finding: finding("catalog.incomplete", {
        message: `this copy of ${address} came from snapshot ${base}, which the store's catalog does not hold`,
        fix: "check that the root's store is the one the project was onloaded from, then re-run",
      }),
    };
  }
  const moved = (detail: string) => ({
    kind: "moved" as const,
    finding: finding("catalog.head-moved", {
      message: `${address} ${detail}; nothing local was deleted`,
      fix: `keep this folder; plainport restore ${shellWord(address)} --snapshot <id> --to <path> reads the other copy side by side (settling which copy wins arrives in M2)`,
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
