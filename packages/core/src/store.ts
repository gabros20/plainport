// Stores from config (DESIGN.md "Storage → Store kinds", "Configuration"): reading a store's repository password from
// its secret reference, setting a store up once (init), and opening a set-up store for an operation.
//
// Secrets stay references (AGENTS.md rule 9): config names where the password is, never the password. M1 reads two
// providers, `env:NAME` and `file:PATH`; Keychain, 1Password and the rest arrive with M2. A local store that names
// no secret reads DEFAULT_LOCAL_SECRET. The password goes to the engine only, which hands it to restic in the
// child's environment and cuts it out of every message.
//
// Setting a store up (D45): its folder is made if only that folder is missing (never a missing disk's mount point),
// its identity file meta/v1/store.json is created once, its restic repository is created when it has none, and this
// device records the store's id under its name in registry.json. Every step is idempotent, so `plainport init` can
// run again to finish a setup that stopped half way.
//
// The id recorded under a name is a pin (D85): once a name has an id, setup only finishes that same store. A store
// that answers with another id, or with none (a swapped disk, a changed path), is refused with store.identity-changed
// before anything is written: no folder, no identity file, no repository, no registry change. A new store needs a
// new name.

import { dirname } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";
import { ensureStoreIdentity, identityChanged, readStoreIdentity } from "./catalog/identity.ts";
import { DEFAULT_LOCAL_SECRET, type ResolvedConfig, type Store } from "./config/schema.ts";
import { type LocalIo, systemErrorCode } from "./io.ts";
import { type Env, expandHome, type PlainportPaths } from "./paths.ts";
import type { OpenedStore, StoreOpener } from "./ports/store.ts";
import { readRegistry, updateRegistry } from "./registry.ts";
import { registeredFolders } from "./saga/project-gate.ts";
import { storeOverlap } from "./store-overlap.ts";

const secretMissing = (name: string, message: string, fix: string) =>
  fail(finding("store.secret-missing", { message: `store ${name}'s password: ${message}`, fix }));

/** The store's secret reference: its own, or DEFAULT_LOCAL_SECRET for a local store that names none. */
export const secretRefOf = (store: Store): string | undefined =>
  "secret" in store && store.secret !== undefined
    ? store.secret
    : store.kind === "local"
      ? DEFAULT_LOCAL_SECRET
      : undefined;

/**
 * The environment variables that hold a secret by the configuration's references: every store's `env:` password
 * (DEFAULT_LOCAL_SECRET included) and the recovery secret's. Code plainport does not trust never sees them (D79).
 */
export const secretVariables = (config: ResolvedConfig): string[] => {
  const refs = [...Object.values(config.stores).map(secretRefOf), config.secrets?.recovery];
  const names = refs.flatMap((ref) => (ref?.startsWith("env:") ? [ref.slice("env:".length)] : []));
  return [...new Set(names)].sort();
};

/** Reads a secret reference: `env:NAME` from the environment, `file:PATH` from a file (one trailing newline cut). */
export const resolveSecret = async (
  io: LocalIo,
  env: Env,
  home: string,
  name: string,
  ref: string | undefined,
): Promise<Result<string>> => {
  if (ref === undefined)
    return secretMissing(
      name,
      "config names no secret",
      `set stores.${name}.secret to an env: or file: reference`,
    );
  const at = ref.indexOf(":");
  const provider = ref.slice(0, at);
  const target = ref.slice(at + 1);
  if (provider === "env") {
    const value = env[target];
    if (value !== undefined && value !== "") return ok(value);
    return secretMissing(
      name,
      `${target} is not set (secret = "${ref}")`,
      `export ${target} with the repository password from your password manager, then re-run`,
    );
  }
  if (provider === "file") {
    const path = expandHome(target, home, home);
    let text: string;
    try {
      text = await io.fs.readText(path);
    } catch (error) {
      return secretMissing(
        name,
        `${path} could not be read (${systemErrorCode(error)})`,
        `put the repository password in ${path}, readable only by you (chmod 600), then re-run`,
      );
    }
    const value = text.replace(/\r?\n$/, "");
    if (value !== "") return ok(value);
    return secretMissing(name, `${path} is empty`, `put the repository password in ${path}, then re-run`);
  }
  return secretMissing(
    name,
    `the ${provider}: provider arrives in M2; this build reads env: and file: references`,
    `set stores.${name}.secret to "env:<VARIABLE>" or "file:<path>"`,
  );
};

/** The folder a local store lives in, absolute. */
export const storeRoot = (store: Extract<Store, { kind: "local" }>, home: string): string =>
  expandHome(store.path, home, home);

const unsupported = (name: string, store: Store) =>
  fail(
    finding("store.unsupported", {
      message: `store ${name} is a ${store.kind} store; this build uses local stores only (M1)`,
      fix: `point the root at a local store (an external disk), e.g. plainport init --store-path <path> --store <name> --yes`,
    }),
  );

export interface StoreSetup {
  id: string;
  /** This run created the identity file, the restic repository, the id's record in registry.json. */
  identityCreated: boolean;
  repositoryCreated: boolean;
  recorded: boolean;
  path: string;
}

export interface SetUpStoreOptions {
  paths: PlainportPaths;
  env: Env;
  name: string;
  store: Store;
  opener: StoreOpener;
  mint: () => string;
}

type SetUpOptions = Omit<SetUpStoreOptions, "mint">;

const unreachableAt = (name: string, root: string, detail: string) =>
  fail(
    finding("store.unreachable", {
      message: `store ${name} at ${root} cannot be set up: ${detail}`,
      fix: "mount the disk that holds it (or fix stores.<name>.path), then run plainport init --yes",
      paths: [root],
    }),
  );

/**
 * Whether `path` is a folder: undefined when nothing is there; store.unreachable when it cannot be looked at (a failing
 * or locked disk), never an exception (AGENTS.md rule 7).
 */
const folderAt = async (
  io: LocalIo,
  path: string,
  name: string,
  root: string,
): Promise<Result<boolean | undefined>> => {
  try {
    return ok((await io.fs.stat(path)).kind === "dir");
  } catch (error) {
    const code = systemErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return ok(undefined);
    return unreachableAt(name, root, `${path} cannot be looked at (${code})`);
  }
};

/** The store's folder and its parent, checked: the folder's state, or store.unreachable when it cannot hold a store. */
const storeFolder = async (io: LocalIo, name: string, root: string): Promise<Result<boolean | undefined>> => {
  const parent = dirname(root);
  const above = await folderAt(io, parent, name, root);
  if (!above.ok) return above;
  if (above.value !== true)
    return unreachableAt(name, root, `${parent} is not a folder (a disk not mounted?)`);
  const here = await folderAt(io, root, name, root);
  if (!here.ok) return here;
  if (here.value === false) return unreachableAt(name, root, `${root} is not a folder`);
  return here;
};

const openWithSecret = async (io: LocalIo, options: SetUpOptions): Promise<Result<OpenedStore>> => {
  const password = await resolveSecret(
    io,
    options.env,
    options.paths.home,
    options.name,
    secretRefOf(options.store),
  );
  if (!password.ok) return password;
  return options.opener.open(options.name, options.store, password.value);
};

/**
 * The id `options.name` is pinned to on this device, checked against the store `options.store` points at (D85):
 * null when the name has no id yet, store.identity-changed when the store there carries another id or none. Reads
 * only: it never makes a folder or writes to the store or the registry.
 */
export const checkStorePin = async (io: LocalIo, options: SetUpOptions): Promise<Result<string | null>> => {
  const { name, store, paths } = options;
  if (store.kind !== "local") return unsupported(name, store);
  const registry = await readRegistry(io, paths);
  if (!registry.ok) return registry;
  const pinned = registry.value.stores?.[name];
  if (pinned === undefined) return ok(null);
  const root = storeRoot(store, paths.home);
  const folder = await storeFolder(io, name, root);
  if (!folder.ok) return folder;
  const here = folder.value;
  const changed = (found: string | null) => {
    const refused = identityChanged(pinned, found, `store at ${root}`);
    return fail({
      ...refused.finding,
      message: `store ${name} is pinned on this device to ${pinned}: ${refused.finding.message}`,
      fix: `point stores.${name}.path back at the disk this device set up as ${name}; to use the store at ${root}, give it a new name: plainport init --store-path ${root} --store <new-name> --yes`,
      paths: [root],
    });
  };
  if (here === undefined) return changed(null);
  const reached = await openWithSecret(io, options);
  if (!reached.ok) return reached;
  const identity = await readStoreIdentity(reached.value.blob);
  if (!identity.ok) return identity;
  return identity.value === pinned ? ok(pinned) : changed(identity.value);
};

/** Sets a store up (see above): store.unreachable when the folder that should hold it is missing. */
export const setUpStore = async (io: LocalIo, options: SetUpStoreOptions): Promise<Result<StoreSetup>> => {
  const { name, store, paths } = options;
  if (store.kind !== "local") return unsupported(name, store);
  const pin = await checkStorePin(io, options);
  if (!pin.ok) return pin;
  const root = storeRoot(store, paths.home);
  const folder = await storeFolder(io, name, root);
  if (!folder.ok) return folder;
  // Never inside, or holding, a registered project's folder: its offload would delete the store (D83).
  const projects = await registeredFolders(io, paths, options.env);
  if (!projects.ok) return projects;
  for (const project of projects.value) {
    const overlap = await storeOverlap(io, paths.home, project.folder, [{ name, root }]);
    if (!overlap.ok) return overlap;
  }
  if (folder.value === undefined) {
    try {
      await io.fs.mkdirp(root);
    } catch (error) {
      return unreachableAt(name, root, `${root} could not be made (${systemErrorCode(error)})`);
    }
  }

  const open = await openWithSecret(io, options);
  if (!open.ok) return open;
  const identity = await ensureStoreIdentity(open.value.blob, options.mint);
  if (!identity.ok) return identity;

  let repositoryCreated = false;
  const listed = await open.value.engine.list({ tags: ["plainport"] });
  if (!listed.ok) {
    if (listed.finding.code !== "restic.repo-missing") return listed;
    const made = await open.value.engine.init();
    if (!made.ok) return made;
    repositoryCreated = true;
  }

  let recorded = false;
  const updated = await updateRegistry(io, paths, (registry) => {
    const current = registry.stores?.[name];
    // Another init may have pinned the name since the check: the pin stands (D85).
    if (current !== undefined && current !== identity.value.id)
      return identityChanged(current, identity.value.id, `store at ${root}`);
    recorded = current === undefined;
    return ok(
      recorded ? { ...registry, stores: { ...registry.stores, [name]: identity.value.id } } : registry,
    );
  });
  if (!updated.ok) return updated;
  return ok({
    id: identity.value.id,
    identityCreated: identity.value.created,
    repositoryCreated,
    recorded,
    path: root,
  });
};

export interface ConfiguredStore extends OpenedStore {
  name: string;
  /** The id this device recorded for the store (D45); the catalog read checks the store still carries it. */
  id: string;
  store: Store;
}

/**
 * A store an operation can use: named in config, set up on this device (its id recorded), of a kind this build
 * supports, with its password read. Nothing is reached yet.
 */
export const openStore = async (
  io: LocalIo,
  options: { paths: PlainportPaths; env: Env; name: string; config: ResolvedConfig; opener: StoreOpener },
): Promise<Result<ConfiguredStore>> => {
  const { name, paths } = options;
  const store = options.config.stores[name];
  const setUp = `plainport init --store-path <path> --store ${name} --yes`;
  if (store === undefined) {
    return fail(
      finding("store.not-set-up", {
        message: `no store named ${name} is configured`,
        fix: setUp,
      }),
    );
  }
  if (store.kind !== "local") return unsupported(name, store);
  const registry = await readRegistry(io, paths);
  if (!registry.ok) return registry;
  const id = registry.value.stores?.[name];
  if (id === undefined) {
    return fail(
      finding("store.not-set-up", {
        message: `store ${name} at ${store.path} is configured but this device has not set it up (no id recorded in ${paths.registryFile})`,
        fix: "plainport init --yes sets up the stores already configured",
      }),
    );
  }
  const password = await resolveSecret(io, options.env, paths.home, name, secretRefOf(store));
  if (!password.ok) return password;
  const opened = await options.opener.open(name, store, password.value);
  if (!opened.ok) return opened;
  return ok({ ...opened.value, name, id, store });
};
