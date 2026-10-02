// The plainport entry point: gate one invocation, run its handler, render the result (ADR-0007). run() takes its
// I/O and registry as arguments so tests drive it in process; the binary passes the real ones.

import { decode, fail, finding } from "@plainport/contract";
import { REGISTRY } from "./commands/index.ts";
import { gate } from "./gate.ts";
import type { CommandContext, Registry } from "./registry.ts";
import { type IO, Output } from "./render.ts";

export type { IO } from "./render.ts";

/** Runs one invocation (`argv` is everything after `plainport`) and returns the exit code. */
export const run = async (
  argv: readonly string[],
  io: IO,
  registry: Registry = REGISTRY,
): Promise<number> => {
  const gated = gate(argv, registry);
  if (!gated.ok) {
    return new Output(io, { json: gated.json, quiet: false, verbose: false }, gated.verb).failure(
      gated.failure,
    );
  }
  const { command, args, globals, risk } = gated;
  const output = new Output(io, globals, command.name);
  const ctx: CommandContext = {
    json: globals.json,
    quiet: globals.quiet,
    verbose: globals.verbose,
    input: io.isTTY && !globals.noInput,
    dryRun: globals.dryRun,
    yes: globals.yes,
    risk,
    store: globals.store,
    config: globals.config,
    registry,
    emit: (event) => output.event(event),
    log: (level, message) => output.log(level, message),
  };
  try {
    const result = await command.handler(args, ctx);
    if (!result.ok) return output.failure(result);
    const data = decode(command.output, result.value, `${command.name}'s output`);
    if (!data.ok) return output.failure(data);
    return output.success(data.value, command.human(data.value));
  } catch (error) {
    if (globals.verbose && error instanceof Error && error.stack !== undefined) io.stderr(`${error.stack}\n`);
    const message = error instanceof Error ? error.message : String(error);
    return output.failure(
      fail(finding("internal.unexpected", { message: `unexpected failure in ${command.name}: ${message}` })),
    );
  }
};

if (import.meta.main) {
  const io: IO = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    isTTY: process.stdin.isTTY === true,
  };
  process.exitCode = await run(process.argv.slice(2), io);
}
