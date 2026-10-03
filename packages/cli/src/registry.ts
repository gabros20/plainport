// The command registry (ADR-0005, ADR-0007, AGENTS.md rule 4): each command is defined once, with its argument
// schema, output schema, risk class, dry-run plan schema and handler. Parsing, the risk gate, help, completions and
// plainport.json all read it; nothing else describes a command.
//
// The argument schema is the single description of a command's arguments: its keys are the positional names
// (listed in order in `positionals`) and the option names, spelled as on the command line (`no-hydrate`). An
// option's type comes from its Zod type (boolean is a flag, string takes a value, an array of strings repeats),
// its help text from `.meta({ description })`, and a higher risk class than its command's from
// `.meta({ risk: "confirm" })` (machine-contract §4: `onload --adopt`).

import type { PlainportEvent, Result, RiskClass, StreamEvent } from "@plainport/contract";
import { RISK_CLASSES } from "@plainport/contract";
import type { EcosystemPlugin, Env, HostChecks, HostPorts, LocalIo, PlainportPaths } from "@plainport/core";
import { z } from "zod";
import type { Prompter } from "./prompt.ts";

declare module "zod" {
  interface GlobalMeta {
    /** An option that raises its command's risk class when given (machine-contract §4). */
    risk?: RiskClass;
  }
}

/** The host: file system, processes and the home folder. A placeholder until Task 7 builds the host port. */
export interface HostPort {
  /** The user's home folder; tests pass one that is never the real home. */
  readonly home: string;
}

export interface Clock {
  now(): Date;
}

/**
 * Approved plans (`--plan <id>`): the fresh plans saved on this device, loaded before the gate runs (plans.ts).
 * Whether the folder still matches the plan is checked when it runs (exit 6).
 */
export interface PlanStore {
  approved(command: string, id: string): boolean;
}

/** Every side effect a command may have goes through a port (AGENTS.md rule 5); run() takes them, tests pass fakes. */
export interface Ports {
  host: HostPort;
  clock: Clock;
  plans: PlanStore;
  /** The file system and process calls core makes (run decision D21). */
  io: LocalIo;
  /** The environment plainport's paths and settings come from: HOME, XDG_*, PLAINPORT_*. Tests sandbox it. */
  env: Env;
  /** What relative paths on the command line mean. */
  cwd: string;
  /** Asks a person; used only when ctx.input is true. */
  prompt: Prompter;
  /** The host port: file system, the one process runner, the clock (Task 7). */
  system: HostPorts;
  /** What only the platform can answer in preflight: processes, placeholders, containers. */
  checks: HostChecks;
  /** The ecosystem plugins, in detection order. */
  plugins: readonly EcosystemPlugin[];
}

/** The --config path; loading the file arrives with the config task. */
export interface ConfigRef {
  readonly path: string | undefined;
}

/** Where a handler's events and logs go; the renderer decides how they print. */
export interface OutputPort {
  /** Streams a phase, progress or finding event (an NDJSON line under --json). */
  emit(event: StreamEvent): void;
  /** A log line on stderr; debug only with --verbose, nothing but warnings with --quiet. */
  log(level: Extract<PlainportEvent, { type: "log" }>["level"], message: string): void;
}

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
  registry: Registry;
  host: HostPort;
  clock: Clock;
  config: ConfigRef;
  output: OutputPort;
  io: LocalIo;
  env: Env;
  cwd: string;
  prompt: Prompter;
  system: HostPorts;
  checks: HostChecks;
  plugins: readonly EcosystemPlugin[];
  /** plainport's config and state paths, from env and --config; config.no-home when HOME is unusable. */
  paths(): Result<PlainportPaths>;
}

export type Example = {
  argv: string[];
  summary: string;
};

/** A command's dry run: the plan it returns as `data` (machine-contract §6), and how a person reads it. */
export interface DryRun<P extends z.ZodType> {
  plan: P;
  human(plan: z.output<P>): string;
}

export interface CommandDef<
  A extends z.ZodObject = z.ZodObject,
  O extends z.ZodType = z.ZodType,
  P extends z.ZodType = z.ZodNever,
> {
  /** As typed after `plainport`: one word, or two for a command group (`root add`). */
  name: string;
  summary: string;
  risk: RiskClass;
  /** The plan a --dry-run returns, or false: then --dry-run is refused with exit 2 (D18). */
  dryRun: false | DryRun<P>;
  /** The command takes `--plan <id>`: an approved plan stands in for --yes. The args need a string `plan` option. */
  acceptsPlan: boolean;
  /** The argument schema's positional keys, in order; an array-typed one takes the rest and must be last. */
  positionals: readonly (keyof z.output<A> & string)[];
  /** Strict: an unknown key is an error (D16). */
  args: A;
  /** What `data` holds in the success envelope of a real run; open (D16). */
  output: O;
  /** Invocations the contract test runs against fake ports; help prints them. */
  examples: readonly Example[];
  /** The human rendering of a real run's data, printed to stdout. */
  human(data: z.output<O>): string;
  /** Returns the plan under --dry-run (ctx.dryRun), the output otherwise; run() checks each against its schema. */
  handler(
    args: z.output<A>,
    ctx: CommandContext,
  ): Result<z.output<O> | z.output<P>> | Promise<Result<z.output<O> | z.output<P>>>;
}

// biome-ignore lint/suspicious/noExplicitAny: a registry holds commands of every argument and output type.
export type AnyCommand = CommandDef<any, any, any>;
export type Registry = readonly AnyCommand[];

export const defineCommand = <A extends z.ZodObject, O extends z.ZodType, P extends z.ZodType = z.ZodNever>(
  def: CommandDef<A, O, P>,
): AnyCommand => def;

/** An option as plainport.json and help --json publish it (D19). */
export type OptionInfo = {
  name: string;
  type: "boolean" | "string";
  multiple: boolean;
  summary: string;
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

/** How parseArgs reads an option, from its Zod type; undefined for a type it cannot parse. */
export const parseTypeOf = (schema: z.ZodType): Pick<OptionInfo, "type" | "multiple"> | undefined => {
  const { inner } = unwrap(schema);
  if (inner instanceof z.ZodBoolean) return { type: "boolean", multiple: false };
  if (inner instanceof z.ZodString || inner instanceof z.ZodEnum) return { type: "string", multiple: false };
  const element = inner instanceof z.ZodArray ? unwrap(inner.def.element as z.ZodType).inner : undefined;
  if (element instanceof z.ZodString || element instanceof z.ZodEnum)
    return { type: "string", multiple: true };
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
        ...(parseTypeOf(schema) ?? { type: "string", multiple: false }),
        summary: String(metaOf(schema, "description") ?? ""),
        ...(risk === undefined ? {} : { risk }),
      };
    });
};

const isRequired = (command: AnyCommand, name: string): boolean =>
  !unwrap((command.args.shape as Record<string, z.ZodType>)[name] as z.ZodType).optional;

const rank = (risk: RiskClass): number => RISK_CLASSES.indexOf(risk);

/** The risk class the arguments call for: the command's own, raised by any option that is set and declares more. */
export const resolveRisk = (command: AnyCommand, args: Record<string, unknown>): RiskClass => {
  let risk: RiskClass = command.risk;
  for (const option of optionsOf(command)) {
    const value = args[option.name];
    const set = value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0);
    if (set && option.risk !== undefined && rank(option.risk) > rank(risk)) {
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
    const word = o.type === "boolean" ? `--${o.name}` : `--${o.name} <value>${o.multiple ? "..." : ""}`;
    parts.push(isRequired(command, o.name) ? word : `[${word}]`);
  }
  return parts.join(" ");
};

/** Whether any object in the JSON Schema is closed (`additionalProperties: false`), which output must never be (D16). */
const closedSomewhere = (node: unknown): boolean => {
  if (node === null || typeof node !== "object") return false;
  if ((node as Record<string, unknown>).additionalProperties === false) return true;
  return Object.values(node as Record<string, unknown>).some(closedSomewhere);
};

const isOpen = (schema: z.ZodType): boolean =>
  !closedSomewhere(z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }));

/**
 * Registry invariants, checked by tests and before generation: unique names; positionals that exist, with a
 * variadic one only last; option types parseArgs can parse; no clash with a global or reserved option; option risk
 * classes that are real and raise the command's; strict arguments and open outputs and plans (D16); and --plan
 * declared exactly when the command accepts a plan.
 */
export const registryProblems = (registry: Registry, globalNames: readonly string[]): string[] => {
  const problems: string[] = [];
  const reserved = [...globalNames, "help", "version"];
  const names = new Set<string>();
  for (const command of registry) {
    const say = (problem: string) => problems.push(`${command.name}: ${problem}`);
    if (names.has(command.name)) say("registered twice");
    names.add(command.name);
    if (!/^[a-z][a-z-]*( [a-z][a-z-]*)?$/.test(command.name)) say("not a command name");
    const shape = command.args.shape as Record<string, z.ZodType>;
    command.positionals.forEach((name: string, index: number) => {
      if (!(name in shape)) say(`positional ${name} is not in the argument schema`);
      else if (
        unwrap(shape[name] as z.ZodType).inner instanceof z.ZodArray &&
        index < command.positionals.length - 1
      )
        say(`variadic positional ${name} is not last`);
    });
    for (const [name, schema] of fields(command)) {
      if ((command.positionals as readonly string[]).includes(name)) continue;
      if (parseTypeOf(schema) === undefined)
        say(`option --${name} is not boolean, string or repeatable string`);
      if (reserved.includes(name)) say(`option --${name} clashes with a global option`);
      const risk = metaOf(schema, "risk");
      if (risk === undefined) continue;
      if (!(RISK_CLASSES as readonly unknown[]).includes(risk)) {
        say(
          `option --${name} declares risk ${String(risk)}, which is not ${RISK_CLASSES.slice(0, -1).join(", ")} or ${RISK_CLASSES.at(-1)}`,
        );
      } else if (rank(risk as RiskClass) <= rank(command.risk)) {
        say(
          `option --${name} declares risk ${String(risk)}, which does not raise the command's ${command.risk}`,
        );
      }
    }
    if (!(command.args.def.catchall instanceof z.ZodNever))
      say("argument schema is not strict (use z.strictObject, D16)");
    if (!isOpen(command.output)) say("output schema is not open (use z.looseObject, D16)");
    if (command.dryRun !== false && !isOpen(command.dryRun.plan))
      say("plan schema is not open (use z.looseObject, D16)");
    const planOption = shape.plan === undefined ? undefined : parseTypeOf(shape.plan);
    if (command.acceptsPlan && (planOption?.type !== "string" || planOption.multiple))
      say("accepts --plan but has no string option named plan");
    if (!command.acceptsPlan && "plan" in shape)
      say("has an option named plan but does not declare acceptsPlan");
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
  dryRun: command.dryRun !== false,
  positionals: positionalsOf(command),
  options: optionsOf(command),
  examples: command.examples.map((e: Example) => ({ argv: [...e.argv], summary: e.summary })),
});
