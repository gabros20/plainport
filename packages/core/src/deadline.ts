// A deadline for one host call that may never return (D32): a stat on a hung SMB or NFS mount blocks in the kernel,
// and Node offers no way to cancel it. The race only stops the wait. The call itself keeps its thread from Bun's pool
// until the mount answers or the process exits, and its late result or error is dropped. Children have deadlines of
// their own (the one runner); this is for file system calls made in-process.

/** How long a store probe (does its folder stand?) may take before the store reads as unreachable. */
export const STORE_PROBE_DEADLINE_MS = 10_000;

/** `work`'s value, or `timedOut` when it has not settled within `ms`; a rejection passes through as one. */
export const withinDeadline = async <T>(
  work: Promise<T>,
  ms: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  // A call that settles after the deadline has nobody waiting: its rejection must not surface as unhandled.
  work.catch(() => {});
  try {
    return await Promise.race([work.then((value) => ({ timedOut: false as const, value })), late]);
  } finally {
    clearTimeout(timer);
  }
};
