// A deadline for one host call that may never return (D32): a stat on a hung SMB or NFS mount blocks in the kernel,
// and Node offers no way to cancel it. The race only stops the wait. The call itself keeps its thread from Bun's pool
// until the mount answers or the process exits, and its late result or error is dropped. It also keeps the event loop
// alive, so it is counted (abandonedCalls) and the CLI exits explicitly while any is out (cli/src/exit.ts). Children have deadlines of
// their own (the one runner); this is for file system calls made in-process.
//
// The timer is a port (AGENTS.md rule 5): `realScheduler` by default, a fake in tests. It must be cancellable, so a
// probe that answers in time leaves no timer that holds the process open (a sleep could not be cleared).

/** How long a store probe (does its folder stand?) may take before the store reads as unreachable. */
export const STORE_PROBE_DEADLINE_MS = 10_000;

/** A cancellable timer: what a deadline needs of the clock. */
export interface Scheduler {
  /** Calls `fire` once after `ms`, unless cleared first; the handle clears it. */
  setTimer(fire: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  setTimer: (fire, ms) => setTimeout(fire, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** How a store's probes are bounded: STORE_PROBE_DEADLINE_MS on the real timers unless a test says otherwise. */
export interface ProbeOptions {
  deadlineMs?: number;
  scheduler?: Scheduler;
}

/** A deadline's outcome: the call's value, or a tag saying it did not answer within `seconds`. */
export type Deadlined<T> = { timedOut: false; value: T } | { timedOut: true; seconds: number };

/** Calls a deadline gave up on that have not settled since: each holds a thread of Bun's pool (see above). */
let abandoned = 0;

/**
 * How many calls a deadline gave up on are still running. While any is, the process cannot rely on its event loop
 * draining to exit: the CLI's entry point exits explicitly once its output is flushed (main.ts).
 */
export const abandonedCalls = (): number => abandoned;

/** `work`'s value, or `timedOut` when it has not settled within `ms`; a rejection passes through as one. */
export const withinDeadline = async <T>(
  work: Promise<T>,
  ms: number,
  scheduler: Scheduler = realScheduler,
): Promise<Deadlined<T>> => {
  let timer: unknown;
  const late = new Promise<{ timedOut: true; seconds: number }>((resolve) => {
    timer = scheduler.setTimer(() => resolve({ timedOut: true, seconds: ms / 1000 }), ms);
  });
  // A call that settles after the deadline has nobody waiting: its rejection must not surface as unhandled.
  work.catch(() => {});
  try {
    const outcome = await Promise.race([work.then((value) => ({ timedOut: false as const, value })), late]);
    if (outcome.timedOut) {
      abandoned++;
      const settled = () => {
        abandoned--;
      };
      work.then(settled, settled);
    }
    return outcome;
  } finally {
    scheduler.clearTimer(timer);
  }
};

/** `work` under a store probe's deadline (ProbeOptions): STORE_PROBE_DEADLINE_MS on the real timers by default. */
export const probeDeadline = <T>(work: Promise<T>, probe: ProbeOptions): Promise<Deadlined<T>> =>
  withinDeadline(work, probe.deadlineMs ?? STORE_PROBE_DEADLINE_MS, probe.scheduler);
