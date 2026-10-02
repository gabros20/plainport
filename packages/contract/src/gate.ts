// The risk gate (ADR-0003, ADR-0007, run decisions D15 and D18): one pure check of a command's risk class and
// its flags. No I/O and no exit; packages/cli parses the flags, prints the refusal and exits. Adapted from
// gabros20/plainkeep@d7eb27e cli/src/core/guardrail.ts (gate, remediation): confirm without --yes is refused
// with the exact re-run, and an undeclared risk is confirm. --dry-run is always read, so a command without a dry
// run refuses the flag before the risk is looked at; both steps live behind checkInvocation, so the CLI cannot
// run one without the other.

import { finding } from "./finding.ts";
import { fail, ok, type Result } from "./result.ts";
import { DEFAULT_RISK, type RiskClass } from "./risk.ts";

export interface Invocation {
  /** The command as registered, e.g. offload or root add; used in messages. */
  command: string;
  /** The arguments after `plainport`, exactly as given; a re-run repeats them. */
  argv: readonly string[];
  /** The declared risk class; undefined is treated as confirm. */
  risk?: RiskClass;
  /** Whether the command implements a --dry-run preview. */
  supportsDryRun: boolean;
  yes: boolean;
  /** An approved --plan <id> was given. Whether the plan is still fresh is checked later (exit 6 when stale). */
  plan: boolean;
  dryRun: boolean;
}

// Left bare only when no shell gives it a meaning: zsh expands a leading = to a command path (EQUALS) and a
// leading ~ to a home folder, so the first character is held to a narrower set than the rest.
const SAFE_WORD = /^[A-Za-z0-9_@+:,./-][A-Za-z0-9_@%+=:,./-]*$/;

/** A POSIX shell word that reads back as exactly `arg`. */
const shellWord = (arg: string): string => (SAFE_WORD.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);

const commandLine = (argv: readonly string[]): string => ["plainport", ...argv].map(shellWord).join(" ");

/** The exact command to re-run with --yes added, before any `--` so it stays a flag. */
export const rerunWithYes = (argv: readonly string[]): string => {
  const end = argv.indexOf("--");
  return commandLine(end === -1 ? [...argv, "--yes"] : [...argv.slice(0, end), "--yes", ...argv.slice(end)]);
};

/** The command without --dry-run (options before any `--` only). */
const withoutDryRun = (argv: readonly string[]): string[] => {
  const found = argv.indexOf("--");
  const end = found === -1 ? argv.length : found;
  return [...argv.slice(0, end).filter((arg) => arg !== "--dry-run"), ...argv.slice(end)];
};

/** The next step after a refused --dry-run. It never suggests running something that writes without a check. */
const dryRunFix = (command: string, argv: readonly string[], risk: RiskClass): string => {
  if (risk === "read")
    return `it only reads, so run it without --dry-run: ${commandLine(withoutDryRun(argv))}`;
  if (risk === "safe_write") {
    return `without --dry-run it changes files straight away; see what it does first: plainport help ${command}`;
  }
  return `without --dry-run it still asks for --yes before changing anything: ${commandLine(withoutDryRun(argv))}`;
};

/**
 * Whether an invocation may run, and as which risk class. Refusals are failures: --dry-run on a command without a
 * preview is a usage error (exit 2, D18); confirm without --yes or an approved --plan is exit 3, and the finding's
 * fix is the exact re-run (the CLI prints it as `re-run: …`).
 */
export const checkInvocation = (invocation: Invocation): Result<{ riskClass: RiskClass }> => {
  const risk = invocation.risk ?? DEFAULT_RISK;
  if (invocation.dryRun) {
    if (invocation.supportsDryRun) return ok({ riskClass: "read" });
    return fail(
      finding("usage.dry-run-unsupported", {
        message: `${invocation.command} has no --dry-run preview`,
        fix: dryRunFix(invocation.command, invocation.argv, risk),
      }),
    );
  }
  if (risk !== "confirm" || invocation.yes || invocation.plan) return ok({ riskClass: risk });
  return fail(
    finding("risk.needs-yes", {
      message: `${invocation.command} is confirm-class: it sends data off this machine or deletes it, so it needs --yes`,
      fix: rerunWithYes(invocation.argv),
    }),
  );
};
