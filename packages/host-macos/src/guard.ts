// The path guard lives in core (guard.ts there), so core's own tests can use it too; this keeps the old import.
export { type GuardPolicy, guardedFs, PATH_REFUSED, PathGuard, PathRefused } from "@plainport/core";
