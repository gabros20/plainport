// How plainport's process ends. Normally it sets process.exitCode and lets the event loop drain. But a file system call
// a deadline gave up on (D32, core's deadline.ts: a stat on a hung network mount) stays in Bun's thread pool and keeps
// the loop alive until the mount answers, so plainport would print its result and then never exit, and an agent waiting
// on the exit code (AGENTS.md rule 3) would wait as before. While any such call is out, the process exits explicitly,
// once what it wrote to stdout and stderr is flushed.

import { abandonedCalls } from "@plainport/core";

export interface FinishDeps {
  /** How many calls a deadline gave up on are still running (core's abandonedCalls). */
  abandoned(): number;
  /** The streams to end, so their output reaches its readers, before exiting. */
  streams: readonly NodeJS.WritableStream[];
  /** How long ending them may take; FLUSH_LIMIT_MS by default. */
  flushLimitMs?: number;
  /** Sets the code the process ends with when the loop drains (process.exitCode). */
  setCode(code: number): void;
  exit(code: number): void;
}

const real = (): FinishDeps => ({
  abandoned: abandonedCalls,
  streams: [process.stdout, process.stderr],
  setCode: (code) => {
    process.exitCode = code;
  },
  exit: (code) => process.exit(code),
});

/** How long the output may take to reach its readers before the process exits anyway (a reader that went away). */
export const FLUSH_LIMIT_MS = 2_000;

/**
 * Ends the process with `code`: by draining, or, while an abandoned call is out, by exiting once its output is out.
 * The streams are ended, not just written to: in Bun a write's callback can fire before earlier writes reached a pipe,
 * and exiting then cuts the output (a `--json` envelope that no longer parses). Nothing writes after the command's
 * end, so ending them is safe. The wait is bounded, so a reader that is gone (EPIPE, a closed terminal) cannot hold
 * the exit.
 */
export const finishProcess = async (code: number, deps: FinishDeps = real()): Promise<void> => {
  deps.setCode(code);
  if (deps.abandoned() === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deps.flushLimitMs ?? FLUSH_LIMIT_MS);
  });
  const ended = Promise.all(
    deps.streams.map((stream) => new Promise<void>((resolve) => stream.end(() => resolve()))),
  );
  await Promise.race([ended, limit]);
  clearTimeout(timer);
  deps.exit(code);
};
