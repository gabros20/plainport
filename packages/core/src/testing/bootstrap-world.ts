// A world for bootstrap tests (DESIGN.md "Bootstrap"): one store shared by several devices, each a sandboxed home with
// its own password, journal folder and registry, and a fake restic repository per location under the store (repo/ for
// an M1 store, repos/<attempt>/ for each bootstrap attempt). Every repository logs which password reached it, so a test
// can show a losing device never touched the winner's. Used only by *.test.ts files and their helpers.

import type { Result } from "@plainport/contract";
import { readBootstrapJournals } from "../journal/index.ts";
import type { FaultPlan } from "../ports/host.ts";
import { readRegistry } from "../registry.ts";
import {
  type BootstrapDone,
  type BootstrapPorts,
  type BootstrapRecoveryReport,
  type BootstrapStore,
  type BootstrapTarget,
  recoverBootstraps,
  runBootstrap,
} from "../saga/bootstrap.ts";
import { type FakeEngineHooks, type FakeRepository, fakeEngine, fakeRepository } from "./fake-engine.ts";
import { testHost } from "./host.ts";
import { makeSandbox, type Sandbox } from "./sandbox.ts";
import {
  type SemanticBlobStore,
  type SemanticFakeOptions,
  semanticBlobStore,
} from "./semantic-blob-store.ts";

export const STORE_NAME = "archive";

export interface BootstrapDevice {
  box: Sandbox;
  password: string;
  ports: BootstrapPorts;
  /** The store as this device reaches it: the shared blob store, and engines bound to this device's password. */
  target: BootstrapStore;
  run(input?: Partial<BootstrapTarget>): Promise<Result<BootstrapDone>>;
  recover(): Promise<Result<BootstrapRecoveryReport>>;
  /** The id this device recorded for the store, if any. */
  recorded(): Promise<string | undefined>;
  /** The attempts with an open bootstrap journal on this device. */
  journals(): Promise<string[]>;
}

export interface BootstrapWorld {
  store: SemanticBlobStore;
  /** The fake repositories by location relative to the store's root. */
  repos: Map<string, FakeRepository>;
  /** Hooks every engine of every device shares (a paused or delayed init). */
  hooks: FakeEngineHooks;
  device(
    password: string,
    options?: { faults?: FaultPlan; wait?: (ms: number) => Promise<void> },
  ): BootstrapDevice;
  cleanup(): void;
}

export const bootstrapWorld = (options: SemanticFakeOptions = {}): BootstrapWorld => {
  const store = semanticBlobStore(options);
  const repos = new Map<string, FakeRepository>();
  const hooks: FakeEngineHooks = {};
  const boxes: Sandbox[] = [];
  const repoAt = (location: string): FakeRepository => {
    let repo = repos.get(location);
    if (repo === undefined) {
      repo = fakeRepository();
      repos.set(location, repo);
    }
    return repo;
  };
  return {
    store,
    repos,
    hooks,
    device: (password, deviceOptions = {}) => {
      const box = makeSandbox("plainport-bootstrap-");
      boxes.push(box);
      const host = testHost(deviceOptions.faults === undefined ? {} : { faults: deviceOptions.faults });
      const ports: BootstrapPorts = {
        io: host,
        paths: box.paths,
        faultAt: (point) => host.faultAt(point),
        clock: () => new Date(),
        log: () => {},
        wait: deviceOptions.wait ?? (() => new Promise((done) => setTimeout(done, 0))),
      };
      const target: BootstrapStore = {
        blob: store,
        engineAt: (location) => fakeEngine(repoAt(location), hooks, { password }),
      };
      return {
        box,
        password,
        ports,
        target,
        run: (input = {}) => runBootstrap(ports, target, { name: STORE_NAME, seal: "none", ...input }),
        recover: () => recoverBootstraps(ports, async () => ({ ok: true, value: target })),
        recorded: async () => {
          const registry = await readRegistry(host, box.paths);
          if (!registry.ok) throw new Error(registry.finding.message);
          return registry.value.stores?.[STORE_NAME];
        },
        journals: async () => {
          const read = await readBootstrapJournals(host, box.paths);
          return read.journals.map((j) => j.op);
        },
      };
    },
    cleanup: () => {
      for (const box of boxes) box.cleanup();
    },
  };
};

/** The keys under `prefix` in the store, sorted. */
export const keysUnder = (store: { data: Map<string, Uint8Array> }, prefix: string): string[] =>
  [...store.data.keys()].filter((k) => k.startsWith(prefix)).sort();

/** The store's published store.json, parsed; undefined when there is none. */
export const publishedStore = (store: {
  data: Map<string, Uint8Array>;
}): Record<string, unknown> | undefined => {
  const bytes = store.data.get("meta/v1/store.json");
  return bytes === undefined
    ? undefined
    : (JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>);
};
