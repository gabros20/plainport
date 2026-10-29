// What the secret providers share: the run port, the environment a provider's child gets, and how a run that did not
// end with an answer becomes a finding. Every provider runs its child in the runner's sensitive mode (Task 5): stdout
// comes back only in an ok outcome with exit 0, and nothing either stream says reaches a finding, an event or an error.

import { type Failure, fail, finding, type Result } from "@plainport/contract";
import {
  type Env,
  type RunOutcome,
  type RunSpec,
  SECRET_DEADLINE_MS,
  type SecretContext,
} from "@plainport/core";

/** The one process runner (HostPorts.run). */
export type Run = (spec: RunSpec) => Promise<Result<RunOutcome>>;

export interface ProviderOptions {
  run: Run;
  /** The user's environment: a child gets only what it needs of it (childEnv). */
  env: Env;
}

/** A secret is small: more than this on stdout is not one. */
export const SECRET_MAX_BYTES = 64 * 1024;

/** The names every child gets when set: enough to find its home, its temp folder and its locale. */
const BASE = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"];

/** The child's whole environment: BASE, the `extra` names, and the variables starting with one of `prefixes`. */
export const childEnv = (
  env: Env,
  extra: readonly string[] = [],
  prefixes: readonly string[] = [],
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if ([...BASE, ...extra].includes(name) || prefixes.some((prefix) => name.startsWith(prefix)))
      out[name] = value;
  }
  return out;
};

/** The sensitive run of one provider call, bounded by the call's deadline (Q14) and stopped by its signal. */
export const sensitiveSpec = (
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  ctx: SecretContext | undefined,
  stdin?: Uint8Array,
): RunSpec => {
  const deadline = ctx?.deadlineMs ?? SECRET_DEADLINE_MS;
  return {
    command,
    args,
    cwd: "/",
    env,
    sensitive: true,
    capture: { maxBytes: SECRET_MAX_BYTES },
    // A prompt waits in silence: the idle deadline is the whole deadline.
    timeoutMs: deadline,
    idleTimeoutMs: deadline,
    killGraceMs: 2_000,
    ...(stdin === undefined ? {} : { stdin }),
    ...(ctx?.signal === undefined ? {} : { signal: ctx.signal }),
  };
};

export const secretMissing = (message: string, fix: string): Failure =>
  fail(finding("store.secret-missing", { message, fix }));

/**
 * A run that ended without an answer, as the provider's finding: a cancelled run stays process.cancelled; a run past
 * its deadline, one that could not start, or one whose output could not be read whole is store.secret-missing.
 */
export const unanswered = (
  failure: Failure,
  what: string,
  deadline: { seconds: number; fix: string },
  notStarted: { message: string; fix: string },
): Failure => {
  switch (failure.finding.code) {
    case "process.cancelled":
      return failure;
    case "process.timeout":
    case "process.idle-timeout":
      return secretMissing(`${what} did not answer within ${deadline.seconds} seconds`, deadline.fix);
    case "process.spawn-failed":
      return secretMissing(notStarted.message, notStarted.fix);
    default:
      return secretMissing(
        `${what}'s answer could not be read whole (${failure.finding.code})`,
        "re-run; if it keeps failing, check the provider on its own",
      );
  }
};

/** The answer's text, its bytes overwritten once read: the value lives on only as the returned string. */
export const takeText = (captured: Uint8Array | undefined): string => {
  if (captured === undefined) return "";
  const text = new TextDecoder().decode(captured);
  captured.fill(0);
  return text;
};
