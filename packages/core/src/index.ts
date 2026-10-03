// @plainport/core — Domain, planner, sagas, journal, catalog fold and ports.

export const packageName = "@plainport/core";
export { TEMP_SUFFIX, tempPathFor } from "./atomic.ts";
export * from "./catalog/index.ts";
export * from "./config/index.ts";
export * from "./device.ts";
export { type GuardPolicy, guardedFs, PATH_REFUSED, PathGuard, PathRefused } from "./guard.ts";
export {
  type DirEntry,
  errorCode,
  type FileKind,
  type FileStat,
  type LinkStat,
  type LocalFs,
  type LocalIo,
  type ProcessInfo,
  systemErrorCode,
} from "./io.ts";
export * from "./journal/index.ts";
export { acquireLock, type HeldLock, type LockHolder, LockHolderSchema, type LockOptions } from "./lock.ts";
// The real LocalIo, for the composition root (the CLI's main) only (run decision D21).
export { nodeLocalIo } from "./node-io.ts";
export * from "./paths.ts";
export * from "./plan/index.ts";
export * from "./ports/blob-store.ts";
export type * from "./ports/checks.ts";
export type * from "./ports/ecosystem.ts";
export type * from "./ports/engine.ts";
export {
  type Clock,
  type FaultPlan,
  faultSeam,
  type HostPorts,
  InjectedFault,
} from "./ports/host.ts";
export type * from "./ports/store.ts";
export * from "./preflight/index.ts";
export * from "./recover/recover.ts";
export * from "./recover/trash.ts";
export * from "./registry.ts";
export * from "./roots/index.ts";
export * from "./runner/index.ts";
export * from "./saga/hydrate.ts";
export * from "./saga/offload.ts";
export * from "./saga/onload.ts";
export * from "./saga/restore.ts";
export * from "./scan/index.ts";
export { posixDeleteTrash, posixSpawner } from "./spawner.ts";
export * from "./status/projects.ts";
export * from "./store.ts";
export * from "./stub.ts";
export * from "./tools.ts";
export * from "./ulid.ts";
export { VERSION } from "./version.ts";
