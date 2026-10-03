// The store opener the binary uses (M1): a local store is a folder, on an external disk or this one, holding the
// restic repository in repo/ and the catalog in meta/ (DESIGN.md "Storage → Layout on every store"). Its events go
// through blob-fs; its snapshots through the pinned restic, found by toolPath. Other kinds arrive with M2 and M3.

import { join } from "node:path";
import { fsBlobStore } from "@plainport/blob-fs";
import { fail, finding, ok } from "@plainport/contract";
import {
  type Env,
  type HostPorts,
  resolvePaths,
  type StoreOpener,
  storeRoot,
  toolPath,
} from "@plainport/core";
import { resticEngine } from "@plainport/engine-restic";

/** What restic's child process is given of the environment: enough to find its home, temp folder and locale. */
const resticEnv = (env: Env): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"]) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
};

export const localStores = (host: HostPorts, env: Env): StoreOpener => ({
  open: async (name, store, password) => {
    if (store.kind !== "local") {
      return fail(
        finding("store.unsupported", {
          message: `store ${name} is a ${store.kind} store; this build uses local stores only (M1)`,
        }),
      );
    }
    const paths = resolvePaths(env);
    if (!paths.ok) return paths;
    const restic = await toolPath(host, "restic", { env });
    if (!restic.ok) return restic;
    const root = storeRoot(store, paths.value.home);
    return ok({
      blob: fsBlobStore(host, root),
      engine: resticEngine({
        host,
        restic: restic.value.path,
        repository: join(root, "repo"),
        password,
        env: resticEnv(env),
        cacheDir: join(paths.value.cacheDir, "restic"),
      }),
    });
  },
});
