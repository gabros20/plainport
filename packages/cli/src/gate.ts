// From argv to a gated invocation (ADR-0007, run decisions D15 and D18). This file parses: it finds the command in
// the registry, parses global and command options with node:util parseArgs, checks the arguments against the
// command's schema and resolves option-level risk. The verdict itself comes from checkInvocation() in
// packages/contract; nothing here decides whether a risk class may run.

import { parseArgs } from "node:util";
import {
  checkInvocation,
  commandLine,
  type Failure,
  fail,
  finding,
  type RiskClass,
} from "@plainport/contract";
import {
  type AnyCommand,
  findCommand,
  optionsOf,
  positionalsOf,
  type Registry,
  resolveRisk,
  suggestCommand,
} from "./registry.ts";

export interface GlobalOption {
  name: string;
  kind: "boolean" | "string";
  summary: string;
  /** For a string option, how help names its value. */
  value?: string;
}

/** DESIGN.md "CLI design" → Global flags, in that order. */
export const GLOBAL_OPTIONS: readonly GlobalOption[] = [
  { name: "json", kind: "boolean", summary: "Print NDJSON: event lines, then exactly one final envelope" },
  { name: "yes", kind: "boolean", summary: "Allow a confirm-class command to run" },
  { name: "no-input", kind: "boolean", summary: "Never prompt; implied when stdin is not a terminal" },
  { name: "dry-run", kind: "boolean", summary: "Preview only: build and print the plan, change nothing" },
  { name: "store", kind: "string", value: "name", summary: "Use this store instead of the default" },
  { name: "config", kind: "string", value: "path", summary: "Read this config file instead of the default" },
  { name: "quiet", kind: "boolean", summary: "Print only results, warnings and errors" },
  { name: "verbose", kind: "boolean", summary: "Print debug logs too" },
];

export interface Globals {
  json: boolean;
  yes: boolean;
  noInput: boolean;
  dryRun: boolean;
  store: string | undefined;
  config: string | undefined;
  quiet: boolean;
  verbose: boolean;
}

export type Gated =
  | { ok: true; command: AnyCommand; args: Record<string, unknown>; globals: Globals; risk: RiskClass }
  | { ok: false; verb: string; json: boolean; failure: Failure };

type ParseOptions = Record<string, { type: "boolean" | "string"; multiple?: boolean }>;

const globalParseOptions = (): ParseOptions =>
  Object.fromEntries(GLOBAL_OPTIONS.map((o) => [o.name, { type: o.kind }]));

const usage = (message: string, fix: string): Failure => fail(finding("usage.invalid", { message, fix }));

const globalsOf = (values: Record<string, unknown>): Globals => ({
  json: values.json === true,
  yes: values.yes === true,
  noInput: values["no-input"] === true,
  dryRun: values["dry-run"] === true,
  store: typeof values.store === "string" ? values.store : undefined,
  config: typeof values.config === "string" ? values.config : undefined,
  quiet: values.quiet === true,
  verbose: values.verbose === true,
});

/** parseArgs refusals as one plain sentence. */
const parseErrorMessage = (verb: string, error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code;
  const option = /'(-[^']*)'/.exec(text)?.[1];
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && option !== undefined)
    return `${verb} has no option ${option}`;
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" && option !== undefined) {
    return text.includes("argument missing") ? `${option} needs a value` : `${option} takes no value`;
  }
  return `${verb}: ${text.split("\n")[0]}`;
};

/**
 * Rewrites the help and version spellings onto the registered commands: `--help` anywhere (before `--`) is
 * `help <command words>`, and `--version` with no command is `version`.
 */
const aliases = (argv: readonly string[], registry: Registry): string[] => {
  const { tokens } = parseArgs({
    args: [...argv],
    options: { ...globalParseOptions(), help: { type: "boolean" }, version: { type: "boolean" } },
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const end = tokens.find((t) => t.kind === "option-terminator")?.index ?? argv.length;
  const before = tokens.filter((t) => t.index < end);
  const words = before.flatMap((t) => (t.kind === "positional" ? [t.value] : []));
  const flags = before.flatMap((t) => (t.kind === "option" ? [t.name] : []));
  if (flags.includes("help")) {
    const commandWords = words.slice(0, findCommand(registry, words)?.length ?? 1);
    return ["help", ...commandWords, ...(flags.includes("json") ? ["--json"] : [])];
  }
  if (flags.includes("version") && words.length === 0)
    return ["version", ...argv.filter((a) => a !== "--version")];
  if (words.length === 0) return ["help", ...argv];
  return [...argv];
};

/** Finds, parses and gates one invocation. `argv` is everything after `plainport`, exactly as given. */
export const gate = (rawArgv: readonly string[], registry: Registry): Gated => {
  const argv = aliases(rawArgv, registry);
  const scan = parseArgs({
    args: argv,
    options: globalParseOptions(),
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const json = scan.values.json === true;
  const firstWords = scan.tokens.filter(
    (t): t is Extract<typeof t, { kind: "positional" }> => t.kind === "positional",
  );
  const terminator = scan.tokens.find((t) => t.kind === "option-terminator")?.index ?? argv.length;
  const leading = firstWords.filter((t) => t.index < terminator);
  const words = leading.map((t) => t.value);

  const found = findCommand(registry, words);
  if (found === undefined) {
    const suggestion = suggestCommand(registry, words);
    const length = suggestion?.length ?? 1;
    const typed = words.slice(0, length).join(" ");
    const fixed = [...argv];
    if (suggestion !== undefined) {
      const replacement = suggestion.name.split(" ");
      leading.slice(0, length).forEach((t, i) => {
        fixed[t.index] = replacement[i] as string;
      });
    }
    return {
      ok: false,
      verb: typed,
      json,
      failure: fail(
        finding("command.unknown", {
          message: `unknown command: ${typed}${suggestion === undefined ? "" : ` (did you mean ${suggestion.name}?)`}`,
          fix: suggestion === undefined ? "plainport help" : commandLine(fixed),
        }),
      ),
    };
  }

  const { command } = found;
  const verb = command.name;
  const refuse = (failure: Failure): Gated => ({ ok: false, verb, json, failure });
  const helpFix = `plainport help ${command.name}`;
  const commandIndexes = new Set(leading.slice(0, found.length).map((t) => t.index));
  const rest = argv.filter((_, index) => !commandIndexes.has(index));

  const options = optionsOf(command);
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        ...globalParseOptions(),
        ...Object.fromEntries(
          options.map((o) => [
            o.name,
            o.kind === "strings" ? { type: "string" as const, multiple: true } : { type: o.kind },
          ]),
        ),
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    return refuse(usage(parseErrorMessage(verb, error), helpFix));
  }

  const values = parsed.values as Record<string, unknown>;
  const globals = globalsOf(values);
  if (globals.quiet && globals.verbose)
    return refuse(usage("--quiet and --verbose cannot be used together", helpFix));

  const args: Record<string, unknown> = {};
  for (const option of options)
    if (values[option.name] !== undefined) args[option.name] = values[option.name];
  const given = [...parsed.positionals];
  const positionals = positionalsOf(command);
  for (const positional of positionals) {
    if (positional.variadic) {
      if (given.length > 0) args[positional.name] = given.splice(0);
      if (positional.required && args[positional.name] === undefined) {
        return refuse(usage(`${verb} needs at least one <${positional.name}>`, helpFix));
      }
      continue;
    }
    const value = given.shift();
    if (value !== undefined) args[positional.name] = value;
    else if (positional.required) return refuse(usage(`${verb} needs <${positional.name}>`, helpFix));
  }
  if (given.length > 0) {
    return refuse(
      usage(`${verb} takes at most ${positionals.length} argument(s); got ${given.join(" ")}`, helpFix),
    );
  }

  const checked = command.args.safeParse(args);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return refuse(usage(`${verb}: ${where}${issue?.message ?? "invalid arguments"}`, helpFix));
  }

  const verdict = checkInvocation({
    command: verb,
    argv: rawArgv,
    risk: resolveRisk(command, checked.data),
    supportsDryRun: command.dryRun,
    yes: globals.yes,
    plan: typeof checked.data.plan === "string",
    dryRun: globals.dryRun,
  });
  if (!verdict.ok) return refuse(verdict);
  return { ok: true, command, args: checked.data, globals, risk: verdict.value.riskClass };
};
