// plainport help [command…]: the command list, or one command in full, generated from the registry (AGENTS.md
// rule 4). `plainport --help`, `plainport <command> --help` and a bare `plainport` are the same command.

import { commandLine, fail, finding, ok, RiskClassSchema } from "@plainport/contract";
import { z } from "zod";
import { GLOBAL_OPTIONS } from "../gate.ts";
import { type CommandInfo, commandInfo, defineCommand, findCommand, suggestCommand } from "../registry.ts";
import { VERSION } from "../version.ts";

const InfoSchema = z.looseObject({
  name: z.string(),
  summary: z.string(),
  usage: z.string(),
  risk: RiskClassSchema,
  dryRun: z.boolean(),
  positionals: z.array(
    z.looseObject({ name: z.string(), summary: z.string(), required: z.boolean(), variadic: z.boolean() }),
  ),
  options: z.array(
    z.looseObject({
      name: z.string(),
      type: z.enum(["boolean", "string"]),
      multiple: z.boolean(),
      summary: z.string(),
      risk: RiskClassSchema.optional(),
    }),
  ),
  examples: z.array(z.looseObject({ argv: z.array(z.string()), summary: z.string() })),
});

/** How help names a global option's value. */
const VALUE_NAMES: Record<string, string> = { store: "name", config: "path" };

const table = (rows: [string, string][]): string[] => {
  const width = Math.max(0, ...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`.trimEnd());
};

const globalRows = (): [string, string][] =>
  GLOBAL_OPTIONS.map((o) => [
    o.type === "string" ? `--${o.name} <${VALUE_NAMES[o.name] ?? "value"}>` : `--${o.name}`,
    o.summary,
  ]);

/** How the human listing groups the commands, in order; a command no group names is listed under Other. */
const GROUPS: readonly [string, (name: string) => boolean][] = [
  [
    "Projects",
    (name) => ["ls", "status", "offload", "onload", "hydrate", "dehydrate", "restore"].includes(name),
  ],
  ["Recovery and cleanup", (name) => name === "recover" || name === "gc"],
  ["Roots", (name) => name.startsWith("root ")],
  ["Setup and info", (name) => ["init", "help", "version"].includes(name)],
];

/** The human overview: the commands by group with their risk class, then where the full detail is. */
const listing = (commands: CommandInfo[]): string => {
  const rows = table(commands.map((c) => [c.name, `${c.risk.padEnd(10)}  ${c.summary}`]));
  const grouped = new Set<number>();
  const section = (title: string, fits: (name: string) => boolean): string[] => {
    const lines = commands.flatMap((c, i) => {
      if (grouped.has(i) || !fits(c.name)) return [];
      grouped.add(i);
      return [rows[i] as string];
    });
    return lines.length === 0 ? [] : ["", `${title}:`, ...lines];
  };
  return [
    `plainport ${VERSION}: offload, onload and move coding projects`,
    "",
    "Usage: plainport <command> [options]",
    ...GROUPS.flatMap(([title, fits]) => section(title, fits)),
    ...section("Other", () => true),
    "",
    "Global options:",
    ...table(globalRows()),
    "",
    "read and safe_write commands run freely; confirm commands need --yes, or --plan <id> with the id their --dry-run",
    "printed. --dry-run always runs as read.",
    "Run plainport help <command> for a command's arguments, options and examples.",
    "For scripts and agents: add --json to any command for NDJSON with one final envelope; plainport help --json lists",
    "the commands as data; plainport.json, generated from the same registry, is the full machine contract (every",
    "schema, exit code and finding) and is large: read it as data, not as help.",
  ].join("\n");
};

const detail = (c: CommandInfo): string => {
  const lines = [
    `plainport ${c.name}: ${c.summary}`,
    "",
    `Usage: ${c.usage}`,
    `Risk: ${c.risk}${c.risk === "confirm" ? ` (needs --yes${c.options.some((o) => o.name === "plan") ? ", or --plan <id> from a --dry-run" : ""})` : ""} · --dry-run: ${c.dryRun ? "previews without changing anything" : "not supported"}`,
  ];
  if (c.positionals.length > 0) {
    lines.push("", "Arguments:");
    lines.push(...table(c.positionals.map((p) => [`<${p.name}${p.variadic ? "..." : ""}>`, p.summary])));
  }
  if (c.options.length > 0) {
    lines.push("", "Options:");
    lines.push(
      ...table(
        c.options.map((o) => [
          o.type === "boolean" ? `--${o.name}` : `--${o.name} <value>${o.multiple ? "..." : ""}`,
          o.risk === undefined ? o.summary : `${o.summary} (${o.risk})`,
        ]),
      ),
    );
  }
  if (c.examples.length > 0) {
    lines.push("", "Examples:");
    lines.push(...table(c.examples.map((e) => [commandLine(e.argv), e.summary])));
  }
  lines.push("", "Global options: plainport help");
  return lines.join("\n");
};

export const help = defineCommand({
  name: "help",
  summary: "Show every command, or one command's arguments, options and risk class",
  risk: "read",
  dryRun: false,
  acceptsPlan: false,
  positionals: ["command"],
  args: z.strictObject({
    command: z.array(z.string()).optional().meta({ description: "A command, e.g. version or root add" }),
  }),
  output: z.looseObject({
    topic: z.string().optional().meta({ description: "The command asked about; absent for the full list" }),
    commands: z.array(InfoSchema),
  }),
  examples: [
    { argv: ["help"], summary: "List every command" },
    { argv: ["help", "version"], summary: "Show one command" },
  ],
  human: (data) => {
    const [one] = data.commands;
    return data.topic !== undefined && one !== undefined ? detail(one) : listing(data.commands);
  },
  handler: (args, ctx) => {
    const words = args.command ?? [];
    if (words.length === 0) return ok({ commands: ctx.registry.map(commandInfo) });
    const found = findCommand(ctx.registry, words);
    if (found === undefined || found.length !== words.length) {
      const suggestion = suggestCommand(ctx.registry, words);
      const typed = words.join(" ");
      return fail(
        finding("command.unknown", {
          message: `unknown command: ${typed}${suggestion === undefined ? "" : ` (did you mean ${suggestion.name}?)`}`,
          fix: suggestion === undefined ? "plainport help" : `plainport help ${suggestion.name}`,
        }),
      );
    }
    return ok({ topic: found.command.name, commands: [commandInfo(found.command)] });
  },
});
