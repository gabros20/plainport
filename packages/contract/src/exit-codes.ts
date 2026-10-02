// Exit codes: public API that never changes meaning (ADR-0007, docs/machine-contract.md §3).
// Codes 0 to 5 are plainkeep's protocol, adapted from gabros20/plainkeep@d7eb27e cli/src/core/guardrail.ts (EXIT_*).

import { z } from "zod";

export const EXIT = Object.freeze({
  ok: 0,
  unexpected: 1,
  usage: 2,
  confirm: 3,
  notFound: 4,
  denied: 5,
  blocked: 6,
  verifyFailed: 7,
  conflict: 8,
  unreachable: 9,
  unhydrated: 10,
  locked: 11,
  cancelled: 130,
} as const);

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
export type FailureExitCode = Exclude<ExitCode, 0>;

/** What each code means, worded as in DESIGN.md "Exit codes". */
export const EXIT_CODE_MEANINGS: Readonly<Record<ExitCode, string>> = Object.freeze({
  0: "Success",
  1: "Unexpected failure",
  2: "Usage error, or an ambiguous project name",
  3: "Needs --yes; the message names the exact re-run",
  4: "Not found: project, snapshot, device or store",
  5: "Denied by policy: a root not allowed on this device, untrusted hooks, a key without permission",
  6: "Blocked by a preflight finding, or the plan is stale",
  7: "Verification failed",
  8: "Conflict, or a strict lease held elsewhere",
  9: "Store or peer unreachable",
  10: "Restored but not hydrated",
  11: "Another operation holds the lock",
  130: "Cancelled",
});

const codes = Object.values(EXIT);
const failureCodes = codes.filter((code): code is FailureExitCode => code !== 0);

export const ExitCodeSchema = z
  .literal(codes)
  .meta({ title: "ExitCode", description: "plainport exit code" });
export const FailureExitCodeSchema = z
  .literal(failureCodes)
  .meta({ title: "FailureExitCode", description: "Any plainport exit code but 0" });
