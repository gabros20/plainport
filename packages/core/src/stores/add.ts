// `plainport store add <name>` (Q13: safe_write; DESIGN.md "Bootstrap"): sets a store up, or adopts one that is set up
// already, and records it in managed.toml under its lock. It sends only setup files: a new store gets its own repository
// (repos/<attempt>/) and, if this attempt wins the election, its format-2 store.json; an adopted one gets nothing, its
// repository only opened with this device's password (saga/bootstrap.ts).
//
// The order keeps every refusal ahead of every write:
//   1. the table is checked against what config already says under the name: the same table is a re-run (idempotent),
//      another one is refused, since a name never moves to another store (D85, D68);
//   2. a local store's folder is made ready (prepareLocalStore: holders, overlap, a mounted disk);
//   3. with --secret-stdin, the password is saved to the Keychain under the store's keychain: reference;
//   4. the store is reached and its identity read: a name already pinned here must find the same id (D85), and a store
//      whose upgrade marker stands is refused (Q2);
//   5. managed.toml gets the table (references only, never a value), and the default store when none is set;
//   6. bootstrap runs: published (this attempt won), adopted, or lost, contested, undecided as failures with their data.
// Every step is idempotent, so a re-run finishes a setup that stopped: an open attempt resumes with its id (D99).

import { fail, finding, ok, type Result } from "@plainport/contract";
import { identityChanged, readStoreDescriptor, type SealPolicy } from "../catalog/identity.ts";
import { ConfigLoader } from "../config/load.ts";
import { updateManaged } from "../config/managed.ts";
import { type ConfigLayer, type Store, StoreSchema } from "../config/schema.ts";
import type { LocalIo } from "../io.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import { parseSecretRef } from "../ports/secrets.ts";
import type { StoreOpener } from "../ports/store.ts";
import { readRegistry } from "../registry.ts";
import { type BootstrapPorts, runBootstrap } from "../saga/bootstrap.ts";
import { withFix } from "../saga/journaled.ts";
import { prepareLocalStore, resolveSecret, secretProvidersOf, secretRefOf } from "../store.ts";
import { storeLocation } from "./location.ts";
import { refuseWhileUpgrading } from "./upgrade.ts";

export interface StoreAdded {
  name: string;
  /** The store's id: this attempt's when it won, the published one when adopted. */
  id: string;
  outcome: "published" | "adopted";
  format: 1 | 2;
  /** Where its restic repository lies under the store's root. */
  repo: string;
  location: string;
  /** This run wrote managed.toml. */
  configChanged: boolean;
  /** This run saved the password to the Keychain (--secret-stdin). */
  secretSaved: boolean;
}

export interface AddStoreOptions {
  paths: PlainportPaths;
  env: Env;
  name: string;
  /** The store's table as managed.toml will hold it: references only. */
  store: Store;
  opener: StoreOpener;
  /** Bootstrap's ports: the journal's crash seam, the clock, the election's waits. */
  ports: Omit<BootstrapPorts, "io" | "paths">;
  /** The catalog's seal policy a new store publishes (Q10); plain until sealing lands (Task 20). */
  seal?: SealPolicy;
  /** --secret-stdin: the repository password, saved to the Keychain under the store's keychain: reference. */
  secretValue?: string;
  /** Also make it the default store (init's), else only when none is set. */
  makeDefault?: boolean;
}

/** The fields of a store's table that say which store it is; access, replicateTo and the secrets may change. */
const WHERE: Record<Store["kind"], readonly string[]> = {
  local: ["path"],
  sftp: ["host", "path"],
  s3: ["endpoint", "bucket", "path", "region"],
  peer: ["device", "path"],
};

/** Whether two tables for one name describe the same store and the same secrets. */
const sameTable = (a: Store, b: Store): boolean => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const sorted = (store: Store): Record<string, unknown> =>
  Object.fromEntries(Object.entries(store).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));

const describe = (store: Store, home: string): string =>
  `a ${store.kind} store at ${storeLocation(store, home)}`;

export const addStore = async (io: LocalIo, options: AddStoreOptions): Promise<Result<StoreAdded>> => {
  const { paths, env, name } = options;
  const checked = StoreSchema.safeParse(options.store);
  if (!checked.success)
    return fail(
      finding("usage.invalid", {
        message: `store ${name}'s settings are not valid: ${checked.error.issues.map((i) => `${i.path.join(".") || "store"}: ${i.message}`).join("; ")}`,
        fix: "plainport help store add",
      }),
    );
  const store = checked.data;

  // 1. What config already says under the name.
  const loaded = await new ConfigLoader(io, paths).load({ env });
  if (!loaded.ok) return loaded;
  const existing = loaded.value.config.stores[name];
  if (existing !== undefined && !sameTable(existing, store)) {
    const moved =
      existing.kind !== store.kind ||
      WHERE[store.kind].some(
        (key) => (existing as Record<string, unknown>)[key] !== (store as Record<string, unknown>)[key],
      );
    return fail(
      finding("usage.invalid", {
        message: moved
          ? `store ${name} is already configured as ${describe(existing, paths.home)}; plainport never moves a name to another store, so nothing was changed`
          : `store ${name} is already configured with other settings (its secrets or access); store add does not change a store's settings, so nothing was changed`,
        fix: moved
          ? `give the new store its own name: plainport store add <new-name> …; to forget ${name} first: plainport store remove ${name} --yes`
          : `edit stores.${name} in ${paths.configFile}, or re-run plainport store add ${name} with the settings it has`,
      }),
    );
  }

  // 2. A local store's folder.
  if (store.kind === "local") {
    const prepared = await prepareLocalStore(io, { paths, env, name, store });
    if (!prepared.ok) return prepared;
  }

  // 3. The password, saved where the reference says, before anything reads it.
  let secretSaved = false;
  if (options.secretValue !== undefined) {
    const ref = secretRefOf(store);
    const keychain = options.opener.secrets?.keychain;
    if (ref === undefined || parseSecretRef(ref)?.scheme !== "keychain")
      return fail(
        finding("usage.invalid", {
          message: `--secret-stdin saves the password to the Keychain, but store ${name}'s secret is not a keychain: reference`,
          fix: `pass --secret keychain:plainport/${name} (or another keychain:<service>/<account>) with --secret-stdin`,
        }),
      );
    if (keychain?.set === undefined)
      return fail(
        finding("store.secret-missing", {
          message: `this build cannot write to the Keychain, so store ${name}'s password was not saved; nothing was written`,
          fix: `save it yourself: security add-generic-password -s <service> -a <account> -w, then re-run without --secret-stdin`,
        }),
      );
    const saved = await keychain.set(ref, options.secretValue);
    if (!saved.ok) return saved;
    secretSaved = true;
  }

  // 4. The store, reached: its identity against this device's pin, and no upgrade under way.
  const password = await resolveSecret(
    io,
    env,
    paths.home,
    name,
    secretRefOf(store),
    secretProvidersOf(options.opener),
  );
  if (!password.ok) return password;
  if (options.opener.bootstrap === undefined)
    return fail(
      finding("store.unsupported", {
        message: `this build cannot set store ${name} up (${describe(store, paths.home)}); nothing was written`,
        fix: "use a plainport build that sets stores up (v0.2 or later)",
      }),
    );
  const target = await options.opener.bootstrap(name, store, password.value);
  if (!target.ok) return target;
  const registry = await readRegistry(io, paths);
  if (!registry.ok) return registry;
  const pinned = registry.value.stores?.[name];
  const found = await readStoreDescriptor(target.value.blob);
  if (!found.ok) return found;
  if (pinned !== undefined && found.value?.id !== pinned)
    return withFix(
      identityChanged(pinned, found.value?.id ?? null, `store at ${storeLocation(store, paths.home)}`),
      `point the name back at the store this device set up as ${name} (${pinned}); a different store needs a new name: plainport store add <new-name> …; nothing was written`,
    );
  if (found.value !== null) {
    const quiet = await refuseWhileUpgrading(target.value.blob, name, "store add");
    if (!quiet.ok) return quiet;
  }

  // 5. managed.toml: the table, and the default store when none is set.
  let configChanged = false;
  const fromUser = existing !== undefined;
  const written = await updateManaged(io, paths, (current) => {
    const next: ConfigLayer = { ...current };
    if (!fromUser && current.stores?.[name] === undefined) {
      next.stores = { ...current.stores, [name]: store };
      configChanged = true;
    }
    const setDefault =
      options.makeDefault === true
        ? current.defaultStore !== name
        : loaded.value.config.defaultStore === undefined;
    if (setDefault) {
      next.defaultStore = name;
      configChanged = true;
    }
    return ok(configChanged ? next : current);
  });
  if (!written.ok) return written;

  // 6. Bootstrap: adopt, resume or stand.
  const done = await runBootstrap({ ...options.ports, io, paths }, target.value, {
    name,
    seal: options.seal ?? "none",
  });
  if (!done.ok) return done;
  return ok({
    name,
    id: done.value.id,
    outcome: done.value.outcome,
    format: done.value.format,
    repo: done.value.repo,
    location: storeLocation(store, paths.home),
    configChanged,
    secretSaved,
  });
};
