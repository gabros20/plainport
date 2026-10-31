// Devices in one process on one fake store (M2 Task 21): for the schedules a binary on a local store cannot stage, such
// as S6's delayed visibility, which needs a store whose listings lag (the semantic fake, listOmitsRecent). Each device
// is its own sandboxed home, device id, config, registry and event mirror; all share the fake store and one fake
// restic repository (each device's engine has its own hooks, so a test can act while one device uploads).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogEvent } from "../../packages/core/src/catalog/events.ts";
import { readEvents, storeEventLog } from "../../packages/core/src/catalog/log.ts";
import { ConfigLoader } from "../../packages/core/src/config/load.ts";
import { type Device, ensureDevice } from "../../packages/core/src/device.ts";
import type { HostPorts } from "../../packages/core/src/ports/host.ts";
import type { StoreOpener } from "../../packages/core/src/ports/store.ts";
import { heldStoreOpener } from "../../packages/core/src/recover/held.ts";
import { type RecoverDeps, recover } from "../../packages/core/src/recover/recover.ts";
import { collectTrash, housekeeping, type TrashDeps } from "../../packages/core/src/recover/trash.ts";
import { type RegistryEntry, readRegistry } from "../../packages/core/src/registry.ts";
import { resolveProject } from "../../packages/core/src/roots/address.ts";
import { type OffloadDeps, runOffload } from "../../packages/core/src/saga/offload.ts";
import { type OnloadDeps, runOnload } from "../../packages/core/src/saga/onload.ts";
import { setUpStore } from "../../packages/core/src/store.ts";
import { quietChecks } from "../../packages/core/src/testing/checks.ts";
import { type FakeEngine, fakeEngine, fakeRepository } from "../../packages/core/src/testing/fake-engine.ts";
import { testHost } from "../../packages/core/src/testing/host.ts";
import { captureTree, type TreeCapture } from "../../packages/core/src/testing/invariants.ts";
import { type MemoryBlobStore, memoryBlobStore } from "../../packages/core/src/testing/memory-blob-store.ts";
import { makeSandbox, type Sandbox } from "../../packages/core/src/testing/sandbox.ts";
import type { SemanticBlobStore } from "../../packages/core/src/testing/semantic-blob-store.ts";
import { ulid } from "../../packages/core/src/ulid.ts";
import { nodePlugin } from "../../packages/eco-node/src/index.ts";

const PATH = process.env.PATH ?? "/usr/bin:/bin";

/**
 * One run's crash seams: `at` throws an InjectedFault there (a crash), `onStep` sees every step and seam as it is
 * reached (synchronously, so a test can change the store's bytes between two steps).
 */
export interface RunFaults {
  at?: string;
  onStep?: (step: string) => void;
}

export interface FakeDevice {
  name: string;
  box: Sandbox;
  device: Device;
  engine: FakeEngine;
  mirror: MemoryBlobStore;
  /** The web folder as it stood when this device's last release began: invariant 1's reference. */
  released?: TreeCapture;
  /** The project folder at `path` in this device's root. */
  dir(path?: string): string;
  offload(path?: string, faults?: RunFaults): ReturnType<typeof runOffload>;
  onload(path?: string): ReturnType<typeof runOnload>;
  /** recover, on the host's clock or `now` (a stepped clock: deadlines are compared with it). */
  recover(faults?: RunFaults, now?: () => Date): ReturnType<typeof recover>;
  /** gc (--now with `early`), with the checked read of a held trash (Q16), on `now`'s clock. */
  gc(options?: { early?: boolean; now?: () => Date; faults?: RunFaults }): ReturnType<typeof collectTrash>;
  /** A write command's housekeeping (deleteDue), or a read command's, with the checked read, on `now`'s clock. */
  housekeeping(options?: { deleteDue?: boolean; now?: () => Date }): ReturnType<typeof housekeeping>;
  /** Appends lines to this device's config.toml. */
  configure(lines: string): void;
  /** This device's registry entry for the project at `path`. */
  entry(path?: string): Promise<RegistryEntry | undefined>;
}

/** Devices on `store`, each set up with `init`'s steps: its device id, its config, the store recorded by its id. */
export const fakeDevices = async (
  store: SemanticBlobStore,
  names: readonly string[],
): Promise<FakeDevice[]> => {
  const repository = fakeRepository();
  const devices: FakeDevice[] = [];
  for (const name of names) {
    const box = makeSandbox(`plainport-fake-${name}-`);
    box.file(
      ".config/plainport/config.toml",
      [
        "version = 1",
        'defaultStore = "ssd"',
        "[stores.ssd]",
        'kind = "local"',
        'path = "~/ssd"',
        "[roots.work]",
        'store = "ssd"',
        `on = { ${name} = "~/work" }`,
      ].join("\n"),
    );
    box.dir("ssd");
    box.dir("work");
    const made = await ensureDevice(testHost(), box.paths, { role: "owner", name });
    if (!made.ok) throw new Error(made.finding.message);
    const engine = fakeEngine(repository);
    const mirror = memoryBlobStore({ createIfAbsent: true });
    const opener: StoreOpener = { open: async () => ({ ok: true, value: { blob: store, engine } }) };
    const env = { HOME: box.home, PATH, PLAINPORT_STORE_PASSWORD: "pw" };
    const setUp = await setUpStore(testHost(), {
      paths: box.paths,
      env,
      name: "ssd",
      store: { kind: "local", path: "~/ssd" },
      opener,
      mint: () => ulid(),
    });
    if (!setUp.ok) throw new Error(setUp.finding.message);
    const device: Partial<FakeDevice> = {};
    // Invariant 1's reference: the folder as it stood when release began (by the live run or by recover).
    const hostFor = (faults: RunFaults = {}): HostPorts =>
      testHost({
        faults: {
          ...(faults.at === undefined ? {} : { at: faults.at }),
          onStep: (step) => {
            const web = join(box.home, "work", "web");
            if (step === "offload.release.trash" && existsSync(web)) device.released = captureTree(web);
            faults.onStep?.(step);
          },
        },
      });
    const host = hostFor();
    const common = {
      host,
      paths: box.paths,
      device: made.value.device,
      env,
      loader: new ConfigLoader(testHost(), box.paths),
      opener,
      openMirror: async () => ({ ok: true as const, value: mirror }),
      emit: () => {},
      log: () => {},
    };
    const ref = async (path: string) => {
      const resolved = await resolveProject(testHost(), box.paths, `work:${path}`, {
        cwd: box.home,
        env: { HOME: box.home },
        device: name,
      });
      if (!resolved.ok) throw new Error(resolved.finding.message);
      return resolved.value;
    };
    const offloadDeps: OffloadDeps = { ...common, checks: quietChecks, plugins: [nodePlugin] };
    const onloadDeps: OnloadDeps = { ...common, plugins: [nodePlugin] };
    const recoverDeps = (faults?: RunFaults, now?: () => Date): RecoverDeps => {
      const { emit: _, ...rest } = common;
      return { ...rest, host: hostFor(faults), ...(now === undefined ? {} : { now }) };
    };
    const trashDeps = (now?: () => Date, faults?: RunFaults): TrashDeps => {
      const clock = now ?? (() => new Date());
      const h = hostFor(faults);
      return {
        host: h,
        paths: box.paths,
        env,
        log: () => {},
        now: clock,
        held: heldStoreOpener({
          io: h,
          paths: box.paths,
          env,
          loader: new ConfigLoader(testHost(), box.paths),
          opener,
          clock,
          openMirror: async () => ({ ok: true as const, value: mirror }),
          log: () => {},
        }),
      };
    };
    devices.push(
      Object.assign(device, {
        name,
        box,
        device: made.value.device,
        engine,
        mirror,
        dir: (path = "web") => join(box.home, "work", path),
        offload: async (path = "web", faults?: RunFaults) =>
          runOffload(faults === undefined ? offloadDeps : { ...offloadDeps, host: hostFor(faults) }, {
            project: await ref(path),
          }),
        onload: async (path = "web") => runOnload(onloadDeps, { project: await ref(path), hydrate: false }),
        recover: (faults?: RunFaults, now?: () => Date) => recover(recoverDeps(faults, now)),
        gc: (options: { early?: boolean; now?: () => Date; faults?: RunFaults } = {}) =>
          collectTrash(trashDeps(options.now, options.faults), { early: options.early === true }),
        housekeeping: (options: { deleteDue?: boolean; now?: () => Date } = {}) =>
          housekeeping(trashDeps(options.now), { deleteDue: options.deleteDue !== false }),
        configure: (lines: string) => {
          const file = join(box.home, ".config/plainport/config.toml");
          writeFileSync(file, `${readFileSync(file, "utf8")}\n${lines}\n`);
        },
        entry: async (path = "web") => {
          const registry = await readRegistry(testHost(), box.paths);
          if (!registry.ok) throw new Error(registry.finding.message);
          return Object.values(registry.value.projects).find((e) => e.path === path);
        },
      }) as FakeDevice,
    );
  }
  return devices;
};

/** Every event the store holds, whatever its listings show now. */
export const allEvents = async (store: SemanticBlobStore): Promise<CatalogEvent[]> => {
  const visible = memoryBlobStore();
  for (const [key, bytes] of store.data) visible.data.set(key, bytes);
  const read = await readEvents(storeEventLog(visible));
  if (!read.ok) throw new Error(read.finding.message);
  return read.value.events;
};
