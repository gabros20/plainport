// The plainport entry point: gate one invocation, run its handler, render the result (ADR-0007). run() takes its
// I/O, ports and registry as arguments so tests drive it in process with fakes; the binary passes the real ones.
// Whatever throws, from the gate to the last write, ends as one internal.unexpected refusal (exit 1).

import { decode, type Failure, fail, finding } from "@plainport/contract";
import { resolvePaths } from "@plainport/core";
import { nodePlugin } from "@plainport/eco-node";
import { createMacosChecks, createMacosHost, guardFromEnv, type MacosHost } from "@plainport/host-macos";
import { REGISTRY } from "./commands/index.ts";
import { gate } from "./gate.ts";
import { housekeep } from "./housekeeping.ts";
import { Cancellation, stopOnSignals } from "./interrupt.ts";
import { preloadPlans } from "./plans.ts";
import { clackPrompter } from "./prompt.ts";
import type { CommandContext, Ports, Registry } from "./registry.ts";
import { type IO, Output } from "./render.ts";
import { localStores } from "./stores.ts";
import { testFaultPlan } from "./test-hooks.ts";

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

/** Runs one invocation (`argv` is everything after `plainport`) and returns the exit code. Never rejects. `onOutput`
 * is told of the invocation's output as soon as it exists, so a signal can print the cancellation through it (D81). */
export const run = async (
  argv: readonly string[],
  io: IO,
  ports: Ports,
  registry: Registry = REGISTRY,
  options: { onOutput?: (output: Output) => void } = {},
): Promise<number> => {
  let output: Output | undefined;
  let verb = argv[0] ?? "plainport";
  let verbose = false;
  try {
    const gated = gate(argv, registry, ports.plans);
    if (!gated.ok) {
      verb = gated.verb;
      output = new Output(io, { json: gated.json, quiet: false, verbose: false }, gated.verb);
      options.onOutput?.(output);
      return output.failure(gated.failure);
    }
    const { command, args, globals, risk } = gated;
    verb = command.name;
    verbose = globals.verbose;
    const out = new Output(io, globals, command.name);
    output = out;
    options.onOutput?.(out);
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
      io: ports.io,
      env: ports.env,
      cwd: ports.cwd,
      prompt: ports.prompt,
      system: ports.system,
      checks: ports.checks,
      plugins: ports.plugins,
      stores: ports.stores,
      signal: ports.cancellation?.signal ?? new AbortController().signal,
      holdSignal: () => ports.cancellation?.hold() ?? (() => {}),
      paths: () => resolvePaths(ports.env, { configFlag: globals.config, cwd: ports.cwd }),
    };
    // Due trash and the interrupted operations' notices, before the command itself (D59).
    await housekeep(command.name, ctx);
    const result = await command.handler(args, ctx);
    const plan = globals.dryRun && command.dryRun !== false ? command.dryRun : undefined;
    const what = plan === undefined ? `${command.name}'s output` : `${command.name}'s plan`;
    if (!result.ok) {
      if (result.data === undefined) return out.failure(result);
      // A failure with a result that stands (D14): the result is checked like a success's before it is printed.
      const partial = decode(plan === undefined ? command.output : plan.plan, result.data, what);
      if (!partial.ok) return out.failure(partial);
      const human = plan === undefined ? command.human(partial.value) : plan.human(partial.value);
      return out.failure({ ...result, data: partial.value }, human);
    }
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

/**
 * What a signal that ends plainport before its command reported prints (D81): under --json, an operation.cancelled
 * envelope through the command's own output, so stdout still ends with exactly one envelope. In human mode the
 * interrupt's stderr line says it.
 */
export const cancellationReport = (io: IO, argv: readonly string[]) => {
  let live: Output | undefined;
  return {
    onOutput: (output: Output): void => {
      live = output;
    },
    cancelled: (signal: NodeJS.Signals, windingDown: boolean): void => {
      const output =
        live ??
        new Output(io, { json: wantsJson(argv), quiet: false, verbose: false }, argv[0] ?? "plainport");
      if (!output.json || output.finished) return;
      output.failure(
        fail(
          finding(
            "operation.cancelled",
            windingDown
              ? {
                  message: `a second ${signal} stopped plainport while ${output.verb} was winding down to a safe point`,
                  fix: "plainport recover finishes or rolls back what it journaled",
                }
              : {
                  message: `${signal} stopped plainport ${output.verb} before it finished`,
                  fix: "re-run the command; plainport status shows any operation it left interrupted",
                },
          ),
        ),
      );
    },
  };
};

/** The real ports. core's io is the macOS host port (guarded only when a test run names its real home); the plan
 * store holds the fresh plans saved on this device, read before the gate runs. Paths come from the environment,
 * never os.homedir(). */
const realPorts = async (host: MacosHost, cancellation: Cancellation): Promise<Ports> => {
  const now = new Date();
  return {
    host: { home: process.env.HOME ?? "" },
    clock: { now: () => new Date() },
    plans: await preloadPlans(host, process.env, now),
    io: host,
    env: process.env,
    cwd: process.cwd(),
    prompt: clackPrompter,
    system: host,
    checks: createMacosChecks(host),
    plugins: [nodePlugin],
    stores: localStores(host, process.env),
    cancellation,
  };
};

if (import.meta.main) {
  const io: IO = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    isTTY: process.stdin.isTTY === true,
  };
  // One host for the whole invocation: SIGINT and SIGTERM stop every child it runs before plainport exits 130. Its
  // faults are the crash matrix's: the define folds this test to false in every release build, which drops the hook
  // (test-hooks.ts, D67).
  const guard = guardFromEnv(process.env);
  const faults =
    globalThis.PLAINPORT_TEST_HOOKS === true ? await testFaultPlan(process.env, guard) : undefined;
  const host = createMacosHost({ guard, ...(faults === undefined ? {} : { faults }) });
  const argv = process.argv.slice(2);
  // Building the ports reads the saved plans; a bug there ends as internal.unexpected like any other (rule 7).
  const cancellation = new Cancellation();
  const report = cancellationReport(io, argv);
  const done = realPorts(host, cancellation).then(
    (ports) => run(argv, io, ports, REGISTRY, { onOutput: report.onOutput }),
    (error: unknown) =>
      new Output(io, { json: wantsJson(argv), quiet: false, verbose: false }, argv[0] ?? "plainport").failure(
        unexpected("loading saved plans", error),
      ),
  );
  const release = stopOnSignals(host, done, {
    stderr: (text) => process.stderr.write(text),
    operation: cancellation,
    cancelled: report.cancelled,
  });
  process.exitCode = await done;
  release();
}
