// plainport restore (D58; DESIGN.md "Onload process", last paragraph): a snapshot of a project, side by side, in a
// path where nothing stands: `plainport restore <project> --snapshot <id> --to <path>`. It reuses onload's snapshot
// check and its restore-and-verify (saga/restore-tree.ts) into a staging folder beside the landing path, then renames
// that folder into place. It is not an onload: it takes no lease, appends no catalog event, writes no registry entry,
// installs nothing and leaves the stub and the project's own working copy alone. So it stays allowed while the
// project's head is conflicted or incomplete (D44), when it is the way to read either copy; without --snapshot it
// restores the head, and asks for --snapshot when there is none.
//
// It is not journaled: nothing outside its staging folder changes before the final rename, and any failure removes the
// staging folder. A crash leaves `<parent>/.plainport-staging/<op>/`, which holds only a partial copy of a snapshot the
// store keeps, and is safe to delete.

import { dirname, join } from "node:path";
import {
  type Failure,
  type Finding,
  fail,
  finding,
  ok,
  type Phase,
  type Result,
  type StreamEvent,
  shellWord,
} from "@plainport/contract";
import type { CatalogProject } from "../catalog/fold.ts";
import { catalogReader } from "../catalog/head.ts";
import { resolveRootId } from "../catalog/roots.ts";
import type { ConfigLoader } from "../config/load.ts";
import type { Device } from "../device.ts";
import { removeEmptyHolder, rmdirIfEmpty } from "../holder.ts";
import { assertSystemError, type LocalIo, systemErrorCode } from "../io.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { HostPorts } from "../ports/host.ts";
import type { StoreOpener } from "../ports/store.ts";
import { removeStagingRecord, writeStagingRecord } from "../recover/staging.ts";
import { readRegistry } from "../registry.ts";
import type { ProjectRef } from "../roots/address.ts";
import { type ConfiguredStore, openStore } from "../store.ts";
import { readStub } from "../stub.ts";
import { ulid } from "../ulid.ts";
import { writeFailed } from "./journaled.ts";
import { STAGING_DIR } from "./onload.ts";
import { nestedProjects, registeredFolders, withProjectLock } from "./project-gate.ts";
import { checkSnapshot, kindAt, restoreVerified, unreadable } from "./restore-tree.ts";

export interface RestoreDeps {
  host: HostPorts;
  paths: PlainportPaths;
  device: Device;
  env: Env;
  loader: ConfigLoader;
  opener: StoreOpener;
  /** This device's event mirror for the store with this id (blob-fs's openEventMirror). */
  openMirror(storeId: string): Promise<Result<BlobStore>>;
  emit(event: StreamEvent): void;
  log(level: "debug" | "info" | "warn", message: string): void;
  /** Aborted by Ctrl-C: the restore stops at its next safe point and removes its staging folder. */
  signal?: AbortSignal;
  now?: () => Date;
}

export interface RestoreRequest {
  /** The resolved project: a name, an address or its stub. */
  project: ProjectRef;
  /** The snapshot to restore; the head when absent. */
  snapshot?: string;
  /** An absolute path where nothing stands. */
  to: string;
  /** --store: overrides the stub's, the root's and the default store. */
  store?: string;
}

export type RestoreOutcome = {
  op: string;
  /** root:path. */
  project: string;
  snapshot: string;
  store: string;
  /** Where the copy now is. */
  dir: string;
  /** Files and bytes the snapshot holds. */
  files: number;
  bytes: number;
};

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Runs the restore; see the file comment. A failure leaves nothing behind. */
export const runRestore = async (deps: RestoreDeps, req: RestoreRequest): Promise<Result<RestoreOutcome>> => {
  const { host, paths, signal } = deps;
  const io: LocalIo = host;
  const clock = (): Date => deps.now?.() ?? host.clock.now();
  const ref = req.project;
  const to = req.to;
  const op = ulid(clock().getTime());
  const phase = (name: Phase, status: "start" | "end") =>
    deps.emit({ type: "phase", op, phase: name, status });
  const report = (f: Finding) => deps.emit({ type: "finding", op, finding: f });
  const cancelled = (): Failure =>
    fail(
      finding("operation.cancelled", {
        message: `the restore of ${ref.address} into ${to} was stopped; nothing was left there`,
        fix: "re-run the restore when you are ready",
      }),
    );
  const command = (snapshot: string) =>
    `plainport restore ${shellWord(ref.address)} --snapshot ${snapshot} --to <path>`;

  phase("resolve", "start");
  const loaded = await deps.loader.load({ env: deps.env, root: ref.root });
  if (!loaded.ok) return loaded;
  const config = loaded.value.config;
  const stub = ref.stub === undefined ? undefined : await readStub(io, ref.stub);
  const storeName =
    req.store ??
    (stub?.ok ? stub.value.store : undefined) ??
    config.roots[ref.root]?.store ??
    config.defaultStore;
  if (storeName === undefined) {
    return fail(
      finding("store.not-set-up", {
        message: `root ${ref.root} names no store and no default store is set`,
        fix: "plainport init --store-path <path> --yes sets one up",
      }),
    );
  }
  const opened = await openStore(io, { paths, env: deps.env, name: storeName, config, opener: deps.opener });
  if (!opened.ok) return opened;
  const store: ConfiguredStore = opened.value;
  const mirror = await deps.openMirror(store.id);
  if (!mirror.ok) return mirror;
  const read = await catalogReader({
    store: store.blob,
    mirror: mirror.value,
    storeId: store.id,
    storeName: store.name,
    now: clock,
    report,
  })();
  if (!read.ok) return read;
  const registered = await readRegistry(io, paths);
  if (!registered.ok) return registered;
  const rootId = resolveRootId(registered.value, read.value, ref.root)?.id;
  const id =
    ref.id ??
    Object.entries(registered.value.projects).find(
      ([, e]) => e.root === ref.root && e.path === ref.path,
    )?.[0] ??
    Object.entries(read.value.projects).find(([, p]) => p.root === rootId && p.path === ref.path)?.[0];
  const project = id === undefined ? undefined : read.value.projects[id];
  if (project === undefined) {
    return fail(
      finding("project.not-found", {
        message: `store ${store.name} holds no snapshot of ${ref.address}`,
        fix: "check the address (plainport ls lists the projects), or name the store that holds it with --store",
      }),
    );
  }
  const snapshot = req.snapshot ?? headOf(project);
  if (typeof snapshot !== "string") return snapshot;
  const made = project.snapshots[snapshot];
  const stored = made?.stored[store.name];
  if (made === undefined || stored === undefined) {
    const others = made === undefined ? [] : Object.keys(made.stored);
    return fail(
      finding("snapshot.not-found", {
        message:
          made === undefined
            ? `the catalog holds no snapshot ${snapshot} of ${ref.address}${project.discarded.includes(snapshot) ? " (it was discarded: restic could not read every file)" : ""}`
            : `store ${store.name} holds no copy of snapshot ${snapshot} of ${ref.address}; ${others.join(", ")} ${others.length === 1 ? "does" : "do"}`,
        fix:
          made === undefined
            ? `name one of its snapshots (${Object.keys(project.snapshots).sort().slice(-5).join(", ")}): ${command("<id>")}`
            : `${command(snapshot)} --store ${shellWord(others[0] ?? "<name>")}`,
      }),
    );
  }
  // What is restored, fixed here where it is known to exist.
  const chosen = { snapshot, stored, event: made.event };
  phase("resolve", "end");

  phase("preflight", "start");
  // Never into anything that stands there: a restore never merges.
  let there: string | undefined;
  try {
    there = await kindAt(io, to);
  } catch (error) {
    return unreadable(to, error, "whether the copy can land there is unknown; nothing was restored");
  }
  if (there !== undefined) {
    return fail(
      finding("path.occupied", {
        message: `${to} already exists (a ${there}), so snapshot ${snapshot} of ${ref.address} was not restored there; a restore never merges into an existing folder`,
        fix: `${command(snapshot).replace("<path>", "<another path>")}`,
        paths: [to],
      }),
    );
  }
  // Not inside a registered project's folder, its own included: that project's offload would take the copy along.
  const folders = await registeredFolders(io, paths, deps.env);
  if (!folders.ok) return folders;
  const nested = await nestedProjects(io, paths, folders.value, { folder: to });
  if (!nested.ok) return nested;
  const holding = nested.value.find((n) => !n.inside);
  if (holding !== undefined) {
    return fail(
      finding("project.nested", {
        message: `${to} ${holding.same ? "is" : "lies inside"} ${holding.address}'s folder (${holding.folder}), so ${ref.address} was not restored there: an offload of ${holding.address} would take the copy along`,
        fix: `restore it outside every registered project's folder: ${command(snapshot)}`,
        paths: [to],
      }),
    );
  }
  const projectId = id as string;
  // The project's lock, and those of the projects nested with the landing path (D53); an interrupted operation of the
  // project refuses it (journal.pending), as every write command does (D59).
  const gate = { io, paths, clock, log: deps.log };
  return withProjectLock(gate, { id: projectId, address: ref.address }, () => restoreLocked(), {
    related: nested.value.filter((n) => n.id !== projectId),
  });

  async function restoreLocked(): Promise<Result<RestoreOutcome>> {
    const parent = dirname(to);
    const holder = join(parent, STAGING_DIR);
    const staging = join(holder, op);
    // The record, before the folder: gc removes a crashed restore's staging once nobody holds this lock (D60).
    try {
      await writeStagingRecord(io, paths, {
        v: 1,
        op,
        project: { id: projectId, address: ref.address },
        staging,
      });
      await io.fs.mkdirp(holder);
    } catch (error) {
      return writeFailed(error, `making ${holder}`, false, holder);
    }
    const result = await restoreInto(parent, holder, staging);
    // Only this restore's own folder goes, then the shared holder if, and only if, it is empty (rmdir).
    try {
      await io.fs.removeTree(staging);
      await removeEmptyHolder(io, holder, STAGING_DIR);
      await removeStagingRecord(io, paths, op);
    } catch (error) {
      assertSystemError(error);
      deps.log(
        "warn",
        `${staging} could not be removed; it holds only a partial copy, and plainport gc removes it`,
      );
    }
    return result;
  }

  async function restoreInto(
    parent: string,
    holder: string,
    staging: string,
  ): Promise<Result<RestoreOutcome>> {
    const ctx = {
      op,
      ...(signal === undefined ? {} : { signal }),
      emit: (
        e: StreamEvent | { type: "log"; op: string; level: "debug" | "info" | "warn"; message: string },
      ) => (e.type === "log" ? deps.log(e.level, e.message) : deps.emit(e)),
    };
    const listed = await checkSnapshot({
      io,
      engine: store.engine,
      store: store.blob,
      stored: chosen.stored,
      event: chosen.event,
      ctx,
      op,
      nearest: parent,
      holder,
      resuming: false,
      address: ref.address,
      elsewhere: command(chosen.snapshot),
      // A restore installs nothing: the stripped dependencies need no room (D58).
      dependencies: false,
    });
    if (!listed.ok) return signal?.aborted ? cancelled() : listed;
    phase("preflight", "end");
    if (signal?.aborted) return cancelled();
    const restored = await restoreVerified({
      io,
      engine: store.engine,
      stored: chosen.stored,
      staging,
      ctx,
      phase,
      step: async () => ok(undefined),
      stopped: () => signal?.aborted === true,
      cancelled,
      fix: `nothing was left at ${to}; re-run the restore, and if it fails again run restic check on the store`,
    });
    if (!restored.ok) return restored;
    // The landing folder is made exclusively, then the restored one renamed over it: rename(2) replaces only this
    // restore's own empty folder, never one something else made (D58). Anything put into it meanwhile refuses.
    const occupied = (): Failure =>
      fail(
        finding("path.occupied", {
          message: `${to} appeared while snapshot ${chosen.snapshot} was restored; it was left alone`,
          fix: command(chosen.snapshot),
          paths: [to],
        }),
      );
    try {
      await io.fs.mkdir(to);
    } catch (error) {
      if (systemErrorCode(error) === "EEXIST") return occupied();
      return writeFailed(error, `making ${to}`, false, to);
    }
    try {
      await io.fs.rename(staging, to);
    } catch (error) {
      const code = systemErrorCode(error);
      if (code === "ENOTEMPTY" || code === "EEXIST") return occupied();
      // Its own empty folder goes again; anything in it stays.
      await rmdirIfEmpty(io, to);
      return writeFailed(error, `moving ${staging} to ${to}`, false, to);
    }
    // The rename landed: the copy is there whatever the flush says.
    try {
      await io.fs.syncDir(parent);
    } catch (error) {
      assertSystemError(error);
      deps.log(
        "warn",
        `${to} is restored, but its folder could not be flushed to disk (${(error as Error).message})`,
      );
    }
    // The folder's own mode, which the snapshot does not hold (D55).
    if (listed.value.rootMode !== undefined) {
      try {
        await io.fs.chmod(to, listed.value.rootMode);
      } catch (error) {
        assertSystemError(error);
        deps.log("warn", `${to} could not be given its mode ${listed.value.rootMode.toString(8)}`);
      }
    }
    return ok({
      op,
      project: ref.address,
      snapshot: chosen.snapshot,
      store: store.name,
      dir: to,
      files: listed.value.files,
      bytes: listed.value.bytes,
    });
  }

  /** The head; without one (incomplete, conflicted) --snapshot is required: usage.invalid naming the candidates (D60). */
  function headOf(project: CatalogProject): string | Failure {
    const ids = Object.keys(project.snapshots).sort();
    const why =
      project.missing.length > 0
        ? `the catalog names ${plural(project.missing.length, "snapshot")} of ${ref.address} it does not hold (${project.missing.join(", ")}), so its head is unknown`
        : project.conflicts.length > 0 || project.head === null
          ? `${ref.address} is conflicted in the catalog (${project.conflicts.map((c) => c.join(" and ")).join("; ")}), so it has no head`
          : undefined;
    if (why === undefined) return project.head as string;
    return fail(
      finding("usage.invalid", {
        message: `${why}; name the snapshot to restore with --snapshot, one of: ${ids.join(", ")}`,
        fix: command(ids.at(-1) ?? "<id>"),
      }),
    );
  }
};
