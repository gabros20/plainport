// The command registry (ADR-0005, ADR-0007, AGENTS.md rule 4): each command is defined once, with its argument
// schema, output schema, risk class, dry-run support and handler. Parsing, the risk gate, help, completions and
// plainport.json all read it; nothing else describes a command.
//
// The argument schema is the single description of a command's arguments: its keys are the positional names
// (listed in order in `positionals`) and the option names, spelled as on the command line (`no-hydrate`). An
// option's kind comes from its Zod type (boolean is a flag, string takes a value, an array of strings repeats),
// its help text from `.meta({ description })`, and a higher risk class than its command's from
// `.meta({ risk: "confirm" })` (machine-contract §4: `onload --adopt`).

import type { PlainportEvent, Result, RiskClass, StreamEvent } from "@plainport/contract";
import { RISK_CLASSES } from "@plainport/contract";
import { z } from "zod";

export interface CommandContext {
  /** --json was given: the renderer prints NDJSON, and a handler must never write to stdout itself. */
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  /** The command may prompt: a TTY and no --no-input. */
  input: boolean;
  dryRun: boolean;
  yes: boolean;
  /** The risk class the gate let it run as: read under --dry-run, else the command's own or an option's. */
  risk: RiskClass;
  store: string | undefined;
  config: string | undefined;
  registry: Registry;
  /** Streams a phase, progress or finding event (an NDJSON line under --json). */
  emit(event: StreamEvent): void;
  /** A log line on stderr; debug only with --verbose, nothing but warnings with --quiet. */
  log(level: Extract<PlainportEvent, { type: "log" }>["level"], message: string): void;
}

export type Example = {
  argv: string[];
  summary: string;
};

export interface CommandDef<A extends z.ZodObject = z.ZodObject, O extends z.ZodType = z.ZodType> {
  /** As typed after `plainport`: one word, or two for a command group (`root add`). */
  name: string;
  summary: string;
  risk: RiskClass;
  /** Whether --dry-run gives a true preview. Without one, --dry-run is refused with exit 2 (D18). */
  dryRun: boolean;
  /** The argument schema's positional keys, in order; an array-typed one takes the rest and must be last. */
  positionals: readonly (keyof z.output<A> & string)[];
  /** Strict: an unknown key is an error (D16). */
  args: A;
  /** What `data` holds in the success envelope; open (D16). */
  output: O;
  /** Invocations that run in tests without side effects; help prints them and the contract test runs them. */
  examples: readonly Example[];
  /** The human rendering of the data, printed to stdout. */
  human(data: z.output<O>): string;
  handler(args: z.output<A>, ctx: CommandContext): Result<z.output<O>> | Promise<Result<z.output<O>>>;
}

// biome-ignore lint/suspicious/noExplicitAny: a registry holds commands of every argument and output type.
export type AnyCommand = CommandDef<any, any>;
export type Registry = readonly AnyCommand[];

export const defineCommand = <A extends z.ZodObject, O extends z.ZodType>(
  def: CommandDef<A, O>,
): AnyCommand => def;

export type OptionKind = "boolean" | "string" | "strings";

export type OptionInfo = {
  name: string;
  kind: OptionKind;
  summary: string;
  required: boolean;
  /** Set only when the option raises the command's risk class. */
  risk?: RiskClass;
};

export type PositionalInfo = {
  name: string;
  summary: string;
  required: boolean;
  variadic: boolean;
};

const unwrap = (schema: z.ZodType): { inner: z.ZodType; optional: boolean } => {
  let inner = schema;
  let optional = false;
  for (;;) {
    if (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault) {
      optional = true;
      inner = inner.def.innerType as z.ZodType;
    } else if (inner instanceof z.ZodNullable) {
      inner = inner.def.innerType as z.ZodType;
    } else {
      return { inner, optional };
    }
  }
};

/** The first metadata value for `key` on the schema or any wrapper inside it. */
const metaOf = (schema: z.ZodType, key: string): unknown => {
  let current: z.ZodType | undefined = schema;
  while (current !== undefined) {
    const value = z.globalRegistry.get(current)?.[key];
    if (value !== undefined) return value;
    const def = current.def as { innerType?: z.ZodType };
    current = def.innerType;
  }
  return undefined;
};

const kindOf = (schema: z.ZodType): OptionKind | undefined => {
  const { inner } = unwrap(schema);
  if (inner instanceof z.ZodBoolean) return "boolean";
  if (inner instanceof z.ZodString || inner instanceof z.ZodEnum) return "string";
  if (inner instanceof z.ZodArray && unwrap(inner.def.element as z.ZodType).inner instanceof z.ZodString) {
    return "strings";
  }
  return undefined;
};

const fields = (command: AnyCommand): [string, z.ZodType][] =>
  Object.entries(command.args.shape as Record<string, z.ZodType>);

export const positionalsOf = (command: AnyCommand): PositionalInfo[] =>
  command.positionals.map((name: string) => {
    const schema = (command.args.shape as Record<string, z.ZodType>)[name] as z.ZodType;
    const { inner, optional } = unwrap(schema);
    const variadic = inner instanceof z.ZodArray;
    return {
      name,
      summary: String(metaOf(schema, "description") ?? ""),
      required: variadic ? !optional && !inner.safeParse([]).success : !optional,
      variadic,
    };
  });

export const optionsOf = (command: AnyCommand): OptionInfo[] => {
  const positional = new Set<string>(command.positionals);
  return fields(command)
    .filter(([name]) => !positional.has(name))
    .map(([name, schema]) => {
      const risk = metaOf(schema, "risk") as RiskClass | undefined;
      return {
        name,
        kind: kindOf(schema) ?? "string",
        summary: String(metaOf(schema, "description") ?? ""),
        required: !unwrap(schema).optional,
        ...(risk === undefined ? {} : { risk }),
      };
    });
};

/** The risk class the arguments call for: the command's own, raised by any option that is set and declares more. */
export const resolveRisk = (command: AnyCommand, args: Record<string, unknown>): RiskClass => {
  let risk: RiskClass = command.risk;
  for (const option of optionsOf(command)) {
    const value = args[option.name];
    const set = value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0);
    if (set && option.risk !== undefined && RISK_CLASSES.indexOf(option.risk) > RISK_CLASSES.indexOf(risk)) {
      risk = option.risk;
    }
  }
  return risk;
};

/** One line of usage: `plainport ship <projects...> [--plan <value>]`. Global options are left out. */
export const usageOf = (command: AnyCommand): string => {
  const parts = ["plainport", command.name];
  for (const p of positionalsOf(command)) {
    const word = `<${p.name}${p.variadic ? "..." : ""}>`;
    parts.push(p.required ? word : `[${word}]`);
  }
  for (const o of optionsOf(command)) {
    const word = o.kind === "boolean" ? `--${o.name}` : `--${o.name} <value>`;
    parts.push(o.required ? word : `[${word}]`);
  }
  return parts.join(" ");
};

/**
 * Registry invariants, checked by tests and before generation: unique names, positionals that exist and come
 * before a variadic one only at the end, option kinds parseArgs can parse, and no clash with a global option.
 */
export const registryProblems = (registry: Registry, globalNames: readonly string[]): string[] => {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const command of registry) {
    if (names.has(command.name)) problems.push(`${command.name}: registered twice`);
    names.add(command.name);
    if (!/^[a-z][a-z-]*( [a-z][a-z-]*)?$/.test(command.name))
      problems.push(`${command.name}: not a command name`);
    const shape = command.args.shape as Record<string, z.ZodType>;
    command.positionals.forEach((name: string, index: number) => {
      if (!(name in shape))
        problems.push(`${command.name}: positional ${name} is not in the argument schema`);
      else if (
        unwrap(shape[name] as z.ZodType).inner instanceof z.ZodArray &&
        index < command.positionals.length - 1
      )
        problems.push(`${command.name}: variadic positional ${name} is not last`);
    });
    for (const [name, schema] of fields(command)) {
      if ((command.positionals as readonly string[]).includes(name)) continue;
      if (kindOf(schema) === undefined)
        problems.push(`${command.name}: option --${name} is not boolean or string`);
      if (globalNames.includes(name))
        problems.push(`${command.name}: option --${name} clashes with a global option`);
    }
  }
  return problems;
};

/** The longest registered name that the leading words spell, and how many words it takes. */
export const findCommand = (
  registry: Registry,
  words: readonly string[],
): { command: AnyCommand; length: number } | undefined => {
  for (const length of [2, 1]) {
    if (words.length < length) continue;
    const name = words.slice(0, length).join(" ");
    const command = registry.find((c) => c.name === name);
    if (command !== undefined) return { command, length };
  }
  return undefined;
};

const distance = (a: string, b: string): number => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j] as number;
      row[j] = Math.min(
        (row[j] as number) + 1,
        (row[j - 1] as number) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[b.length] as number;
};

/** The registered name closest to the leading words, if one is close enough to be a typo, and the words it replaces. */
export const suggestCommand = (
  registry: Registry,
  words: readonly string[],
): { name: string; length: number } | undefined => {
  let best: { name: string; length: number; score: number } | undefined;
  for (const command of registry) {
    const length = command.name.split(" ").length;
    if (words.length < length) continue;
    const typed = words.slice(0, length).join(" ");
    const score = distance(typed, command.name);
    const limit = Math.max(1, Math.floor(command.name.length / 3));
    if (
      score <= limit &&
      (best === undefined || score < best.score || (score === best.score && length > best.length))
    )
      best = { name: command.name, length, score };
  }
  return best === undefined ? undefined : { name: best.name, length: best.length };
};

export type CommandInfo = {
  name: string;
  summary: string;
  usage: string;
  risk: RiskClass;
  dryRun: boolean;
  positionals: PositionalInfo[];
  options: OptionInfo[];
  examples: Example[];
};

/** What help --json and plainport.json say about a command, in that key order. */
export const commandInfo = (command: AnyCommand): CommandInfo => ({
  name: command.name,
  summary: command.summary,
  usage: usageOf(command),
  risk: command.risk,
  dryRun: command.dryRun,
  positionals: positionalsOf(command),
  options: optionsOf(command),
  examples: command.examples.map((e: Example) => ({ argv: [...e.argv], summary: e.summary })),
});
