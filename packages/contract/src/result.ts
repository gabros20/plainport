// Result: expected failures are values with an exit code and a finding, never exceptions (AGENTS.md rule 7).

import { z } from "zod";
import { EXIT, type FailureExitCode } from "./exit-codes.ts";
import { FINDINGS, type Finding, type FindingSpec, finding } from "./finding.ts";

export type Ok<T> = { ok: true; value: T };
export type Failure = {
  ok: false;
  exitCode: FailureExitCode;
  finding: Finding;
  /** A useful result that still stands (D14): a blocked dry run's plan (6), a kept snapshot (8), a restore not
   * hydrated (10), recover's and gc's report (any code). */
  data?: unknown;
};
export type Result<T> = Ok<T> | Failure;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

/** A failure; the exit code defaults to the catalogue's for the finding's code, else 1. */
export const fail = (f: Finding, exitCode?: FailureExitCode): Failure => {
  const spec: FindingSpec | undefined = Object.hasOwn(FINDINGS, f.code)
    ? FINDINGS[f.code as keyof typeof FINDINGS]
    : undefined;
  return { ok: false, exitCode: exitCode ?? spec?.exitCode ?? EXIT.unexpected, finding: f };
};

/** A failure that carries a useful result (D14), e.g. the plan a --dry-run's blockers stopped (exit 6, D38). */
export const failWith = (f: Finding, data: unknown, exitCode?: FailureExitCode): Failure => ({
  ...fail(f, exitCode),
  data,
});

/** Validates a value at an edge. Bad input is an expected failure (contract.invalid), so this never throws. */
export const decode = <S extends z.ZodType>(
  schema: S,
  input: unknown,
  what = "input",
): Result<z.output<S>> => {
  let message: string;
  try {
    const parsed = schema.safeParse(input);
    if (parsed.success) return ok(parsed.data);
    message = `${what} is not valid: ${z.prettifyError(parsed.error)}`;
  } catch (error) {
    message = `${what} could not be checked: ${error instanceof Error ? error.message : String(error)}`;
  }
  return fail(finding("contract.invalid", { message }));
};
