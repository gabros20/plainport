// The plainport entry point: gate one invocation, run its handler, render the result (ADR-0007). run() takes its
// I/O, ports and registry as arguments so tests drive it in process with fakes; the binary passes the real ones.
// Whatever throws, from the gate to the last write, ends as one internal.unexpected refusal (exit 1).

import { homedir } from "node:os";
import { decode, type Failure, fail, finding } from "@plainport/contract";
import { REGISTRY } from "./commands/index.ts";
import { gate } from "./gate.ts";
import type { CommandContext, Ports, Registry } from "./registry.ts";
import { type IO, Output } from "./render.ts";

export type { IO } from "./render.ts";

const unexpected = (where: string, error: unknown): Failure =>
  fail(
    finding("internal.unexpected", {
      message: `unexpected failure in ${where}: ${error instanceof Error ? error.message : String(error)}`,
    }),
  );

/** --json as typed, before `--`; used only when the gate itself threw and parsed nothing. */
const wantsJson = (argv: readonly string[]): boolean => {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).includes("--json");
};

/** Runs one invocation (`argv` is everything after `plainport`) and returns the exit code. Never rejects. */
export const run = async (
  argv: readonly string[],
  io: IO,
  ports: Ports,
  registry: Registry = REGISTRY,
): Promise<number> => {
  let output: Output | undefined;
  let verb = argv[0] ?? "plainport";
  let verbose = false;
  try {
    const gated = gate(argv, registry, ports.plans);
    if (!gated.ok) {
      verb = gated.verb;
      output = new Output(io, { json: gated.json, quiet: false, verbose: false }, gated.verb);
      return output.failure(gated.failure);
    }
    const { command, args, globals, risk } = gated;
    verb = command.name;
    verbose = globals.verbose;
    const out = new Output(io, globals, command.name);
    output = out;
    const ctx: CommandContext = {
      json: globals.json,
      quiet: globals.quiet,
      verbose: globals.verbose,
      input: io.isTTY && !globals.noInput,
      dryRun: globals.dryRun,
      yes: globals.yes,
      risk,
      store: globals.store,
      registry,
      host: ports.host,
      clock: ports.clock,
      config: { path: globals.config },
      output: { emit: (event) => out.event(event), log: (level, message) => out.log(level, message) },
    };
    const result = await command.handler(args, ctx);
    if (!result.ok) return out.failure(result);
    const plan = globals.dryRun && command.dryRun !== false ? command.dryRun : undefined;
    const what = plan === undefined ? `${command.name}'s output` : `${command.name}'s plan`;
    const data = decode(plan === undefined ? command.output : plan.plan, result.value, what);
    if (!data.ok) return out.failure(data);
    return out.success(data.value, plan === undefined ? command.human(data.value) : plan.human(data.value));
  } catch (error) {
    if (verbose && error instanceof Error && error.stack !== undefined) io.stderr(`${error.stack}\n`);
    const failure = unexpected(verb, error);
    if (output === undefined)
      output = new Output(io, { json: wantsJson(argv), quiet: false, verbose: false }, verb);
    if (!output.finished) {
      try {
        return output.failure(failure);
      } catch {
        // The output itself failed (e.g. a closed pipe); fall through to stderr.
      }
    }
    try {
      io.stderr(`plainport: ${failure.finding.code}: ${failure.finding.message}\n`);
    } catch {
      // Nothing is left to report to.
    }
    return failure.exitCode;
  }
};

/** The real ports. The host port is a placeholder until Task 7; no plan store exists until Task 10, so no plan id
 * is approved yet and confirm commands need --yes. */
const realPorts = (): Ports => ({
  host: { home: homedir() },
  clock: { now: () => new Date() },
  plans: { approved: () => false },
});

if (import.meta.main) {
  const io: IO = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    isTTY: process.stdin.isTTY === true,
  };
  process.exitCode = await run(process.argv.slice(2), io, realPorts());
}
