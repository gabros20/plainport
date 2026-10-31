// Devices in one process on one fake store (M2 Task 21): for the schedules a binary on a local store cannot stage, such
// as S6's delayed visibility, which needs a store whose listings lag (the semantic fake, listOmitsRecent). Each device
// is its own sandboxed home, device id, config, registry and event mirror; all share the fake store and one fake
// restic repository (each device's engine has its own hooks, so a test can act while one device uploads).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../../packages/contract/src/index.ts";
import { STORE_EVENTS_PREFIX } from "../../packages/core/src/catalog/codec.ts";
import type { CatalogEvent } from "../../packages/core/src/catalog/events.ts";
import { encodeStoreIdentityV2, STORE_IDENTITY_KEY } from "../../packages/core/src/catalog/identity.ts";
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
import {
  type OffloadDeps,
  type OffloadRequest,
  previewLease,
  runOffload,
} from "../../packages/core/src/saga/offload.ts";
import { type OnloadDeps, runOnload } from "../../packages/core/src/saga/onload.ts";
import { type ResolveDeps, runResolve } from "../../packages/core/src/saga/resolve.ts";
import { runRestore } from "../../packages/core/src/saga/restore.ts";
import { type ProjectStatus, projectViews } from "../../packages/core/src/status/projects.ts";
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
  /** Every finding its offloads and onloads streamed, oldest first. */
  findings: Finding[];
  /** The events its last release's catalog read saw (the offload.release.reread seam, live or in recover). */
  seenAtReread?: Set<string>;
  /** Invariant 1's `unseen`, derived (Q16's residual): the store's events its last release read did not see. */
  unseen(): Promise<string[]>;
  /** The project folder at `path` in this device's root. */
  dir(path?: string): string;
  offload(
    path?: string,
    faults?: RunFaults,
    req?: Omit<OffloadRequest, "project">,
  ): ReturnType<typeof runOffload>;
  /** The lease.held its offload's dry run would stream (D114), or nothing. */
  previewLease(path?: string): ReturnType<typeof previewLease>;
  onload(path?: string): ReturnType<typeof runOnload>;
  /** recover, on the host's clock or `now` (a stepped clock: deadlines are compared with it). */
  recover(faults?: RunFaults, now?: () => Date): ReturnType<typeof recover>;
  /** gc (--now with `early`), with the checked read of a held trash (Q16), on `now`'s clock. */
  gc(options?: { early?: boolean; now?: () => Date; faults?: RunFaults }): ReturnType<typeof collectTrash>;
  /** A write command's housekeeping (deleteDue), or a read command's, with the checked read, on `now`'s clock. */
  housekeeping(options?: { deleteDue?: boolean; now?: () => Date }): ReturnType<typeof housekeeping>;
  /** Appends lines to this device's config.toml. */
  configure(lines: string): void;
  /** `resolve <path> --keep <snapshot>` (Task 25). */
  resolve(keep: string, path?: string, faults?: RunFaults): ReturnType<typeof runResolve>;
  /** `restore <path> --snapshot <snapshot> --to <to>`. */
  restore(snapshot: string, to: string, path?: string): ReturnType<typeof runRestore>;
  /** This device's registry entry for the project at `path`. */
  entry(path?: string): Promise<RegistryEntry | undefined>;
  /** This device's view of the project at `path` (status), read through the store. */
  view(path?: string): Promise<ProjectStatus | undefined>;
}

/**
 * Devices on `store`, each set up with `init`'s steps: its device id, its config, the store recorded by its id.
 * `config` adds TOML to a device's config.toml, by device name (`[onload]\nleases = "strict"`). With `format: 2` the
 * store's identity file is then format 2 (as `store upgrade` leaves it: its repository at `repo`), which `resolve`
 * needs (Q2); otherwise it stays format 1, as M1's setup makes it.
 */
export const fakeDevices = async (
  store: SemanticBlobStore,
  names: readonly string[],
  options: { config?: Readonly<Record<string, string>>; format?: 1 | 2 } = {},
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
        ...(options.config?.[name] === undefined ? [] : [options.config[name]]),
      ].join("\n"),
    );
    box.dir("ssd");
    box.dir("work");
    const made = await ensureDevice(testHost(), box.paths, { role: "owner", name });
    if (!made.ok) throw new Error(made.finding.message);
    const engine = fakeEngine(repository);
    const mirror = memoryBlobStore({ createIfAbsent: true });
    // The event keys the store last listed to this device, so the release's re-read is known by what it saw.
    let listed: string[] = [];
    const blob: SemanticBlobStore = {
      ...store,
      list: async (prefix, opts) => {
        const got = await store.list(prefix, opts);
        if (got.ok && STORE_EVENTS_PREFIX.startsWith(prefix.slice(0, STORE_EVENTS_PREFIX.length)))
          listed = got.value.map((e) => e.key).filter((k) => k.startsWith(STORE_EVENTS_PREFIX));
        return got;
      },
    };
    const opener: StoreOpener = { open: async () => ({ ok: true, value: { blob, engine } }) };
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
    const findings: Finding[] = [];
    const device: Partial<FakeDevice> = { findings };
    // Invariant 1's reference: the folder as it stood when release began (by the live run or by recover).
    const hostFor = (faults: RunFaults = {}): HostPorts =>
      testHost({
        faults: {
          ...(faults.at === undefined ? {} : { at: faults.at }),
          onStep: (step) => {
            const web = join(box.home, "work", "web");
            if (step === "offload.release.trash" && existsSync(web)) device.released = captureTree(web);
            // What the release's catalog read saw: the store's listing and this device's mirror.
            if (step === "offload.release.reread")
              device.seenAtReread = new Set([...listed, ...mirror.data.keys()].flatMap(eventIdOf));
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
      emit: (event: { type: string; finding?: Finding }) => {
        if (event.type === "finding" && event.finding !== undefined) findings.push(event.finding);
      },
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
    const resolveDeps = (faults?: RunFaults): ResolveDeps =>
      faults === undefined ? common : { ...common, host: hostFor(faults) };
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
        offload: async (path = "web", faults?: RunFaults, req: Omit<OffloadRequest, "project"> = {}) =>
          runOffload(faults === undefined ? offloadDeps : { ...offloadDeps, host: hostFor(faults) }, {
            ...req,
            project: await ref(path),
          }),
        previewLease: async (path = "web") => previewLease(offloadDeps, { project: await ref(path) }),
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
        resolve: async (keep: string, path = "web", faults?: RunFaults) =>
          runResolve(resolveDeps(faults), { project: await ref(path), keep }),
        restore: async (snapshot: string, to: string, path = "web") =>
          runRestore(common, { project: await ref(path), snapshot, to }),
        entry: async (path = "web") => {
          const registry = await readRegistry(testHost(), box.paths);
          if (!registry.ok) throw new Error(registry.finding.message);
          return Object.values(registry.value.projects).find((e) => e.path === path);
        },
        unseen: async () => {
          const seen = device.seenAtReread;
          return seen === undefined
            ? []
            : (await allEvents(store)).map((e) => e.id).filter((id) => !seen.has(id));
        },
        view: async (path = "web") => {
          const views = await projectViews({ ...common, io: testHost() });
          if (!views.ok) throw new Error(views.finding.message);
          return views.value.projects.find((p) => p.path === path);
        },
      }) as FakeDevice,
    );
  }
  if (options.format === 2) {
    const m1 = new TextDecoder().decode(store.data.get(STORE_IDENTITY_KEY));
    const { id } = JSON.parse(m1) as { id: string };
    store.data.set(STORE_IDENTITY_KEY, encodeStoreIdentityV2({ id, repo: "repo", seal: "none" }));
  }
  return devices;
};

/** The event id a store or mirror key names, if any. */
const eventIdOf = (key: string): string[] => {
  const id = /([0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(key)?.[1];
  return id === undefined ? [] : [id];
};

/** Every event the store holds, whatever its listings show now. */
export const allEvents = async (store: SemanticBlobStore): Promise<CatalogEvent[]> => {
  const visible = memoryBlobStore();
  for (const [key, bytes] of store.data) visible.data.set(key, bytes);
  const read = await readEvents(storeEventLog(visible));
  if (!read.ok) throw new Error(read.finding.message);
  return read.value.events;
};
