// SIGINT and SIGTERM to plainport. Every child runs in its own session and process group (the runner), so the
// terminal's Ctrl-C reaches plainport alone. On the first signal, plainport stops every child it is running (the
// host's stopAll: TERM, then KILL after the grace period, whole groups), gives the command a moment to report its
// cancelled result, and exits 130. Signals that arrive while it is stopping are ignored, so a second Ctrl-C cannot
// cut the KILL short and leave a child behind; the wait is bounded by the runs' grace periods.

/** What stopOnSignals needs of the host. */
export interface Stoppable {
  stopAll(): Promise<void>;
}

export interface StopOnSignalsOptions {
  stderr(text: string): void;
  /** Default: SIGINT and SIGTERM. */
  signals?: readonly NodeJS.Signals[];
  /** After the children are stopped, how long the command gets to finish rendering. Default 2 seconds. */
  settleMs?: number;
  exit?: (code: number) => void;
}

/** Installs the handlers; the returned function removes them (call it once the command has finished). */
export const stopOnSignals = (
  host: Stoppable,
  done: Promise<unknown>,
  options: StopOnSignalsOptions,
): (() => void) => {
  const signals = options.signals ?? (["SIGINT", "SIGTERM"] as const);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let stopping = false;
  const handler = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    options.stderr(`plainport: ${signal}: stopping child processes, then exiting\n`);
    void (async () => {
      try {
        await host.stopAll();
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          done.catch(() => {}),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, options.settleMs ?? 2_000);
          }),
        ]);
        clearTimeout(timer);
      } finally {
        exit(130);
      }
    })();
  };
  for (const signal of signals) process.on(signal, handler);
  return () => {
    for (const signal of signals) process.off(signal, handler);
  };
};
