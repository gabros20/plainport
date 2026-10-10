// How plainport's process ends. Normally it sets process.exitCode and lets the event loop drain. But a file system call
// a deadline gave up on (D32, core's deadline.ts: a stat on a hung network mount) stays in Bun's thread pool and keeps
// the loop alive until the mount answers, so plainport would print its result and then never exit, and an agent waiting
// on the exit code (AGENTS.md rule 3) would wait as before. While any such call is out, the process exits explicitly,
// once what it wrote to stdout and stderr is flushed.

import { abandonedCalls } from "@plainport/core";

export interface FinishDeps {
  /** How many calls a deadline gave up on are still running (core's abandonedCalls). */
  abandoned(): number;
  /** The streams to flush before exiting. */
  streams: readonly NodeJS.WritableStream[];
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

/** Ends the process with `code`: by draining, or, while an abandoned call is out, by exiting once output is flushed. */
export const finishProcess = async (code: number, deps: FinishDeps = real()): Promise<void> => {
  deps.setCode(code);
  if (deps.abandoned() === 0) return;
  await Promise.all(
    deps.streams.map((stream) => new Promise<void>((resolve) => stream.write("", () => resolve()))),
  );
  deps.exit(code);
};
