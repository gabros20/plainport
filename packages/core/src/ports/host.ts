// The host port (DESIGN.md "Core API": `host?: HostPorts; // fs, processes, clock; swapped in tests`). It is the
// LocalIo core already takes (run decision D21) grown by a clock, the one process runner, and the crash seam the
// crash matrix uses (ADR-0017). @plainport/host-macos implements it; tests pass it or fakes.

import type { Result } from "@plainport/contract";
import type { LocalIo } from "../io.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import type { RunOutcome, RunSpec } from "../runner/types.ts";

export interface Clock {
  now(): Date;
  /** Milliseconds on a clock that never goes backwards, for deadlines. */
  monotonicMs(): number;
  sleep(ms: number): Promise<void>;
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
   * This host's boot session (boot.ts readBootSession): an id the kernel makes at every boot, which no clock step
   * moves. Undefined when the platform has none or it cannot be read; read once per host and kept.
   */
  bootSession(): Promise<string | undefined>;
  /**
   * Deletes an offload's trash folder, then its journal, from a detached process that outlives this command (DESIGN.md
   * "Offload process" step 8). The one sanctioned exception to the one process runner (D47): the command is fixed
   * and internal, it has no output to bound, and only a journaled trash path is accepted (`.../.plainport-trash/<op>`,
   * with its `journal/<op>.json`). If it dies or never starts, recover and gc finish the trash. It claims the trash
   * for this device (`device`, D64) before deleting; it resolves ok once that claim is there. One that cannot start is
   * process.spawn-failed; one that cannot claim is stopped, and fs.write-failed. The child runs the delete guard
   * (D87) right before it deletes, with `paths` and `env`, the caller's own.
   */
  deleteTrashDetached(
    trash: string,
    journal: string,
    device: string,
    /** keepUntil: the deadline the caller took off the journal, which the child puts back if its guard refuses. */
    context: { paths: PlainportPaths; env: Env; keepUntil?: string },
  ): Promise<Result<{ pid: number }>>;
}

/** Dotted lower-case words, at least two: offload.release, onload.swap.rename. The name every fault step has. */
export const FAULT_STEP = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/;

const checkStep = (step: string): void => {
  if (!FAULT_STEP.test(step))
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
