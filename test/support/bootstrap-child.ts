// Test-only child process: one device setting a T2 store up through bootstrap (saga/bootstrap.ts), as the binary does
// it: the device's config, its secrets as env: references, the binary's store opener (restic and rclone, the ssh
// shim), and its host's crash seam. `bun bootstrap-child.ts <config.json>`; it prints one JSON line,
// { outcome, code?, id?, repos } (repos: every restic --repo this process ran), and nothing else on stdout. With
// `faultAt`, the process kills itself (SIGKILL) at that step or seam, as the crash matrix's hooked binary does; with
// `barrier`, it waits at a start barrier first, so two devices really race.

import { readFileSync } from "node:fs";
import { storeOpener } from "../../packages/cli/src/stores.ts";
import { ConfigLoader } from "../../packages/core/src/config/load.ts";
import { resolvePaths } from "../../packages/core/src/paths.ts";
import type { HostPorts } from "../../packages/core/src/ports/host.ts";
import { type BootstrapPorts, runBootstrap } from "../../packages/core/src/saga/bootstrap.ts";
import { openBootstrapStore } from "../../packages/core/src/store.ts";
import { awaitGo } from "../../packages/core/src/testing/barrier.ts";
import { testHost } from "../../packages/core/src/testing/host.ts";

export interface BootstrapChildConfig {
  /** The device's whole environment: HOME (its sandbox), PATH (the ssh shim first), the secrets' variables. */
  env: Record<string, string>;
  store: string;
  faultAt?: string;
  barrier?: { dir: string; name: string };
}

export interface BootstrapChildResult {
  outcome: "published" | "adopted" | "failed";
  code?: string;
  id?: string;
  /** The restic repositories this process ran a command on, in order. */
  repos: string[];
}

const config = JSON.parse(readFileSync(process.argv[2] as string, "utf8")) as BootstrapChildConfig;
const base = testHost(config.faultAt === undefined ? {} : { faults: { at: config.faultAt, action: "kill" } });
const repos: string[] = [];
const host: HostPorts = {
  ...base,
  run: (spec) => {
    const at = spec.args?.indexOf("--repo") ?? -1;
    if (spec.command.endsWith("/restic") && at >= 0) repos.push(spec.args?.[at + 1] as string);
    return base.run(spec);
  },
};
const paths = resolvePaths(config.env);
if (!paths.ok) throw new Error(paths.finding.message);
const loaded = await new ConfigLoader(host, paths.value).load({ env: config.env });
if (!loaded.ok) throw new Error(loaded.finding.message);
const store = await openBootstrapStore(host, {
  paths: paths.value,
  env: config.env,
  name: config.store,
  config: loaded.value.config,
  opener: storeOpener(host, config.env),
});
if (!store.ok) throw new Error(`${store.finding.code}: ${store.finding.message}`);
const ports: BootstrapPorts = {
  io: host,
  paths: paths.value,
  faultAt: (point) => host.faultAt(point),
  clock: () => new Date(),
  log: () => {},
  wait: (ms) => Bun.sleep(ms),
};
if (config.barrier !== undefined) await awaitGo(config.barrier.dir, config.barrier.name);
const done = await runBootstrap(ports, store.value, { name: config.store, seal: "none" });
const result: BootstrapChildResult = done.ok
  ? { outcome: done.value.outcome, id: done.value.id, repos }
  : { outcome: "failed", code: done.finding.code, repos };
process.stdout.write(`${JSON.stringify(result)}\n`);
