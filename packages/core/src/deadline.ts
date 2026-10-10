// A deadline for one host call that may never return (D32): a stat on a hung SMB or NFS mount blocks in the kernel,
// and Node offers no way to cancel it. The race only stops the wait. The call itself keeps its thread from Bun's pool
// until the mount answers or the process exits, and its late result or error is dropped. Children have deadlines of
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

/** `work`'s value, or `timedOut` when it has not settled within `ms`; a rejection passes through as one. */
export const withinDeadline = async <T>(
  work: Promise<T>,
  ms: number,
  scheduler: Scheduler = realScheduler,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> => {
  let timer: unknown;
  const late = new Promise<{ timedOut: true }>((resolve) => {
    timer = scheduler.setTimer(() => resolve({ timedOut: true }), ms);
  });
  // A call that settles after the deadline has nobody waiting: its rejection must not surface as unhandled.
  work.catch(() => {});
  try {
    return await Promise.race([work.then((value) => ({ timedOut: false as const, value })), late]);
  } finally {
    scheduler.clearTimer(timer);
  }
};

/** `work` under a store probe's deadline (ProbeOptions); `late` is the result when it does not answer in time. */
export const probeWithin = async <T>(
  work: Promise<T>,
  probe: ProbeOptions,
  late: (seconds: number) => T,
): Promise<T> => {
  const ms = probe.deadlineMs ?? STORE_PROBE_DEADLINE_MS;
  const probed = await withinDeadline(work, ms, probe.scheduler);
  return probed.timedOut ? late(ms / 1000) : probed.value;
};
