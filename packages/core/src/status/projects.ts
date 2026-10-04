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
// or running (the open journal's process: running only while it holds the project's lock, so a reused pid never
// looks running), folder-missing (this device should hold it but its folder is gone), stale and never-synced (the
// store did not answer), journal-unreadable (a journal this version cannot read names the project, or names none and
// so may be any project's). Each condition comes with a sentence in `conditionDetails`.
//
// Views are lazy (loadProjects): the registry, roots, journals and catalogs are read once, for every project, since a
// name is matched against all of them; a project's own view (its folder's stat, its head's size, its local planning)
// is built only when asked for. A folder's own size is computed only when asked for (ls shows it), and never walks a
// plugin's dependency folders.

import { join } from "node:path";
import type { Failure, Finding, ProjectState, Result } from "@plainport/contract";
import { fail, finding, ok, shellWord } from "@plainport/contract";
import { OffloadedEventSchema } from "../catalog/events.ts";
import type { CatalogProject, CatalogState } from "../catalog/fold.ts";
import { loadCatalog, MIRROR_EVENTS_PREFIX } from "../catalog/log.ts";
import type { ConfigLoader } from "../config/load.ts";
import type { Device } from "../device.ts";
import { type LocalIo, systemErrorCode } from "../io.ts";
import { type Journal, type JournalsRead, type OffloadJournal, readJournals } from "../journal/index.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import { planOffload } from "../plan/planner.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { HostChecks } from "../ports/checks.ts";
import type { EcosystemPlugin } from "../ports/ecosystem.ts";
import type { HostPorts } from "../ports/host.ts";
import type { StoreOpener } from "../ports/store.ts";
import { claimedReason, treeBytes } from "../recover/trash.ts";
import { type RegistryEntry, readRegistry } from "../registry.ts";
import { listRoots, type RootView } from "../roots/roots.ts";
import { holdsProjectBack, operationRunning, unreadableOf } from "../saga/project-gate.ts";
import { offloadTrashOf } from "../saga/release.ts";
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
  /** The ecosystem plugins: their dependency folders are never walked when a folder is sized. */
  plugins?: readonly EcosystemPlugin[];
  /** For a view's local details (`detail`): the offload's read-only planning runs on this host. */
  planning?: { host: HostPorts; checks: HostChecks; plugins: readonly EcosystemPlugin[] };
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
  "journal-unreadable",
] as const;
export type ProjectCondition = (typeof PROJECT_CONDITIONS)[number];

/** A project's open journal, and whether the plainport that wrote it still runs it. */
export type JournalView = { op: string; kind: "offload" | "onload"; step: string; running: boolean };

export type ProjectStatus = {
  /** root:path, the root by its key (the catalog's, when this device has no such root). */
  address: string;
  root: string;
  path: string;
  id: string;
  state: ProjectState;
  conditions: ProjectCondition[];
  /** One sentence per condition, in the same order, with the finding behind it when there is one. */
  conditionDetails: { condition: ProjectCondition; message: string; finding?: Finding }[];
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
  /**
   * Files' bytes in the head snapshot, and what it stripped. A project never offloaded: its folder's size now,
   * without its dependency folders, only when sizes were asked for.
   */
  bytes?: number;
  strippedBytes?: number;
  /** The newest of its snapshots, its lease and this device's onload. */
  lastActivity?: string;
  /** The catalog was read from this device's mirror: the store did not answer. */
  stale: boolean;
  /** When the catalog was last brought up to date with the store; absent when never. */
  syncedAt?: string;
  /** Its newest open journal: running, or interrupted (plainport recover). */
  journal?: JournalView;
  /** Every open journal of it, oldest first (the order recover settles them in). */
  journals: JournalView[];
  /** Released offloads' trash awaiting deletion: until keepUntil, or while its detached delete runs (D64). */
  trash: { op: string; path: string; keepUntil?: string; deleting: boolean; due: boolean }[];
  /** Journals this version cannot read that name it, or name no project (journal-unreadable). */
  unreadableJournals?: string[];
  /** What to do next, when anything is to be done. */
  next?: { command: string; reason: string };
  /** With `detail`, for a folder here: the git findings a read-only scan makes now. */
  gitWarnings?: Finding[];
  /** With `detail`, for a folder here: what an offload would strip now. */
  strippableBytes?: number;
};

export type StoreView = {
  name: string;
  id?: string;
  stale: boolean;
  syncedAt?: string;
  /** Why its catalog could not be read at all, or why it is stale. */
  finding?: Finding;
};

/** A project as the registry and catalogs name it, before its view is built: what a name is matched against. */
export type KnownProject = {
  id: string;
  address: string;
  root: string;
  path: string;
  dir?: string;
  /** Its stub, when one is here: restore reads the store it names. */
  stub?: string;
};

/** What a project's view includes beyond its state: its folder's size (ls), its local planning (status). */
export type ViewOptions = { sizes?: boolean; detail?: boolean };

export type ProjectSet = {
  known: KnownProject[];
  stores: StoreView[];
  /** Warnings from reading config, roots and catalogs. */
  findings: Finding[];
  /** Every journal this version cannot read: each holds its project back, or every project when it names none. */
  unreadableJournals: string[];
  /** The view of one known project, built now. */
  view(id: string, options?: ViewOptions): Promise<ProjectStatus>;
};

export type Views = {
  projects: ProjectStatus[];
  stores: StoreView[];
  /** Warnings from reading config, roots and catalogs. */
  findings: Finding[];
  /** Every journal this version cannot read: each holds its project back, or every project when it names none. */
  unreadableJournals: string[];
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

/** Every project this device knows, read once; each one's view is built when asked for (see the file comment). */
export const loadProjects = async (deps: ViewDeps): Promise<Result<ProjectSet>> => {
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
  let opened: JournalsRead;
  try {
    opened = await readJournals(io, paths);
  } catch (error) {
    // A journal folder that cannot be listed may hold any project's interrupted operation: never "no journals".
    const code = systemErrorCode(error);
    findings.push(
      finding("fs.unreadable", {
        message: `the journal folder ${paths.journalDir} cannot be read (${code}), so interrupted operations cannot be shown`,
        fix: `check that you can read ${paths.journalDir}, then plainport recover`,
        paths: [paths.journalDir],
      }),
    );
    opened = { journals: [], unreadable: [paths.journalDir], owners: {} };
  }
  const journals = opened.journals;

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

  // Sizing never walks a plugin's dependency folders, nor git's own (a repository's history is not the project's size).
  const skip = new Set([".git", ...(deps.plugins ?? []).flatMap((plugin) => plugin.dependencyFolders ?? [])]);
  const ids = new Set<string>(Object.keys(registry.value.projects));
  for (const read of reads) for (const id of Object.keys(read.state.projects)) ids.add(id);
  /** Each project's registry entry, catalog and store read, by id: what its view is built from. */
  const sources = new Map<
    string,
    { known: KnownProject; entry?: RegistryEntry; catalog?: CatalogProject; read?: Read }
  >();
  for (const id of [...ids].sort()) {
    const entry = registry.value.projects[id];
    // The store whose catalog holds it, else its root's store, whose staleness it shares.
    const found =
      reads.find((r) => r.state.projects[id] !== undefined) ??
      reads.find((r) => r.store === storeOfRoot(entry));
    const catalog = found?.state.projects[id];
    const root = entry?.root ?? (catalog === undefined ? "" : (keyOf.get(catalog.root) ?? catalog.root));
    const path = entry?.path ?? catalog?.path ?? "";
    const rootPath = roots.get(root)?.path;
    const dir = entry?.override ?? (rootPath === undefined ? undefined : join(rootPath, ...path.split("/")));
    const stub =
      dir !== undefined && (await kindAt(io, `${dir}${STUB_SUFFIX}`)) === "file"
        ? `${dir}${STUB_SUFFIX}`
        : undefined;
    sources.set(id, {
      known: {
        id,
        address: `${root}:${path}`,
        root,
        path,
        ...(dir === undefined ? {} : { dir }),
        ...(stub === undefined ? {} : { stub }),
      },
      ...(entry === undefined ? {} : { entry }),
      ...(catalog === undefined ? {} : { catalog }),
      ...(found === undefined ? {} : { read: found }),
    });
  }
  const known = [...sources.values()]
    .map((s) => s.known)
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return ok({
    known,
    stores,
    findings,
    unreadableJournals: opened.unreadable,
    view: async (id, options = {}) => {
      const source = sources.get(id);
      if (source === undefined) throw new Error(`no project ${id} in this set`);
      return viewOf(
        source,
        journals.filter((j) => j.project.id === id),
        unreadableOf(opened, new Set([id])),
        options,
      );
    },
  });

  async function viewOf(
    source: { known: KnownProject; entry?: RegistryEntry; catalog?: CatalogProject; read?: Read },
    open: Journal[],
    unreadable: string[],
    options: ViewOptions,
  ): Promise<ProjectStatus> {
    const { known: project, entry, catalog, read } = source;
    const { id, root, path, dir, stub } = project;
    const rootView = roots.get(root);
    const here = dir !== undefined && (await kindAt(io, dir)) === "dir";
    const journals: JournalView[] = [];
    for (const j of open.filter(holdsProjectBack))
      journals.push({ op: j.op, kind: j.kind, step: j.step, running: await operationRunning(io, paths, j) });
    const journal = journals.at(-1);
    const running = journal?.running === true;
    const head = catalog?.head ?? null;
    const lease = catalog?.lease ?? null;
    const conditions: ProjectCondition[] = [];
    const conditionDetails: ProjectStatus["conditionDetails"] = [];
    const note = (condition: ProjectCondition, message: string, cause?: Finding): void => {
      conditions.push(condition);
      conditionDetails.push({ condition, message, ...(cause === undefined ? {} : { finding: cause }) });
    };
    let state: ProjectState;
    if (rootView?.state === "unavailable" && entry?.override === undefined) state = "unavailable";
    else if (journal !== undefined) {
      state = journal.kind === "offload" ? "offloading" : "onloading";
      if (running) note("running", `its ${journal.kind} ${journal.op} is running (${journal.step})`);
      else
        note(
          "interrupted",
          `its ${journal.kind} ${journal.op} was interrupted at ${journal.step}; plainport recover finishes or rolls it back`,
        );
    } else if (catalog !== undefined && (catalog.status === "conflicted" || catalog.conflicts.length > 0))
      state = "conflicted";
    else if (here) {
      state = entry?.unhydrated === true ? "restored-unhydrated" : "local";
      if (catalog?.status === "shelved" && stub === undefined && head !== null) {
        // Shelved in the catalog, yet here: kept by diverged-after-commit when its base is the head (D51), else a
        // copy another offload has moved past.
        if (entry?.base === head)
          note(
            "diverged-after-commit",
            `snapshot ${head} was committed, but the folder changed since and was kept here with no stub (D51)`,
          );
        else note("head-moved", `another copy was offloaded since this one came: the head is ${head}`);
      }
    } else if (stub !== undefined) state = "shelved";
    else if (catalog !== undefined) {
      state = catalog.status === "local" ? "local" : "shelved";
      if (catalog.status === "local" && lease?.device === device.id)
        note("folder-missing", `this device holds its lease, but ${dir ?? "its folder"} is not here`);
    } else {
      state = "local";
      note("folder-missing", `it is registered here, but ${dir ?? "its folder"} is not here`);
    }
    if (catalog !== undefined && catalog.missing.length > 0)
      note(
        "incomplete",
        `the catalog names snapshots it does not hold (${catalog.missing.join(", ")}), so it has no head (D41)`,
      );
    if (read?.stale === true) {
      const why = stores.find((st) => st.name === read.store)?.finding;
      if (read.syncedAt === undefined)
        note("never-synced", `store ${read.store} did not answer and was never synced`, why);
      else note("stale", `store ${read.store} did not answer; the catalog is as of ${read.syncedAt}`, why);
    }
    // Its store's catalog could not be read at all, from the store or the mirror: nothing here is current.
    const unreadStore = read === undefined ? storeOfRoot(entry) : undefined;
    const unread = unreadStore !== undefined && failedStores.has(unreadStore);
    if (unread)
      note(
        "catalog-unreadable",
        `the catalog of store ${unreadStore} could not be read, from the store or this device's mirror`,
        stores.find((st) => st.name === unreadStore)?.finding,
      );
    if (unreadable.length > 0)
      note(
        "journal-unreadable",
        `${unreadable.join(", ")} cannot be read by this version of plainport and may be an operation of this project`,
      );

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
    // Never offloaded, here: the folder's own size now, without its dependency folders, when sizes are shown.
    if (options.sizes === true && bytes === undefined && head === null && here && dir !== undefined)
      bytes = await treeBytes(io, dir, skip);

    // Released trash awaiting deletion: its deadline, or its detached delete still running (D64).
    const trash: ProjectStatus["trash"] = [];
    for (const j of open) {
      if (j.kind !== "offload" || holdsProjectBack(j)) continue;
      const at = j.trash ?? offloadTrashOf(j as OffloadJournal);
      trash.push({
        op: j.op,
        path: at,
        ...(j.keepUntil === undefined ? {} : { keepUntil: j.keepUntil }),
        deleting: (await claimedReason(io, at, device.id)) !== undefined,
        due: j.keepUntil === undefined || Date.parse(j.keepUntil) <= now.getTime(),
      });
    }

    // Its local details (status): the offload's read-only planning, as --dry-run makes it, saving no plan.
    let details: { gitWarnings?: Finding[]; strippableBytes?: number } = {};
    if (
      options.detail === true &&
      deps.planning !== undefined &&
      here &&
      dir !== undefined &&
      journal === undefined
    ) {
      const planned = await planOffload(deps.planning.host, deps.planning.checks, deps.planning.plugins, {
        dir,
        project: { address: project.address, root, path, id },
        loader: deps.loader,
        env: deps.env,
        now,
      });
      if (planned.ok)
        details = {
          gitWarnings: planned.value.findings.filter((f) => f.code.startsWith("git.")),
          strippableBytes: planned.value.strip.reduce((sum, st) => sum + st.bytes, 0),
        };
      else findings.push(planned.finding);
    }
    const lastActivity = newest([
      ...Object.values(catalog?.snapshots ?? {}).map((s) => s.at),
      lease?.at,
      entry?.onloadedAt,
    ]);
    const view: ProjectStatus = {
      address: project.address,
      root,
      path,
      id,
      state,
      conditions,
      conditionDetails,
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
      ...(journal === undefined ? {} : { journal }),
      journals,
      trash,
      ...(unreadable.length === 0 ? {} : { unreadableJournals: unreadable }),
      ...details,
    };
    const next = nextStep(view);
    return next === undefined ? view : { ...view, next };
  }
};

/** Every project this device knows, each with its full view (ls). */
export const projectViews = async (deps: ViewDeps, options: ViewOptions = {}): Promise<Result<Views>> => {
  const set = await loadProjects(deps);
  if (!set.ok) return set;
  const projects: ProjectStatus[] = [];
  for (const known of set.value.known) projects.push(await set.value.view(known.id, options));
  const { stores, findings, unreadableJournals } = set.value;
  return ok({ projects, stores, findings, unreadableJournals });
};

/** What to do next for a project in this view, when anything is to be done. */
export const nextStep = (p: ProjectStatus): { command: string; reason: string } | undefined => {
  const address = shellWord(p.address);
  if (p.journals.some((j) => !j.running))
    return { command: "plainport recover", reason: "an operation of it was interrupted" };
  if (p.unreadableJournals !== undefined)
    return {
      command: "plainport recover",
      reason: "a journal this version cannot read may be its operation; recover reports it",
    };
  if (p.conditions.includes("diverged-after-commit"))
    return {
      command: `plainport offload ${address} --yes`,
      reason: `keep working in the folder; the next offload builds on snapshot ${p.head}`,
    };
  if (p.conditions.includes("incomplete"))
    return {
      command: `plainport restore ${address} --snapshot <id> --to <path>`,
      reason:
        "the catalog misses snapshots: connect the store that holds every snapshot; meanwhile restore reads a snapshot it holds side by side",
    };
  if (p.state === "conflicted")
    return {
      command: `plainport restore ${address} --snapshot <id> --to <path>`,
      reason:
        "the catalog holds a fork: restore reads either copy side by side (settling which copy wins arrives in M2)",
    };
  if (p.trash.some((t) => t.due && !t.deleting))
    return { command: "plainport gc", reason: "a released trash is due and nothing is deleting it" };
  if (p.state === "restored-unhydrated")
    return { command: `plainport hydrate ${address}`, reason: "its dependencies are not installed" };
  if (p.state === "shelved") return { command: `plainport onload ${address}`, reason: "it is offloaded" };
  if (p.state === "unavailable")
    return { command: "plainport root list", reason: "mount the volume its root lives on" };
  return undefined;
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
