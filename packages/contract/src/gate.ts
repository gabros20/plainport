// The risk gate (ADR-0003, ADR-0007, run decision D15): a pure verdict from a command's risk class and its flags.
// No I/O and no exit; packages/cli parses the flags, prints the refusal and exits. Adapted from
// gabros20/plainkeep@d7eb27e cli/src/core/guardrail.ts (gate, remediation): confirm without --yes is refused
// with the exact re-run, and an undeclared risk is confirm. --dry-run is always read (ADR-0007, run decision D18);
// a command without a dry run must refuse the flag first, with refuseDryRun, so it never runs for real as read.

import { EXIT } from "./exit-codes.ts";
import { type Finding, finding } from "./finding.ts";
import { fail, ok, type Result } from "./result.ts";
import { DEFAULT_RISK, type RiskClass } from "./risk.ts";

export interface GateRequest {
  /** The command as registered, e.g. offload or root add; used in the message. */
  command: string;
  /** The arguments after `plainport`, exactly as given; the re-run repeats them. */
  argv: readonly string[];
  /** The declared risk class; undefined is treated as confirm. */
  risk?: RiskClass;
  yes: boolean;
  /** An approved --plan <id> was given. Whether the plan is still fresh is checked later (exit 6 when stale). */
  plan: boolean;
  dryRun: boolean;
}

export type GateVerdict =
  | { verdict: "allow"; riskClass: RiskClass }
  | { verdict: "confirm"; riskClass: "confirm"; exitCode: 3; rerun: string; hint: string; finding: Finding };

// Left bare only when no shell gives it a meaning: zsh expands a leading = to a command path (EQUALS) and a
// leading ~ to a home folder, so the first character is held to a narrower set than the rest.
const SAFE_WORD = /^[A-Za-z0-9_@+:,./-][A-Za-z0-9_@%+=:,./-]*$/;

/** A POSIX shell word that reads back as exactly `arg`. */
const shellWord = (arg: string): string => (SAFE_WORD.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);

/** The exact command to re-run with --yes added, before any `--` so it stays a flag. */
const commandLine = (argv: readonly string[]): string => ["plainport", ...argv].map(shellWord).join(" ");

export const rerunWithYes = (argv: readonly string[]): string => {
  const end = argv.indexOf("--");
  return commandLine(end === -1 ? [...argv, "--yes"] : [...argv.slice(0, end), "--yes", ...argv.slice(end)]);
};

/** The command without --dry-run (options before any `--` only). */
const withoutDryRun = (argv: readonly string[]): string[] => {
  const end = argv.indexOf("--") === -1 ? argv.length : argv.indexOf("--");
  return [...argv.slice(0, end).filter((arg) => arg !== "--dry-run"), ...argv.slice(end)];
};

/**
 * D18: a command that has no dry run refuses --dry-run as a usage error (exit 2) before anything runs, instead of
 * running for real. The CLI calls this before gate().
 */
export const refuseDryRun = (request: {
  command: string;
  argv: readonly string[];
  supportsDryRun: boolean;
  dryRun: boolean;
}): Result<null> =>
  !request.dryRun || request.supportsDryRun
    ? ok(null)
    : fail(
        finding("usage.dry-run-unsupported", {
          message: `${request.command} has no --dry-run preview`,
          fix: commandLine(withoutDryRun(request.argv)),
        }),
      );

export const gate = (request: GateRequest): GateVerdict => {
  const risk = request.risk ?? DEFAULT_RISK;
  if (request.dryRun) return { verdict: "allow", riskClass: "read" };
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
