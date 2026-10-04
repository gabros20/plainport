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

import { dirname } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";
import { ensureStoreIdentity } from "./catalog/identity.ts";
import { DEFAULT_LOCAL_SECRET, type ResolvedConfig, type Store } from "./config/schema.ts";
import { type LocalIo, systemErrorCode } from "./io.ts";
import { type Env, expandHome, type PlainportPaths } from "./paths.ts";
import type { OpenedStore, StoreOpener } from "./ports/store.ts";
import { readRegistry, updateRegistry } from "./registry.ts";

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

/** Sets a store up (see above): store.unreachable when the folder that should hold it is missing. */
export const setUpStore = async (io: LocalIo, options: SetUpStoreOptions): Promise<Result<StoreSetup>> => {
  const { name, store, paths } = options;
  if (store.kind !== "local") return unsupported(name, store);
  const root = storeRoot(store, paths.home);
  const parent = dirname(root);
  const isFolder = async (path: string): Promise<boolean | undefined> => {
    try {
      return (await io.fs.stat(path)).kind === "dir";
    } catch (error) {
      const code = systemErrorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw error;
    }
  };
  const unreachable = (detail: string) =>
    fail(
      finding("store.unreachable", {
        message: `store ${name} at ${root} cannot be set up: ${detail}`,
        fix: "mount the disk that holds it (or fix stores.<name>.path), then run plainport init --yes",
        paths: [root],
      }),
    );
  if ((await isFolder(parent)) !== true)
    return unreachable(`${parent} is not a folder (a disk not mounted?)`);
  const here = await isFolder(root);
  if (here === false) return unreachable(`${root} is not a folder`);
  if (here === undefined) await io.fs.mkdirp(root);

  const password = await resolveSecret(io, options.env, paths.home, name, secretRefOf(store));
  if (!password.ok) return password;
  const opened = await options.opener.open(name, store, password.value);
  if (!opened.ok) return opened;
  const identity = await ensureStoreIdentity(opened.value.blob, options.mint);
  if (!identity.ok) return identity;

  let repositoryCreated = false;
  const listed = await opened.value.engine.list({ tags: ["plainport"] });
  if (!listed.ok) {
    if (listed.finding.code !== "restic.repo-missing") return listed;
    const made = await opened.value.engine.init();
    if (!made.ok) return made;
    repositoryCreated = true;
  }

  let recorded = false;
  const updated = await updateRegistry(io, paths, (registry) => {
    recorded = registry.stores?.[name] !== identity.value.id;
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
