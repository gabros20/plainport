// Roots (DESIGN.md "Roots", ADR-0010): named folders of projects, each bound to its own path on every device.
// Reading merges config.toml over managed.toml; writing goes to managed.toml only, under its lock, so the checks
// (a duplicate key, overlapping real paths) and the write cannot race another writer. config.toml wins: a key it
// sets is never shadowed by a copy in managed.toml, and the refusal names the key to edit there.

import { sep } from "node:path";
import { type Finding, fail, finding, ok, type Result } from "@plainport/contract";
import { ConfigLoader } from "../config/load.ts";
import { updateManaged } from "../config/managed.ts";
import { type ConfigLayer, ConfigLayerSchema } from "../config/schema.ts";
import { readTomlFile } from "../config/toml.ts";
import type { LocalIo } from "../io.ts";
import { type Env, expandHome, type PlainportPaths } from "../paths.ts";
import { RootKeySchema } from "../registry.ts";
import { canonicalPath, overlapOf, probeKind } from "./canonical.ts";

type RootTable = NonNullable<ConfigLayer["roots"]>[string];

export type RootState = "ok" | "unbound" | "missing" | "unavailable";

export interface RootView {
  key: string;
  label?: string;
  store?: string;
  devices?: string[];
  /** Device name → that device's folder, as the config files write it. */
  bindings: Record<string, string>;
  /** This device's folder, absolute; absent when the root is not bound here. */
  path?: string;
  /** ok; unbound (no folder on this device); missing (the folder is gone); unavailable (its volume is unmounted). */
  state: RootState;
  /** Which config file defines the root. */
  source: "config" | "managed" | "both";
  scan?: RootTable["scan"];
}

/** `~/…` for a path inside the home folder, so a managed.toml stays readable and portable; else the path itself. */
export const displayPath = (path: string, home: string): string =>
  path === home ? "~" : path.startsWith(`${home}${sep}`) ? `~/${path.slice(home.length + 1)}` : path;

/** A binding as an absolute path; a relative one is taken relative to the home folder. */
export const bindingPath = (binding: string, home: string): string => expandHome(binding, home, home);

/** What is at the path, for display: a path that cannot be read counts as missing. */
const kindAt = async (io: LocalIo, path: string): Promise<"dir" | "file" | "other" | undefined> => {
  const probed = await probeKind(io, path);
  return probed.ok ? probed.value : undefined;
};

/** A path under `/Volumes/<name>` whose volume is not mounted. */
const onUnmountedVolume = async (io: LocalIo, path: string): Promise<boolean> => {
  const match = /^\/Volumes\/[^/]+/.exec(path);
  return match !== null && (await kindAt(io, match[0])) === undefined;
};

const stateOf = async (io: LocalIo, path: string | undefined): Promise<RootState> => {
  if (path === undefined) return "unbound";
  if ((await kindAt(io, path)) === "dir") return "ok";
  return (await onUnmountedVolume(io, path)) ? "unavailable" : "missing";
};

/** The two files' root tables, as written; a file that is missing or broken reads as empty here. */
const rootLayers = async (
  io: LocalIo,
  paths: PlainportPaths,
): Promise<{ user: ConfigLayer; managed: ConfigLayer }> => {
  const read = async (path: string): Promise<ConfigLayer> => {
    const result = await readTomlFile(io, path, ConfigLayerSchema);
    return result.kind === "ok" ? result.value : {};
  };
  return { user: await read(paths.configFile), managed: await read(paths.managedFile) };
};

export interface ListOptions {
  env: Env;
  /** This device's name; without it no root is bound here. */
  device?: string;
}

/** Every root with its bindings and its state on this device, plus a root.defined-twice warning per shared key. */
export const listRoots = async (
  io: LocalIo,
  paths: PlainportPaths,
  options: ListOptions,
): Promise<Result<{ roots: RootView[]; findings: Finding[] }>> => {
  const loaded = await new ConfigLoader(io, paths).load({ env: options.env });
  if (!loaded.ok) return loaded;
  const { user, managed } = await rootLayers(io, paths);
  const findings: Finding[] = [...loaded.value.findings];
  const roots: RootView[] = [];
  for (const [key, root] of Object.entries(loaded.value.config.roots)) {
    const inUser = user.roots?.[key] !== undefined;
    const inManaged = managed.roots?.[key] !== undefined;
    if (inUser && inManaged) {
      findings.push(
        finding("root.defined-twice", {
          message: `config.toml and managed.toml both define root ${key}; config.toml's settings win`,
          fix: `edit root ${key} in ${paths.configFile}, or remove it there to let plainport manage it in managed.toml`,
          paths: [paths.configFile, paths.managedFile],
        }),
      );
    }
    const binding = options.device === undefined ? undefined : root.on?.[options.device];
    const path = binding === undefined ? undefined : bindingPath(binding, paths.home);
    roots.push({
      key,
      ...(root.label !== undefined && { label: root.label }),
      ...(root.store !== undefined && { store: root.store }),
      ...(root.devices !== undefined && { devices: root.devices }),
      bindings: { ...root.on },
      ...(path !== undefined && { path }),
      state: await stateOf(io, path),
      source: inUser && inManaged ? "both" : inUser ? "config" : "managed",
      ...(root.scan !== undefined && { scan: root.scan }),
    });
  }
  return ok({ roots, findings });
};

export type RootChange =
  | { kind: "add"; key: string; label?: string; store?: string; path?: string }
  | { kind: "bind"; key: string; path: string };

export interface WriteRootsOptions {
  /** This device's name: bindings are written under it. */
  device: string;
  /** What a relative path is resolved against. */
  cwd: string;
  changes: readonly RootChange[];
  /** Create a binding's folder when it does not exist. */
  create?: boolean;
  /** A local store to record, make the default, and give to each root added here (`init --store-path`). */
  store?: { name: string; path: string };
  /** Runs under the lock once every check has passed, before anything is created or written; a refusal stops it. */
  beforeWrite?: () => Promise<Result<unknown>>;
  timeoutMs?: number;
}

export interface WrittenRoots {
  roots: { key: string; path?: string }[];
  store?: { name: string; path: string };
  /** Warnings, such as root.synced-folder. */
  findings: Finding[];
}

const SYNCED = [`${sep}Library${sep}Mobile Documents${sep}`, `${sep}Library${sep}CloudStorage${sep}`];

const inSyncedFolder = (path: string, home: string): boolean =>
  SYNCED.some((part) => `${path}${sep}`.includes(part)) ||
  `${path}${sep}`.startsWith(`${home}${sep}Dropbox${sep}`);

const RELATION = { same: "is the same folder as", inside: "is inside", contains: "contains" } as const;

/** Applies root additions and bindings to managed.toml in one locked write: all of them, or none. */
export const writeRoots = async (
  io: LocalIo,
  paths: PlainportPaths,
  options: WriteRootsOptions,
): Promise<Result<WrittenRoots>> => {
  const { device } = options;
  const home = paths.home;
  let written: WrittenRoots = { roots: [], findings: [] };

  const result = await updateManaged(
    io,
    paths,
    async (working) => {
      written = { roots: [], findings: [] };
      const userRead = await readTomlFile(io, paths.configFile, ConfigLayerSchema);
      if (userRead.kind === "invalid") {
        return fail(
          finding("config.invalid", {
            message: `${paths.configFile} is not valid: ${userRead.message}`,
            fix: `fix ${paths.configFile}, then re-run`,
            paths: [paths.configFile],
          }),
        );
      }
      const user: ConfigLayer = userRead.kind === "ok" ? userRead.value : {};
      const roots: Record<string, RootTable> = { ...working.roots };
      const exists = (key: string) => user.roots?.[key] !== undefined || roots[key] !== undefined;
      const bindingOf = (key: string): string | undefined =>
        user.roots?.[key]?.on?.[device] ?? roots[key]?.on?.[device];
      const toCreate: string[] = [];
      const added: string[] = [];

      for (const change of options.changes) {
        const { key } = change;
        if (!RootKeySchema.safeParse(key).success) {
          return fail(
            finding("usage.invalid", {
              message: `${JSON.stringify(key)} is not a root key: use a lower-case word of letters, digits and hyphens`,
              fix: "name the root with a lower-case word, e.g. work",
            }),
          );
        }
        if (change.kind === "add") {
          if (exists(key)) {
            const where = user.roots?.[key] !== undefined ? paths.configFile : paths.managedFile;
            return fail(
              finding("root.exists", {
                message: `root ${key} already exists (in ${where})`,
                fix: `plainport root bind ${key} <path> points it at a folder on this device`,
                paths: [where],
              }),
            );
          }
          roots[key] = {
            ...(change.label !== undefined && { label: change.label }),
            ...(change.store !== undefined && { store: change.store }),
          };
          added.push(key);
        } else if (!exists(key)) {
          return fail(
            finding("root.not-found", {
              message: `there is no root ${key}`,
              fix: `plainport root add ${key} <path> creates it; plainport root list shows every root`,
            }),
          );
        }
        if (change.path === undefined) {
          written.roots.push({ key });
          continue;
        }

        const path = expandHome(change.path, home, options.cwd);
        const owned = user.roots?.[key]?.on?.[device];
        if (owned !== undefined) {
          if (bindingPath(owned, home) === path) {
            written.roots.push({ key, path });
            continue;
          }
          return fail(
            finding("config.owned", {
              message: `${paths.configFile} binds root ${key} to ${owned} on ${device}, and config.toml wins over managed.toml`,
              fix: `edit roots.${key}.on.${device} in ${paths.configFile}`,
              paths: [paths.configFile],
            }),
          );
        }
        const probed = await probeKind(io, path);
        if (!probed.ok) return probed;
        const kind = probed.value;
        if (kind === undefined && options.create !== true) {
          return fail(
            finding("root.path-missing", {
              message: `${path} does not exist`,
              fix: "create the folder, or pass --create to have plainport create it",
              paths: [path],
            }),
          );
        }
        if (kind !== undefined && kind !== "dir") {
          return fail(
            finding("root.path-missing", {
              message: `${path} is not a folder`,
              fix: "bind the root to a folder",
              paths: [path],
            }),
          );
        }
        if (kind === "dir" && !(await io.fs.writable(path))) {
          return fail(
            finding("root.not-writable", {
              message: `plainport cannot write to ${path}`,
              fix: `make it writable (chmod u+w ${path}), or bind the root to another folder`,
              paths: [path],
            }),
          );
        }

        const resolved = await canonicalPath(io, path, options.cwd);
        if (!resolved.ok) return resolved;
        const canon = resolved.value;
        const others = new Set([...Object.keys(user.roots ?? {}), ...Object.keys(roots)]);
        others.delete(key);
        for (const other of [...others].sort()) {
          const binding = bindingOf(other);
          if (binding === undefined) continue;
          const otherPath = bindingPath(binding, home);
          const otherResolved = await canonicalPath(io, otherPath, home);
          if (!otherResolved.ok) {
            return fail({
              ...otherResolved.finding,
              message: `root ${other}'s folder cannot be checked for overlap: ${otherResolved.finding.message}`,
              fix: `fix root ${other}'s folder, or point it elsewhere: plainport root bind ${other} <path>`,
            });
          }
          const otherCanon = otherResolved.value;
          const relation = overlapOf(canon, otherCanon);
          if (relation === undefined) continue;
          const realNote =
            canon.real !== path || otherCanon.real !== otherPath
              ? ` (real paths ${canon.real} and ${otherCanon.real})`
              : "";
          return fail(
            finding("root.overlap", {
              message: `root ${key} at ${path} ${RELATION[relation]} root ${other} at ${otherPath}${realNote}; roots cannot overlap, so every project belongs to one root`,
              fix: `choose a folder that neither contains nor sits inside root ${other}; plainport root list shows every root's folder`,
              paths: [path, otherPath],
            }),
          );
        }
        if (inSyncedFolder(path, home) || inSyncedFolder(canon.real, home)) {
          written.findings.push(
            finding("root.synced-folder", {
              message: `root ${key} at ${path} is inside a synced folder (iCloud Drive or Dropbox), whose sync client fights with node_modules and half-written files`,
              fix: "bind the root to a folder outside iCloud Drive and Dropbox",
              paths: [path],
            }),
          );
        }
        if (kind === undefined) toCreate.push(path);
        roots[key] = { ...roots[key], on: { ...roots[key]?.on, [device]: displayPath(path, home) } };
        written.roots.push({ key, path });
      }

      const next: ConfigLayer = { ...working, roots };
      if (options.store !== undefined) {
        const { name } = options.store;
        const path = expandHome(options.store.path, home, options.cwd);
        const theirs = user.stores?.[name];
        if (theirs !== undefined) {
          const same =
            theirs.kind === "local" && theirs.path !== undefined && bindingPath(theirs.path, home) === path;
          if (!same) {
            return fail(
              finding("config.owned", {
                message: `${paths.configFile} already defines store ${name}, and config.toml wins over managed.toml`,
                fix: `edit stores.${name} in ${paths.configFile}, or name another store with --store <name>`,
                paths: [paths.configFile],
              }),
            );
          }
        } else {
          next.stores = { ...next.stores, [name]: { kind: "local", path: displayPath(path, home) } };
        }
        if (user.defaultStore === undefined) next.defaultStore = name;
        for (const key of added) {
          const root = roots[key];
          if (root !== undefined && root.store === undefined && user.roots?.[key]?.store === undefined) {
            roots[key] = { ...root, store: name };
          }
        }
        written.store = { name, path };
      }

      if (options.beforeWrite !== undefined) {
        const before = await options.beforeWrite();
        if (!before.ok) return before;
      }
      for (const path of toCreate) {
        try {
          await io.fs.mkdirp(path);
        } catch (error) {
          return fail(
            finding("root.not-writable", {
              message: `plainport could not create ${path}: ${error instanceof Error ? error.message : String(error)}`,
              fix: "create the folder yourself, or bind the root to another folder",
              paths: [path],
            }),
          );
        }
      }
      return ok(next);
    },
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  );
  if (!result.ok) return result;
  return ok(written);
};
