// @plainport/core — Domain, planner, sagas, journal, catalog fold and ports.

export const packageName = "@plainport/core";
export * from "./config/index.ts";
export * from "./device.ts";
export {
  type DirEntry,
  errorCode,
  type FileKind,
  type FileStat,
  type LinkStat,
  type LocalFs,
  type LocalIo,
  type ProcessInfo,
} from "./io.ts";
export { acquireLock, type HeldLock, type LockHolder, LockHolderSchema, type LockOptions } from "./lock.ts";
// The real LocalIo, for the composition root (the CLI's main) only (run decision D21).
export { nodeLocalIo } from "./node-io.ts";
export * from "./paths.ts";
export type * from "./ports/engine.ts";
export {
  type Clock,
  type FaultPlan,
  faultSeam,
  type HostPorts,
  InjectedFault,
} from "./ports/host.ts";
export * from "./registry.ts";
export * from "./roots/index.ts";
export * from "./runner/index.ts";
export * from "./stub.ts";
export * from "./tools.ts";
export * from "./ulid.ts";
export { VERSION } from "./version.ts";
