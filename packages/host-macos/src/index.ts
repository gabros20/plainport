// @plainport/host-macos — The macOS host port.

export const packageName = "@plainport/host-macos";
export { type GuardPolicy, PATH_REFUSED, PathGuard, PathRefused } from "./guard.ts";
export { createMacosHost, guardFromEnv, type MacosHost, type MacosHostOptions } from "./host.ts";
export { posixSpawner } from "./spawner.ts";
