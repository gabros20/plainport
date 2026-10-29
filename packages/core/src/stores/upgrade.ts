// `plainport store upgrade <name>` (Q2's constrained procedure, R2-1; DESIGN.md "Formats and compatibility"): moves a
// format-1 store to format 2, after which every v0.1.x process that starts refuses it. A v0.1.1 process that started
// before can still append and release, so the upgrade runs only when the store is quiescent, and refuses otherwise with
// store.not-quiescent, naming the first reason:
//
//   1. this device has an open journal (an offload, an onload, a setup attempt) or a live plainport lock;
//   2. the store's catalog shows a lease held by another device (an onload not offloaded again);
//   3. the catalog shows an event from another device within the quiet window (default 15 minutes);
//   4. --others-stopped is missing: what the catalog cannot show (another device's plainport running, a detached delete
//      included) the owner attests. The fix lists the devices the catalog names.
//
// Then it writes meta/v1/upgrade-intent.json (v0.2 refuses bootstrap and offload while it stands), waits out the window,
// reads the catalog again, and only then replaces store.json with format 2 (`repo` stays M1's `repo`, the catalog stays
// plain) and removes the marker. A re-read that finds new activity from another device aborts and removes the marker.
// A crash leaves the marker: `store upgrade` resumes it (this device's own marker), and `recover` clears it
// (recoverUpgrades). The store must hold the id this device pinned for the name (D85).
//
// What remains is Q2's accepted residual: a lease-less first offload on another device that outlasts the window
// releases as M1 did, with an M1-shaped event v0.2 still reads.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { type Failure, fail, finding, ok, type Result } from "@plainport/contract";
import { z } from "zod";
import type { CatalogEvent } from "../catalog/events.ts";
import { foldCatalog } from "../catalog/fold.ts";
import {
  encodeStoreIdentityV2,
  identityChanged,
  readStoreDescriptor,
  STORE_IDENTITY_KEY,
  type StoreDescriptor,
} from "../catalog/identity.ts";
import { readEvents, storeEventLog } from "../catalog/log.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { LocalIo } from "../io.ts";
import { readBootstrapJournals, readJournals } from "../journal/index.ts";
import { acquireLock, liveHolder } from "../lock.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { StoreOpener } from "../ports/store.ts";
import { readRegistry } from "../registry.ts";
import { withFix, writeFailed } from "../saga/journaled.ts";
import { UlidSchema } from "../ulid.ts";
import { notConfigured, reachStore } from "./reach.ts";

/** The marker an upgrade under way leaves on the store (Q2); v0.2 refuses bootstrap and offload while it stands. */
export const UPGRADE_INTENT_KEY = "meta/v1/upgrade-intent.json";
/** How long the catalog must show no other device's event before and during an upgrade (Q2). */
export const QUIET_WINDOW_MS = 15 * 60_000;

export const UpgradeIntentSchema = z
  .strictObject({
    v: z.literal(1),
    /** The upgrade's id. */
    op: UlidSchema,
    /** The store being upgraded. */
    store: UlidSchema,
    /** The device running it. */
    device: UlidSchema,
    at: z.iso.datetime(),
  })
  .meta({
    title: "UpgradeIntent",
    description: "meta/v1/upgrade-intent.json: a store upgrade to format 2 under way (Q2)",
  });
export type UpgradeIntent = z.infer<typeof UpgradeIntentSchema>;

/** The crash seams of an upgrade, in order, after each write. */
export const UPGRADE_SEAMS = [
  "upgrade.intent.written",
  "upgrade.replaced",
  "upgrade.intent.removed",
] as const;

export interface UpgradePorts {
  io: LocalIo;
  paths: PlainportPaths;
  env: Env;
  clock(): Date;
  /** Waits out the quiet window: a timer in the CLI, a fake in tests. */
  wait(ms: number): Promise<void>;
  /** The host's crash seam, reached after each write (UPGRADE_SEAMS). */
  faultAt(point: string): void;
}

export interface UpgradeOptions {
  name: string;
  config: ResolvedConfig;
  opener: StoreOpener;
  /** This device's id. */
  device: string;
  othersStopped: boolean;
  windowMs?: number;
  /** A fresh ULID, the upgrade's id. */
  mint: () => string;
}

export interface UpgradeDone {
  name: string;
  id: string;
  /** The format found; 2 when there was nothing to upgrade. */
  from: 1 | 2;
  format: 2;
  /** This run replaced store.json. */
  upgraded: boolean;
  /** This run found this device's own marker from an earlier run and finished or cleared it. */
  resumed: boolean;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The marker on the store: undefined when there is none, null when it is there but not one this version reads. */
export const readUpgradeIntent = async (
  blob: BlobStore,
): Promise<Result<UpgradeIntent | null | undefined>> => {
  const got = await blob.get(UPGRADE_INTENT_KEY);
  if (!got.ok) return got;
  if (got.value === null) return ok(undefined);
  try {
    const checked = UpgradeIntentSchema.safeParse(JSON.parse(decoder.decode(got.value)));
    return ok(checked.success ? checked.data : null);
  } catch {
    return ok(null);
  }
};

/** store.not-quiescent for an operation that may not run while an upgrade's marker stands. */
export const upgradeUnderWay = (store: string, doing: string, intent: UpgradeIntent | null): Failure =>
  fail(
    finding("store.not-quiescent", {
      message: `store ${store} is being upgraded to format 2${intent === null ? "" : ` (upgrade ${intent.op} by device ${intent.device}, since ${intent.at})`}: its ${UPGRADE_INTENT_KEY} marker stands, so ${doing} refuses; nothing was written`,
      fix: `wait for the upgrade to finish and re-run; if it stopped, run plainport store upgrade ${store} --others-stopped --yes on the device that started it (it resumes), or plainport recover there (it clears the marker)`,
      paths: [UPGRADE_INTENT_KEY],
    }),
  );

/** Refuses `doing` while the store's upgrade marker stands (Q2: v0.2 refuses bootstrap and offload then). */
export const refuseWhileUpgrading = async (
  blob: BlobStore,
  store: string,
  doing: string,
): Promise<Result<void>> => {
  const intent = await readUpgradeIntent(blob);
  if (!intent.ok) return intent;
  return intent.value === undefined ? ok(undefined) : upgradeUnderWay(store, doing, intent.value);
};

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** The milliseconds a ULID's first ten characters hold. */
const ulidTime = (id: string): number => {
  let time = 0;
  for (const char of id.slice(0, 10)) time = time * 32 + ALPHABET.indexOf(char);
  return time;
};

/** When an event was written, by the later of its writer's two clocks (its `at` and its id). */
const writtenAt = (event: CatalogEvent): number => Math.max(Date.parse(event.at), ulidTime(event.id));

const notQuiescent = (name: string, reason: string, fix: string, paths?: string[]): Failure =>
  fail(
    finding("store.not-quiescent", {
      message: `store ${name} is not quiescent, so it was not upgraded: ${reason}; nothing was changed`,
      fix,
      ...(paths !== undefined && { paths }),
    }),
  );

/** `locks/upgrade-<the first 32 hex digits of the name's SHA-256>.lock`: one upgrade of a store at a time here. */
const lockFile = (paths: PlainportPaths, name: string): string =>
  join(
    paths.locksDir,
    `upgrade-${createHash("sha256").update(name, "utf8").digest("hex").slice(0, 32)}.lock`,
  );

/** Check 1: this device's open journals and live plainport locks (all but `own`). */
const localActivity = async (ports: UpgradePorts, own: string): Promise<Result<string | undefined>> => {
  const { io, paths } = ports;
  try {
    const journals = await readJournals(io, paths);
    const open = journals.journals[0];
    if (open !== undefined)
      return ok(`this device has an open ${open.kind} journal (${open.op}, ${open.project.address})`);
    if (journals.unreadable[0] !== undefined)
      return ok(`this device has a journal this version cannot read (${journals.unreadable[0]})`);
    const attempts = await readBootstrapJournals(io, paths);
    const attempt = attempts.journals[0];
    if (attempt !== undefined)
      return ok(`this device has an open setup attempt (${attempt.op}) for store ${attempt.store.name}`);
    let names: string[] = [];
    try {
      names = await io.fs.readdir(paths.locksDir);
    } catch {
      names = [];
    }
    for (const name of names.sort()) {
      const path = join(paths.locksDir, name);
      if (!name.endsWith(".lock") || path === own) continue;
      const holder = await liveHolder(io, path);
      if (holder !== undefined)
        return ok(
          `plainport process ${holder.pid} on ${holder.host} holds ${path} (since ${holder.startedAt})`,
        );
    }
    return ok(undefined);
  } catch (error) {
    return writeFailed(error, "reading this device's journals and locks", false, paths.journalDir);
  }
};

/** Checks 2 and 3 on one read of the catalog: another device's lease, or its event inside the window. */
const catalogActivity = (
  events: readonly CatalogEvent[],
  device: string,
  since: number,
): string | undefined => {
  const state = foldCatalog(events);
  for (const [project, view] of Object.entries(state.projects)) {
    if (view.lease !== null && view.lease.device !== device)
      return `device ${view.lease.device} holds a lease on project ${project} (its onload ${view.lease.event} has no offload after it)`;
  }
  const recent = events.filter((e) => e.device !== device && writtenAt(e) >= since);
  const last = recent.at(-1);
  if (last !== undefined)
    return `device ${last.device} wrote event ${last.id} at ${last.at}, inside the quiet window`;
  return undefined;
};

const otherDevices = (events: readonly CatalogEvent[], device: string): string[] =>
  [...new Set(events.map((e) => e.device).filter((d) => d !== device))].sort();

const stopFix = (name: string, devices: readonly string[]): string =>
  `stop plainport on every other device that uses store ${name}, detached deletes included${devices.length === 0 ? " (its catalog names no other device)" : ` (its catalog names ${devices.join(", ")})`}, let this device's own operations finish (plainport recover), wait out the quiet window, then re-run plainport store upgrade ${name} --others-stopped --yes`;

export const upgradeStore = async (
  ports: UpgradePorts,
  options: UpgradeOptions,
): Promise<Result<UpgradeDone>> => {
  const { io, paths } = ports;
  const { name, config } = options;
  const store = config.stores[name];
  if (store === undefined) return notConfigured(name, Object.keys(config.stores));
  const registry = await readRegistry(io, paths);
  if (!registry.ok) return registry;
  const pinned = registry.value.stores?.[name];
  if (pinned === undefined)
    return fail(
      finding("store.not-set-up", {
        message: `this device has not set store ${name} up (no id recorded in ${paths.registryFile}), so it cannot upgrade it`,
        fix: `plainport store add ${name}, then re-run`,
      }),
    );

  const own = lockFile(paths, name);
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    await io.fs.mkdirp(paths.locksDir);
    lock = await acquireLock(io, own, {
      timeoutMs: 0,
      now: ports.clock,
      held: (holder, path, ours) =>
        finding("store.locked", {
          message: ours
            ? `this process is already upgrading store ${name}`
            : `store ${name} is being upgraded by ${holder === undefined ? "a process whose lock file cannot be read" : `plainport process ${holder.pid} on ${holder.host}`}`,
          fix:
            ours || holder !== undefined
              ? "wait for the other upgrade to finish, then re-run"
              : `delete ${path} if no plainport is running, then re-run`,
          paths: [path],
        }),
    });
  } catch (error) {
    return writeFailed(error, `taking the lock ${own}`, false, own);
  }
  if (!lock.ok) return lock;
  try {
    return await upgradeLocked(ports, options, pinned, own);
  } finally {
    await lock.value.release();
  }
};

const upgradeLocked = async (
  ports: UpgradePorts,
  options: UpgradeOptions,
  pinned: string,
  own: string,
): Promise<Result<UpgradeDone>> => {
  const { io, paths } = ports;
  const { name, config, device } = options;
  const store = config.stores[name];
  if (store === undefined) return notConfigured(name, Object.keys(config.stores));
  const reached = await reachStore(io, { paths, env: ports.env, name, store, opener: options.opener });
  if (!reached.ok) return reached;
  const { blob } = reached.value;
  const found = await readStoreDescriptor(blob);
  if (!found.ok) return found;
  if (found.value?.id !== pinned)
    return withFix(
      identityChanged(pinned, found.value?.id ?? null, `store named ${name}`),
      `point stores.${name} back at the store this device set up as ${name} (${pinned}); nothing was written`,
    );
  const descriptor: StoreDescriptor = found.value;
  const intent = await readUpgradeIntent(blob);
  if (!intent.ok) return intent;
  const marker = intent.value;
  const done = (from: 1 | 2, upgraded: boolean, resumed: boolean): UpgradeDone => ({
    name,
    id: pinned,
    from,
    format: 2,
    upgraded,
    resumed,
  });

  if (marker !== undefined && (marker === null || marker.device !== device || marker.store !== pinned))
    return upgradeUnderWay(name, "this upgrade", marker);
  if (descriptor.format === 2) {
    // Already format 2: a marker left by this device's run that crashed after replacing store.json is cleared.
    if (marker === undefined) return ok(done(2, false, false));
    const removed = await blob.delete(UPGRADE_INTENT_KEY);
    if (!removed.ok) return removed;
    ports.faultAt("upgrade.intent.removed");
    return ok(done(2, false, true));
  }

  const windowMs = options.windowMs ?? QUIET_WINDOW_MS;
  const local = await localActivity(ports, own);
  if (!local.ok) return local;
  if (local.value !== undefined)
    return notQuiescent(
      name,
      local.value,
      `let it finish (plainport recover settles an operation that stopped), then re-run plainport store upgrade ${name} --others-stopped --yes`,
    );
  const log = storeEventLog(blob);
  const first = await readEvents(log);
  if (!first.ok) return first;
  const devices = otherDevices(first.value.events, device);
  const busy = catalogActivity(first.value.events, device, ports.clock().getTime() - windowMs);
  if (busy !== undefined) return notQuiescent(name, busy, stopFix(name, devices));
  if (!options.othersStopped)
    return notQuiescent(
      name,
      "--others-stopped was not given: plainport cannot see whether another device is running it, so the owner says so",
      stopFix(name, devices),
    );

  // The marker, unless this device's earlier run left it; then the window, then the catalog read again.
  const resumed = marker !== undefined;
  if (marker === undefined) {
    const written: UpgradeIntent = {
      v: 1,
      op: options.mint(),
      store: pinned,
      device,
      at: ports.clock().toISOString(),
    };
    const put = await blob.put(UPGRADE_INTENT_KEY, new TextEncoder().encode(`${JSON.stringify(written)}\n`));
    if (!put.ok) return put;
    ports.faultAt("upgrade.intent.written");
  }
  await ports.wait(windowMs);
  const again = await readEvents(log);
  const seen = new Set(first.value.events.map((e) => e.id));
  const fresh = again.ok ? again.value.events.filter((e) => e.device !== device && !seen.has(e.id)) : [];
  const leased = again.ok ? catalogActivity(again.value.events, device, Number.POSITIVE_INFINITY) : undefined;
  if (!again.ok || fresh.length > 0 || leased !== undefined) {
    const removed = await blob.delete(UPGRADE_INTENT_KEY);
    const reason = !again.ok
      ? `the catalog could not be read again after the window (${again.finding.message})`
      : fresh.length > 0
        ? `device ${fresh[0]?.device} wrote event ${fresh[0]?.id} during the quiet window`
        : (leased as string);
    return notQuiescent(
      name,
      `${reason}; the upgrade was abandoned${removed.ok ? " and its marker removed" : `, and its marker could not be removed (${removed.finding.message}): plainport recover removes it`}`,
      stopFix(name, otherDevices(again.ok ? again.value.events : first.value.events, device)),
      [UPGRADE_INTENT_KEY],
    );
  }

  const put = await blob.put(
    STORE_IDENTITY_KEY,
    encodeStoreIdentityV2({ id: pinned, repo: descriptor.repo, seal: descriptor.seal }),
  );
  if (!put.ok) return put;
  ports.faultAt("upgrade.replaced");
  const back = await readStoreDescriptor(blob);
  if (!back.ok) return back;
  if (back.value?.id !== pinned || back.value.format !== 2)
    return fail(
      finding("store.failed", {
        message: `store ${name}'s ${STORE_IDENTITY_KEY} did not read back as format 2 of ${pinned} after the upgrade wrote it; its marker was left`,
        fix: `stop plainport on every device that uses store ${name}, check ${STORE_IDENTITY_KEY}, then re-run plainport store upgrade ${name} --others-stopped --yes`,
        paths: [STORE_IDENTITY_KEY, UPGRADE_INTENT_KEY],
      }),
    );
  const removed = await blob.delete(UPGRADE_INTENT_KEY);
  if (!removed.ok) return removed;
  ports.faultAt("upgrade.intent.removed");
  return ok(done(1, true, resumed));
};

export interface RecoveredUpgrade {
  store: string;
  /** cleared: this device's marker was removed (store.json was format 1 or 2); kept: not this device's, or unreadable. */
  outcome: "cleared" | "kept";
  format?: 1 | 2;
}

/**
 * `recover`'s part (Q2): clears this device's upgrade marker on a store when no upgrade of it runs here. Whatever
 * store.json says then stands: format 2 when the replace landed, format 1 when it did not (re-run store upgrade).
 * Another device's marker, or one this version cannot read, is left as it is.
 */
export const recoverUpgrade = async (
  ports: Pick<UpgradePorts, "io" | "paths">,
  blob: BlobStore,
  name: string,
  device: string,
): Promise<Result<RecoveredUpgrade | undefined>> => {
  const intent = await readUpgradeIntent(blob);
  if (!intent.ok) return intent;
  if (intent.value === undefined) return ok(undefined);
  if (intent.value === null || intent.value.device !== device) return ok({ store: name, outcome: "kept" });
  const running = await liveHolder(ports.io, lockFile(ports.paths, name));
  if (running !== undefined) return ok({ store: name, outcome: "kept" });
  const found = await readStoreDescriptor(blob);
  const removed = await blob.delete(UPGRADE_INTENT_KEY);
  if (!removed.ok) return removed;
  return ok({
    store: name,
    outcome: "cleared",
    ...(found.ok && found.value !== null && { format: found.value.format }),
  });
};
