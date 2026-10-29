// The store opener the binary uses (DESIGN.md "Storage → Store kinds", "Layout on every store"). One store definition
// gives both layers at one root, so they always address the same prefix (Q7):
//
//   local   a folder, on an external disk or this one: events through blob-fs, restic at <root>/<repo>
//   sftp    a folder on an ssh host: events through rclone's SFTP backend, restic at sftp:<host>:<path>/<repo>, both
//           through the system's ssh from PATH with BatchMode=yes and strict host keys (engine-restic's SSH_POLICY)
//   s3      a bucket and a prefix: events through rclone's S3 backend, restic at s3:<endpoint>/<bucket>/<path>/<repo>
//   peer    store.unsupported until M3
//
// <repo> is the repository the store publishes in meta/v1/store.json (`repo` for an M1 store, `repos/<attempt>` for one
// bootstrap set up), read on the engine's first call (core's publishedEngine); bootstrap reaches any repository under
// the root through engineAt. The pinned restic and rclone are found by toolPath. Credentials reach the children only in
// their environment (the password as RESTIC_PASSWORD, an S3 key pair as restic's AWS_ variables and rclone's
// RCLONE_CONFIG_PLAINPORT_ options), and are cut out of everything either says.
//
// A remote store's semantics profile (Q8) is what this device measured of it (the sidecar, Q4, while its facts still
// hold) with what the owner asserts in config (stores.<name>.semantics, evidence `asserted`) over it; anything else is
// unknown, so an operation the profile does not admit refuses (store.semantics-unknown). A local store's is blob-fs's
// own.

import { join } from "node:path";
import { fsBlobStore } from "@plainport/blob-fs";
import { PINNED_RCLONE, type RcloneRemote, rcloneBlobStore } from "@plainport/blob-rclone";
import { fail, finding, ok, type Result } from "@plainport/contract";
import {
  type AssertedSemantics,
  type Env,
  type HostPorts,
  type PlainportPaths,
  publishedEngine,
  readRegistry,
  readStoreState,
  resolvePaths,
  type Store,
  type StoreCredentials,
  type StoreFacts,
  type StoreOpener,
  type StoreSemantics,
  storeLocationOf,
  storeRoot,
  toolPath,
  UNKNOWN_SEMANTICS,
} from "@plainport/core";
import {
  PINNED_RESTIC,
  resticEngine,
  resticTarget,
  type StoreLocation,
  s3Environment,
  sshCommand,
} from "@plainport/engine-restic";
import { secretProviders } from "@plainport/secrets";

/**
 * What restic's child process is given of the environment: enough to find its home, temp folder and locale, and for
 * an SFTP store the system's ssh on PATH and its agent.
 */
const resticEnv = (env: Env): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SSH_AUTH_SOCK"]) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
};

type RemoteStore = Extract<Store, { kind: "sftp" | "s3" }>;

/** The facts a measurement of the store holds for (Q4): where it is, how it is reached, the restic and rclone used. */
export const storeFactsOf = (store: Store, home: string): StoreFacts => ({
  endpoint: storeLocationOf(store, home),
  access: store.kind,
  restic: PINNED_RESTIC,
  ...(store.kind === "sftp" || store.kind === "s3" ? { rclone: PINNED_RCLONE } : {}),
});

/** The profile `measured` (or unknown) with each property the owner asserts in config over it, as `asserted`. */
export const withAssertions = (
  measured: StoreSemantics,
  asserted: AssertedSemantics = {},
): StoreSemantics => {
  const out: Record<string, unknown> = { ...measured };
  for (const [property, value] of Object.entries(asserted))
    if (value !== undefined) out[property] = { value, evidence: "asserted" };
  return out as StoreSemantics;
};

/** The remote store's profile: this device's measurement of it while its facts hold, under config's assertions. */
const profileOf = async (
  host: HostPorts,
  paths: PlainportPaths,
  name: string,
  store: RemoteStore,
): Promise<Result<StoreSemantics>> => {
  const registry = await readRegistry(host, paths);
  if (!registry.ok) return registry;
  const id = registry.value.stores?.[name];
  let measured = UNKNOWN_SEMANTICS;
  if (id !== undefined) {
    const state = await readStoreState(host, paths, id, storeFactsOf(store, paths.home));
    if (!state.ok) return state;
    measured = state.value.measured?.semantics ?? UNKNOWN_SEMANTICS;
  }
  return ok(withAssertions(measured, store.semantics));
};

/** The store's place, as engine-restic builds restic's location from it. */
const locationOf = (store: Exclude<Store, { kind: "peer" }>, home: string): StoreLocation =>
  store.kind === "local"
    ? { kind: "local", root: storeRoot(store, home) }
    : store.kind === "sftp"
      ? { kind: "sftp", host: store.host, path: store.path }
      : {
          kind: "s3",
          endpoint: store.endpoint,
          bucket: store.bucket,
          ...(store.path === undefined ? {} : { path: store.path }),
          ...(store.region === undefined ? {} : { region: store.region }),
        };

/** The same root for rclone: the folder on the ssh host, or <bucket>/<prefix>. */
const rcloneRemoteOf = (store: RemoteStore, credentials: StoreCredentials | undefined): RcloneRemote =>
  store.kind === "sftp"
    ? {
        type: "sftp",
        root: store.path,
        options: {
          ssh: sshCommand(store.host),
          // No remote shell commands (hashes, disk usage): every run is the SFTP subsystem alone.
          shell_type: "none",
          disable_hashcheck: "true",
        },
      }
    : {
        type: "s3",
        root: `${store.bucket}${store.path === undefined ? "" : `/${store.path}`}`,
        options: {
          provider: "Other",
          endpoint: store.endpoint,
          ...(store.region === undefined ? {} : { region: store.region }),
          // The bucket is the owner's to make: rclone never creates one.
          no_check_bucket: "true",
        },
        ...(credentials === undefined
          ? {}
          : {
              secrets: {
                access_key_id: credentials.accessKeyId,
                secret_access_key: credentials.secretAccessKey,
              },
            }),
      };

export const storeOpener = (host: HostPorts, env: Env): StoreOpener => ({
  // keychain: and op: references, read through the one runner (Task 15); env: and file: are core's own.
  secrets: secretProviders({ run: (spec) => host.run(spec), env }),
  open: async (name, store, password, credentials) => {
    if (store.kind === "peer") {
      return fail(
        finding("store.unsupported", {
          message: `store ${name} is a peer store; this build uses local, sftp and s3 stores (peer stores arrive with M3)`,
          fix: "point the root at a local, sftp or s3 store",
        }),
      );
    }
    if (store.kind === "s3" && credentials === undefined) {
      return fail(
        finding("store.secret-missing", {
          message: `store ${name} is an S3 store, and its key pair (stores.${name}.accessKeyId and secretAccessKey) was not read`,
          fix: `set stores.${name}.accessKeyId and stores.${name}.secretAccessKey to references to the bucket's key pair, then re-run`,
        }),
      );
    }
    const paths = resolvePaths(env);
    if (!paths.ok) return paths;
    const restic = await toolPath(host, "restic", { env });
    if (!restic.ok) return restic;
    const location = locationOf(store, paths.value.home);
    const remote = store.kind !== "local";
    const engineAt = (repo: string) => {
      const target = resticTarget(location, repo);
      return resticEngine({
        host,
        restic: restic.value.path,
        repository: target.repository,
        extended: target.extended,
        password,
        ...(store.kind === "s3" && credentials !== undefined
          ? { secretEnv: s3Environment(credentials) }
          : {}),
        remote,
        env: resticEnv(env),
        cacheDir: join(paths.value.cacheDir, "restic"),
      });
    };
    let blob: ReturnType<typeof fsBlobStore> | ReturnType<typeof rcloneBlobStore>;
    if (store.kind === "local") blob = fsBlobStore(host, storeRoot(store, paths.value.home));
    else {
      const rclone = await toolPath(host, "rclone", { env });
      if (!rclone.ok) return rclone;
      const semantics = await profileOf(host, paths.value, name, store);
      if (!semantics.ok) return semantics;
      blob = rcloneBlobStore({
        host,
        rclone: rclone.value.path,
        remote: rcloneRemoteOf(store, credentials),
        paths: paths.value,
        env,
        semantics: semantics.value,
      });
    }
    return ok({
      blob,
      engine: publishedEngine(name, store, blob, engineAt),
      engineAt,
      location: storeLocationOf(store, paths.value.home),
    });
  },
});

/** The opener's name before M2 Task 18, when it opened local stores only. */
export const localStores = storeOpener;
