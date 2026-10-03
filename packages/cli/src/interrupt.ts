// SIGINT, SIGTERM and SIGHUP to plainport. Every child runs in its own session and process group (the runner), so
// a terminal's Ctrl-C, a closed terminal or a dropped SSH session reaches plainport alone. On the first signal:
// - if the command has already finished, nothing changes: plainport exits with the command's own code;
// - if no child is running and no saga holds the command's cancellation, plainport exits 130 at once, as an
//   unhandled Ctrl-C would (any run about to start is cancelled first, so none starts);
// - a saga that holds it is told through its AbortSignal and stops at its next safe point;
// - otherwise it stops every child (the host's stopAll: TERM, then KILL after the grace period, whole groups) and
//   waits up to settleMs for the command to report. A command that reports in time exits normally with its own
//   code, so the exit code always matches its envelope (130 when its run was cancelled) and the envelope is flushed;
//   one that does not exits 130.
// Signals that arrive while it is stopping are ignored, so a second Ctrl-C cannot cut the KILL short and leave a
// child behind; the wait is bounded by the runs' grace periods.

/**
 * The running command's cancellation: the first signal aborts it. A command that holds it (a saga) stops at its own
 * next safe point and reports, so plainport waits for that report instead of exiting at once.
 */
export class Cancellation {
  private readonly controller = new AbortController();
  private holds = 0;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Marks the command as one that stops at its safe points when signalled; call the result once it has finished. */
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
    };
  }

  /** A held command is running. */
  busy(): boolean {
    return this.holds > 0;
  }

  abort(): void {
    this.controller.abort();
  }
}

/** What stopOnSignals needs of the host. */
export interface Stoppable {
  stopAll(): Promise<void>;
  liveGroups(): readonly number[];
}

export interface StopOnSignalsOptions {
  stderr(text: string): void;
  /** Default: SIGINT, SIGTERM and SIGHUP. */
  signals?: readonly NodeJS.Signals[];
  /** After the children are stopped, how long the command gets to finish and report. Default 2 seconds. */
  settleMs?: number;
  /** The command's cancellation: aborted on the first signal; while it is held, plainport waits for the report. */
  operation?: Pick<Cancellation, "abort" | "busy">;
  exit?: (code: number) => void;
}

/** Installs the handlers; the returned function removes them (call it once the command has finished). */
export const stopOnSignals = (
  host: Stoppable,
  done: Promise<number>,
  options: StopOnSignalsOptions,
): (() => void) => {
  const signals = options.signals ?? (["SIGINT", "SIGTERM", "SIGHUP"] as const);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let finished: number | undefined;
  const reported = done.then(
    (code) => {
      finished = code;
    },
    () => {},
  );
  let stopping = false;
  // After SIGHUP the terminal may be gone, and a write to it can throw: that must never end the handler before the
  // children are stopped.
  const say = (text: string): void => {
    try {
      options.stderr(text);
    } catch {
      // Nowhere to say it.
    }
  };
  const handler = (signal: NodeJS.Signals): void => {
    // Finished already: the command's own code and envelope stand, and the normal exit follows.
    if (stopping || finished !== undefined) return;
    stopping = true;
    const running = host.liveGroups().length > 0 || options.operation?.busy() === true;
    options.operation?.abort();
    // stopAll cancels synchronously, so no run can start after this line.
    const stopped = host.stopAll();
    if (!running) {
      say(`plainport: ${signal}: exiting\n`);
      exit(130);
      return;
    }
    say(`plainport: ${signal}: stopping child processes, then exiting\n`);
    void (async () => {
      try {
        await stopped;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          reported,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, options.settleMs ?? 2_000);
          }),
        ]);
        clearTimeout(timer);
      } finally {
        if (finished === undefined) exit(130);
        // The command reported: let the normal exit flush its envelope with its own code. Should something still
        // hold the event loop, the unref'd fallback ends it with that same code.
        else setTimeout(() => exit(finished as number), 5_000).unref();
      }
    })();
  };
  for (const signal of signals) process.on(signal, handler);
  return () => {
    for (const signal of signals) process.off(signal, handler);
  };
};
