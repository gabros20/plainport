// Reaching a configured store for `store list --probe`, `store test` and `store add`: its password read from its
// reference (through the opener's providers, within Q14's deadline), then its two layers opened. Nothing is reached
// until the first call on a layer, and nothing here needs this device to have set the store up.

import { type Finding, fail, finding, type Result } from "@plainport/contract";
import { readStoreDescriptor, type StoreDescriptor } from "../catalog/identity.ts";
import type { Store } from "../config/schema.ts";
import { type ProbeOptions, probeDeadline } from "../deadline.ts";
import type { LocalIo } from "../io.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import type { OpenedStore, StoreOpener } from "../ports/store.ts";
import { resolveSecret, secretProvidersOf, secretRefOf } from "../store.ts";

export interface ReachOptions {
  paths: PlainportPaths;
  env: Env;
  name: string;
  store: Store;
  opener: StoreOpener;
  signal?: AbortSignal;
}

/** The store's two layers, with its password read. */
export const reachStore = async (io: LocalIo, options: ReachOptions): Promise<Result<OpenedStore>> => {
  const password = await resolveSecret(
    io,
    options.env,
    options.paths.home,
    options.name,
    secretRefOf(options.store),
    {
      ...secretProvidersOf(options.opener),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  if (!password.ok) return password;
  return options.opener.open(options.name, options.store, password.value);
};

/** What a probe found: the store answered, with its identity file (or none), or it did not, with why. */
export type Probe =
  | { reachable: true; descriptor: StoreDescriptor | null }
  | { reachable: false; finding: Finding };

/**
 * Reads the store's identity file under the probe deadline (D32), with nothing written: whether the store answers,
 * and what it says it is. A store that does not answer in time is store.unreachable.
 */
export const probeStore = async (
  io: LocalIo,
  options: ReachOptions & { probe?: ProbeOptions },
): Promise<Probe> => {
  const read = async (): Promise<Result<StoreDescriptor | null>> => {
    const reached = await reachStore(io, options);
    if (!reached.ok) return reached;
    return readStoreDescriptor(reached.value.blob);
  };
  const probed = await probeDeadline(read(), options.probe ?? {});
  if (probed.timedOut)
    return {
      reachable: false,
      finding: finding("store.unreachable", {
        message: `store ${options.name} did not answer within ${probed.seconds} seconds`,
        fix: "check the network, the mount or the server, then re-run",
      }),
    };
  const got = probed.value;
  return got.ok ? { reachable: true, descriptor: got.value } : { reachable: false, finding: got.finding };
};

/** store.not-set-up for a name config does not define. */
export const notConfigured = (name: string, configured: readonly string[]): Result<never> =>
  fail(
    finding("store.not-set-up", {
      message: `no store named ${name} is configured${configured.length === 0 ? "" : ` (configured: ${configured.join(", ")})`}`,
      fix: `plainport store add ${name} --kind <local|sftp|s3> … (plainport help store add)`,
    }),
  );
