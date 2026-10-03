// The host port (DESIGN.md "Core API": `host?: HostPorts; // fs, processes, clock; swapped in tests`). It is the
// LocalIo core already takes (run decision D21) grown by a clock, the one process runner, and the crash seam the
// crash matrix uses (ADR-0017). @plainport/host-macos implements it; tests pass it or fakes.

import type { Result } from "@plainport/contract";
import type { LocalIo } from "../io.ts";
import type { RunOutcome, RunSpec } from "../runner/types.ts";

export interface Clock {
  now(): Date;
  /** Milliseconds on a clock that never goes backwards, for deadlines. */
  monotonicMs(): number;
  sleep(ms: number): Promise<void>;
}

/** A program started to outlive the command (HostPorts.detach). */
export interface DetachSpec {
  /** An absolute path, or a name looked up on the env's PATH. */
  command: string;
  args: readonly string[];
  cwd: string;
  /** The child's whole environment; nothing is inherited. */
  env: Readonly<Record<string, string>>;
}

export interface HostPorts extends LocalIo {
  clock: Clock;
  /** Runs a child process through the one runner (AGENTS.md rule 6). */
  run(spec: RunSpec): Promise<Result<RunOutcome>>;
  /**
   * The crash seam: a saga calls it at every journal step, named `<saga>.<step>` (offload.release, …). It does
   * nothing unless a test planned a fault at that step; then it throws InjectedFault, or kills the process.
   * Synchronous on purpose: the fault lands at the call itself, so a saga cannot run past its step by forgetting
   * an await.
   */
  faultAt(step: string): void;
  /**
   * Starts a program that outlives this command: a session and process group of its own, stdin, stdout and stderr
   * on /dev/null, never waited for. Only for work that must finish after the command has returned and that recovery
   * repeats if it never ran, such as deleting an offload's trash (DESIGN.md "Offload process" step 8). Resolves with
   * its pid once it has started; one that cannot start is process.spawn-failed.
   */
  detach(spec: DetachSpec): Promise<Result<{ pid: number }>>;
}

/** Dotted lower-case words, at least two: offload.release, onload.swap.rename. */
const STEP = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/;

const checkStep = (step: string): void => {
  if (!STEP.test(step))
    throw new Error(`faultAt: step ${JSON.stringify(step)} is not dotted lower-case words`);
};

/** The simulated crash: sagas must let it through (never catch it), as they would a real one. */
export class InjectedFault extends Error {
  override readonly name = "InjectedFault";
  constructor(readonly step: string) {
    super(`injected fault at ${step}`);
  }
}

export interface FaultPlan {
  /** The step to fail at. Without it, nothing fails and onStep only records. */
  at?: string;
  /** throw (default): InjectedFault, the in-process crash. kill: SIGKILL this process, the real one. */
  action?: "throw" | "kill";
  /** Fail the nth time the step is reached. Default 1. */
  occurrence?: number;
  /** Called with every step reached, before any fault, so the crash matrix can enumerate them. */
  onStep?: (step: string) => void;
}

/** A faultAt function for a plan; `kill` is the host's way to SIGKILL this process. */
export const faultSeam = (plan: FaultPlan | undefined, kill: () => void): ((step: string) => void) => {
  if (plan?.at !== undefined) checkStep(plan.at);
  const occurrence = plan?.occurrence ?? 1;
  if (!Number.isInteger(occurrence) || occurrence < 1)
    throw new Error("faultAt: occurrence must be 1 or more");
  let reached = 0;
  return (step) => {
    checkStep(step);
    plan?.onStep?.(step);
    if (plan?.at !== step || ++reached !== occurrence) return;
    if (plan.action === "kill") kill();
    else throw new InjectedFault(step);
  };
};
