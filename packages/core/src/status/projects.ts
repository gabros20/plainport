// What `plainport ls` and `plainport status` show (DESIGN.md "CLI design", "Project lifecycle"): every project this
// device knows, from its registry and from the catalog of every store it has set up, each in exactly one state of the
// lifecycle, plus the conditions that need attention. It only reads: the catalog through the one read path
// (loadCatalog, D43), which downloads into this device's mirror and never writes to a store (D45); an unreachable store
// is read from the mirror, marked stale, or never synced when this device never reached it.
//
// The state, by what this device sees, in this order:
//
//   unavailable             the project's root is bound to a volume that is not mounted (its folder is unknown)
//   offloading, onloading   a journal of the project is open: running, or interrupted (plainport recover settles it)
//   conflicted              the catalog holds a fork (plainport resolve, M2)
//   restored-unhydrated     the folder is here, its dependencies are not installed (plainport hydrate)
//   local                   the folder is here; or the catalog's latest event onloaded it on some device
//   shelved                 the folder is not here, and the catalog's latest event offloaded it (or its stub is here)
//
// Conditions (an open set; more may come): incomplete (the catalog names snapshots it does not hold, so there is no
// head, D41), diverged-after-commit (committed and shelved in the catalog, but the folder stayed here with later edits
// and no stub, D51), head-moved (the folder is here but another copy was offloaded since this one came), interrupted
// or running (the open journal's process), folder-missing (this device should hold it but its folder is gone), stale
// and never-synced (the store did not answer).

import { join } from "node:path";
import type { Failure, Finding, ProjectState, Result } from "@plainport/contract";
import { fail, finding, ok } from "@plainport/contract";
import { OffloadedEventSchema } from "../catalog/events.ts";
import type { CatalogProject, CatalogState } from "../catalog/fold.ts";
import { loadCatalog, MIRROR_EVENTS_PREFIX } from "../catalog/log.ts";
import type { ConfigLoader } from "../config/load.ts";
import type { Device } from "../device.ts";
import { type LocalIo, systemErrorCode } from "../io.ts";
import { type Journal, readJournals } from "../journal/index.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { StoreOpener } from "../ports/store.ts";
import { treeBytes } from "../recover/trash.ts";
import { type RegistryEntry, readRegistry } from "../registry.ts";
import { listRoots, type RootView } from "../roots/roots.ts";
import { holdsProjectBack } from "../saga/project-gate.ts";
import { resolveSecret, secretRefOf } from "../store.ts";
import { STUB_SUFFIX } from "../stub.ts";

export interface ViewDeps {
  io: LocalIo;
  paths: PlainportPaths;
  env: Env;
  /** This device: its root bindings, and whether a lease is its own. */
  device: Device;
  loader: ConfigLoader;
  opener: StoreOpener;
  /** This device's event mirror for the store with this id (blob-fs's openEventMirror). */
  openMirror(storeId: string): Promise<Result<BlobStore>>;
  now?: () => Date;
}

/** Conditions a view may carry; an open set, so a reader passes unknown ones through. */
export const PROJECT_CONDITIONS = [
  "incomplete",
  "diverged-after-commit",
  "head-moved",
  "interrupted",
  "running",
  "folder-missing",
  "stale",
  "never-synced",
  "catalog-unreadable",
] as const;

export type ProjectStatus = {
  /** root:path, the root by its key (the catalog's, when this device has no such root). */
  address: string;
  root: string;
  path: string;
  id: string;
  state: ProjectState;
  conditions: string[];
  /** Its folder on this device: the registry's override, else the root's place for it. */
  dir?: string;
  /** The folder is on this device. */
  here: boolean;
  /** Its stub, when one is here. */
  stub?: string;
  /** The store whose catalog holds it. */
  store?: string;
  /** The catalog's head; null when there is none (never offloaded, conflicted, incomplete). */
  head: string | null;
  /** The snapshot this device's copy came from (registry.json). */
  base?: string;
  /** The device whose onload holds the project's lease, and whether it is this one. */
  lease?: { device: string; at: string; base: string; here: boolean };
  /** Snapshots the catalog holds of it. */
  snapshots: number;
  /** Files' bytes in the head snapshot (a project never offloaded: its folder's size now), and what it stripped. */
  bytes?: number;
  strippedBytes?: number;
  /** The newest of its snapshots, its lease and this device's onload. */
  lastActivity?: string;
  /** The catalog was read from this device's mirror: the store did not answer. */
  stale: boolean;
  /** When the catalog was last brought up to date with the store; absent when never. */
  syncedAt?: string;
  /** Its open journal: running, or interrupted (plainport recover). */
  journal?: { op: string; kind: "offload" | "onload"; step: string; running: boolean };
};

export type StoreView = {
  name: string;
  id?: string;
  stale: boolean;
  syncedAt?: string;
  /** Why its catalog could not be read at all, or why it is stale. */
  finding?: Finding;
};

export type Views = {
  projects: ProjectStatus[];
  stores: StoreView[];
  /** Warnings from reading config, roots and catalogs. */
  findings: Finding[];
};

interface Read {
  store: string;
  stale: boolean;
  syncedAt?: string;
  state: CatalogState;
  mirror?: BlobStore;
}

const kindAt = async (io: LocalIo, path: string): Promise<string | undefined> => {
  try {
    return (await io.fs.lstat(path)).kind;
  } catch (error) {
    systemErrorCode(error);
    return undefined;
  }
};

const newest = (times: (string | undefined)[]): string | undefined =>
  times
    .filter((t): t is string => t !== undefined)
    .sort()
    .at(-1);

/** A store whose every call fails as `failure` did: the mirror that could not be opened, for loadCatalog. */
const failingStore = (failure: Failure): BlobStore => ({
  capabilities: () => ({ createIfAbsent: false, replaceIfMatch: false }),
  get: async () => failure,
  put: async () => failure,
  list: async () => failure,
  stat: async () => failure,
  delete: async () => failure,
});

/** Every project this device knows, each with its state and conditions (see the file comment). */
export const projectViews = async (deps: ViewDeps): Promise<Result<Views>> => {
  const { io, paths, device } = deps;
  const now = deps.now?.() ?? new Date();
  const loaded = await deps.loader.load({ env: deps.env });
  if (!loaded.ok) return loaded;
  const config = loaded.value.config;
  const findings: Finding[] = [...loaded.value.findings];
  const registry = await readRegistry(io, paths);
  if (!registry.ok) return registry;
  const listed = await listRoots(io, paths, { env: deps.env, device: device.name });
  if (!listed.ok) return listed;
  const roots = new Map<string, RootView>(listed.value.roots.map((r) => [r.key, r]));
  let journals: Journal[];
  try {
    journals = (await readJournals(io, paths)).journals;
  } catch (error) {
    systemErrorCode(error);
    journals = [];
  }

  // Every store this device has set up: its catalog, from the store or, stale, from the mirror.
  const stores: StoreView[] = [];
  const reads: Read[] = [];
  for (const [name, id] of Object.entries(registry.value.stores ?? {})) {
    const store = config.stores[name];
    if (store === undefined) continue;
    // The catalog needs no password; the engine, which does, is never used here.
    const password = await resolveSecret(io, deps.env, paths.home, name, secretRefOf(store));
    const opened = await deps.opener.open(name, store, password.ok ? password.value : "");
    if (!opened.ok) {
      stores.push({ name, id, stale: true, finding: opened.finding });
      continue;
    }
    // A mirror that cannot be opened is only a cache: loadCatalog then reads the store directly (D45).
    const mirror = await deps.openMirror(id);
    const read = await loadCatalog({
      store: opened.value.blob,
      mirror: mirror.ok ? mirror.value : failingStore(mirror),
      storeId: id,
      now,
    });
    if (!read.ok) {
      stores.push({ name, id, stale: true, finding: read.finding });
      continue;
    }
    findings.push(...read.value.findings);
    stores.push({
      name,
      id,
      stale: read.value.stale,
      ...(read.value.syncedAt === undefined ? {} : { syncedAt: read.value.syncedAt }),
      ...(read.value.unreachable === undefined ? {} : { finding: read.value.unreachable }),
    });
    reads.push({
      store: name,
      stale: read.value.stale,
      ...(read.value.syncedAt === undefined ? {} : { syncedAt: read.value.syncedAt }),
      state: read.value.state,
      ...(mirror.ok ? { mirror: mirror.value } : {}),
    });
  }

  const failedStores = new Set(
    stores.filter((st) => !reads.some((r) => r.store === st.name)).map((st) => st.name),
  );
  const storeOfRoot = (entry: RegistryEntry | undefined): string | undefined =>
    entry === undefined ? undefined : (config.roots[entry.root]?.store ?? config.defaultStore);

  // Root ULID → this device's key for it, else the catalog's.
  const keyOf = new Map<string, string>();
  for (const read of reads)
    for (const [rootId, root] of Object.entries(read.state.roots))
      if (root.key !== null && !keyOf.has(rootId)) keyOf.set(rootId, root.key);
  for (const [key, rootId] of Object.entries(registry.value.roots ?? {})) keyOf.set(rootId, key);

  const ids = new Set<string>(Object.keys(registry.value.projects));
  for (const read of reads) for (const id of Object.keys(read.state.projects)) ids.add(id);
  const projects: ProjectStatus[] = [];
  for (const id of [...ids].sort()) {
    const entry = registry.value.projects[id];
    // The store whose catalog holds it, else its root's store, whose staleness it shares.
    const rootStore =
      entry === undefined ? undefined : (config.roots[entry.root]?.store ?? config.defaultStore);
    const found =
      reads.find((r) => r.state.projects[id] !== undefined) ?? reads.find((r) => r.store === rootStore);
    const catalog = found?.state.projects[id];
    const root = entry?.root ?? (catalog === undefined ? "" : (keyOf.get(catalog.root) ?? catalog.root));
    const path = entry?.path ?? catalog?.path ?? "";
    projects.push(
      await viewOf(
        id,
        root,
        path,
        entry,
        catalog,
        found,
        journals.filter((j) => j.project.id === id),
      ),
    );
  }
  projects.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return ok({ projects, stores, findings });

  async function viewOf(
    id: string,
    root: string,
    path: string,
    entry: RegistryEntry | undefined,
    catalog: CatalogProject | undefined,
    read: Read | undefined,
    open: Journal[],
  ): Promise<ProjectStatus> {
    const rootView = roots.get(root);
    const place = rootView?.path === undefined ? undefined : join(rootView.path, ...path.split("/"));
    const dir = entry?.override ?? place;
    const here = dir !== undefined && (await kindAt(io, dir)) === "dir";
    const stub =
      dir !== undefined && (await kindAt(io, `${dir}${STUB_SUFFIX}`)) === "file"
        ? `${dir}${STUB_SUFFIX}`
        : undefined;
    const journal = open.filter(holdsProjectBack).at(-1);
    const running =
      journal !== undefined && journal.host === io.proc.hostname() && (await io.proc.isAlive(journal.pid));
    const head = catalog?.head ?? null;
    const lease = catalog?.lease ?? null;
    const conditions: string[] = [];
    let state: ProjectState;
    if (rootView?.state === "unavailable" && entry?.override === undefined) state = "unavailable";
    else if (journal !== undefined) {
      state = journal.kind === "offload" ? "offloading" : "onloading";
      conditions.push(running ? "running" : "interrupted");
    } else if (catalog !== undefined && (catalog.status === "conflicted" || catalog.conflicts.length > 0))
      state = "conflicted";
    else if (here) {
      state = entry?.unhydrated === true ? "restored-unhydrated" : "local";
      if (catalog?.status === "shelved" && stub === undefined && head !== null) {
        // Shelved in the catalog, yet here: kept by diverged-after-commit when its base is the head (D51), else a
        // copy another offload has moved past.
        conditions.push(entry?.base === head ? "diverged-after-commit" : "head-moved");
      }
    } else if (stub !== undefined) state = "shelved";
    else if (catalog !== undefined) {
      state = catalog.status === "local" ? "local" : "shelved";
      if (catalog.status === "local" && lease?.device === device.id) conditions.push("folder-missing");
    } else {
      state = "local";
      conditions.push("folder-missing");
    }
    if (catalog !== undefined && catalog.missing.length > 0) conditions.push("incomplete");
    if (read?.stale === true) conditions.push(read.syncedAt === undefined ? "never-synced" : "stale");
    // Its store's catalog could not be read at all, from the store or the mirror: nothing here is current.
    const unread = read === undefined && failedStores.has(storeOfRoot(entry) ?? "");
    if (unread) conditions.push("catalog-unreadable");

    // The head's size, from the mirror's copy of the event that made it.
    let bytes: number | undefined;
    let strippedBytes: number | undefined;
    const made = head === null ? undefined : catalog?.snapshots[head];
    if (made !== undefined && read?.mirror !== undefined) {
      const got = await read.mirror.get(`${MIRROR_EVENTS_PREFIX}${made.event}.json`);
      if (got.ok && got.value !== null) {
        try {
          const parsed = OffloadedEventSchema.safeParse(JSON.parse(new TextDecoder().decode(got.value)));
          if (parsed.success) {
            bytes = parsed.data.stats.bytes;
            strippedBytes = parsed.data.stats.strippedBytes;
          }
        } catch {
          // Not an event: no size.
        }
      }
    }
    // Never offloaded, here: the folder's own size now, so ls can show and sort it.
    if (bytes === undefined && head === null && here && dir !== undefined) bytes = await treeBytes(io, dir);
    const lastActivity = newest([
      ...Object.values(catalog?.snapshots ?? {}).map((s) => s.at),
      lease?.at,
      entry?.onloadedAt,
    ]);
    return {
      address: `${root}:${path}`,
      root,
      path,
      id,
      state,
      conditions,
      ...(dir === undefined ? {} : { dir }),
      here,
      ...(stub === undefined ? {} : { stub }),
      ...(read === undefined ? {} : { store: read.store }),
      head,
      ...(entry?.base === undefined ? {} : { base: entry.base }),
      ...(lease === null
        ? {}
        : {
            lease: { device: lease.device, at: lease.at, base: lease.base, here: lease.device === device.id },
          }),
      snapshots: Object.keys(catalog?.snapshots ?? {}).length,
      ...(bytes === undefined ? {} : { bytes }),
      ...(strippedBytes === undefined ? {} : { strippedBytes }),
      ...(lastActivity === undefined ? {} : { lastActivity }),
      stale: read?.stale ?? unread,
      ...(read?.syncedAt === undefined ? {} : { syncedAt: read.syncedAt }),
      ...(journal === undefined
        ? {}
        : { journal: { op: journal.op, kind: journal.kind, step: journal.step, running } }),
    };
  }
};

/** The view of one project, by its id or its address; project.not-found when this device knows of none. */
export const findView = (views: Views, project: { id?: string; address: string }): Result<ProjectStatus> => {
  const view =
    (project.id === undefined ? undefined : views.projects.find((p) => p.id === project.id)) ??
    views.projects.find((p) => p.address === project.address);
  if (view !== undefined) return ok(view);
  return fail(
    finding("project.not-found", {
      message: `neither this device nor the catalog of any store it set up knows ${project.address}`,
      fix: "plainport ls lists the projects; plainport root scan <root> registers a root's projects",
    }),
  );
};
