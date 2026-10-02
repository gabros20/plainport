// The risk gate (ADR-0003, ADR-0007, run decision D15): a pure verdict from a command's risk class and its flags.
// No I/O and no exit; packages/cli parses the flags, prints the refusal and exits. Adapted from
// gabros20/plainkeep@d7eb27e cli/src/core/guardrail.ts (gate, remediation): confirm without --yes is refused
// with the exact re-run, an undeclared risk is confirm, and --dry-run downgrades to read only for a command
// that declares it supports a dry run (a command that doesn't would otherwise run for real without --yes).

import { EXIT } from "./exit-codes.ts";
import { type Finding, finding } from "./finding.ts";
import { DEFAULT_RISK, type RiskClass } from "./risk.ts";

export interface GateRequest {
  /** The command as registered, e.g. offload or root add; used in the message. */
  command: string;
  /** The arguments after `plainport`, exactly as given; the re-run repeats them. */
  argv: readonly string[];
  /** The declared risk class; undefined is treated as confirm. */
  risk?: RiskClass;
  supportsDryRun: boolean;
  yes: boolean;
  /** An approved --plan <id> was given. Whether the plan is still fresh is checked later (exit 6 when stale). */
  plan: boolean;
  dryRun: boolean;
}

export type GateVerdict =
  | { verdict: "allow"; riskClass: RiskClass }
  | { verdict: "confirm"; riskClass: "confirm"; exitCode: 3; rerun: string; hint: string; finding: Finding };

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** A POSIX shell word that reads back as exactly `arg`. */
const shellWord = (arg: string): string => (SAFE_WORD.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);

/** The exact command to re-run with --yes added, before any `--` so it stays a flag. */
export const rerunWithYes = (argv: readonly string[]): string => {
  const end = argv.indexOf("--");
  const args = end === -1 ? [...argv, "--yes"] : [...argv.slice(0, end), "--yes", ...argv.slice(end)];
  return ["plainport", ...args].map(shellWord).join(" ");
};

export const gate = (request: GateRequest): GateVerdict => {
  const risk = request.risk ?? DEFAULT_RISK;
  if (request.dryRun && request.supportsDryRun) return { verdict: "allow", riskClass: "read" };
  if (risk !== "confirm" || request.yes || request.plan) return { verdict: "allow", riskClass: risk };
  const rerun = rerunWithYes(request.argv);
  return {
    verdict: "confirm",
    riskClass: "confirm",
    exitCode: EXIT.confirm,
    rerun,
    hint: `re-run: ${rerun}`,
    finding: finding("risk.needs-yes", {
      message: `${request.command} is confirm-class: it sends data off this machine or deletes it, so it needs --yes`,
      fix: rerun,
    }),
  };
};
