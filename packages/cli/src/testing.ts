// Test helpers for the CLI: a fake registry that covers every risk class, a dry-run plan, --plan, option-level
// risk, a repeatable option, a multi-word name, a streaming handler and buggy ones; fake ports that never reach the
// real home folder or a real store; and a runner that captures stdout, stderr and the exit code.
// Used only by *.test.ts files.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@plainport/contract";
import { z } from "zod";
import { help } from "./commands/help.ts";
import { type IO, run } from "./main.ts";
import { type CommandContext, defineCommand, type Ports, type Registry } from "./registry.ts";

export const seen: { name: string; args: unknown; ctx: CommandContext }[] = [];

/** Plan ids the fake plan store treats as approved, as `<command> <id>`. */
export const approvedPlans = new Set<string>();

/** Ports for tests: a home folder that is never created, a fixed clock, and the approvedPlans set. */
export const fakePorts = (): Ports => ({
  host: { home: join(tmpdir(), "plainport-fake-home-never-created") },
  clock: { now: () => new Date("2026-10-03T12:00:00Z") },
  plans: { approved: (command, id) => approvedPlans.has(`${command} ${id}`) },
});

const done = z.looseObject({ done: z.string() });
const human = (data: { done: string }) => `done: ${data.done}`;

export const FAKE_REGISTRY: Registry = [
  help,
  defineCommand({
    name: "show",
    summary: "Read something",
    risk: "read",
    dryRun: false,
    acceptsPlan: false,
    positionals: ["project"],
    args: z.strictObject({ project: z.string().optional().meta({ description: "A project" }) }),
    output: done,
    examples: [{ argv: ["show", "web"], summary: "Show web" }],
    human,
    handler: (args, ctx) => {
      seen.push({ name: "show", args, ctx });
      return ok({ done: `show ${args.project ?? ""}`.trim() });
    },
  }),
  defineCommand({
    name: "write",
    summary: "Write something that can be undone",
    risk: "safe_write",
    dryRun: false,
    acceptsPlan: false,
    positionals: ["project"],
    args: z.strictObject({
      project: z.string().meta({ description: "A project" }),
      adopt: z.boolean().optional().meta({ description: "Adopt what is there", risk: "confirm" }),
      to: z.string().optional().meta({ description: "Where to" }),
    }),
    output: done,
    examples: [{ argv: ["write", "web"], summary: "Write web" }],
    human,
    handler: (args, ctx) => {
      seen.push({ name: "write", args, ctx });
      return ok({ done: `write ${args.project}` });
    },
  }),
  defineCommand({
    name: "ship",
    summary: "Send something off this machine",
    risk: "confirm",
    dryRun: {
      plan: z.looseObject({ plan: z.string() }),
      human: (plan) => `plan: ${plan.plan}`,
    },
    acceptsPlan: true,
    positionals: ["projects"],
    args: z.strictObject({
      projects: z.array(z.string()).min(1).meta({ description: "Projects" }),
      plan: z.string().optional().meta({ description: "An approved plan id" }),
      allow: z.array(z.string()).optional().meta({ description: "Allow a finding" }),
      lie: z.boolean().optional().meta({ description: "Return the other mode's shape" }),
    }),
    output: done,
    examples: [
      { argv: ["ship", "web", "--yes"], summary: "Ship web" },
      { argv: ["ship", "web", "--dry-run"], summary: "Plan shipping web" },
    ],
    human,
    handler: (args, ctx) => {
      seen.push({ name: "ship", args, ctx });
      const planned = ctx.dryRun !== (args.lie === true);
      return planned
        ? ok({ plan: `ship ${args.projects.join(" ")}` })
        : ok({ done: `ship ${args.projects.join(" ")}` });
    },
  }),
  defineCommand({
    name: "root add",
    summary: "Add a root",
    risk: "safe_write",
    dryRun: false,
    acceptsPlan: false,
    positionals: ["key"],
    args: z.strictObject({ key: z.string().meta({ description: "The root's key" }) }),
    output: done,
    examples: [{ argv: ["root", "add", "work"], summary: "Add work" }],
    human,
    handler: (args) => ok({ done: `root add ${args.key}` }),
  }),
  defineCommand({
    name: "stream",
    summary: "Emit events, then finish",
    risk: "read",
    dryRun: false,
    acceptsPlan: false,
    positionals: [],
    args: z.strictObject({}),
    output: done,
    examples: [{ argv: ["stream"], summary: "Stream" }],
    human,
    handler: (_args, ctx) => {
      ctx.output.emit({ type: "phase", op: "01J9", phase: "scan", status: "start" });
      ctx.output.emit({
        type: "finding",
        op: "01J9",
        finding: {
          code: "git.unpushed",
          severity: "warn",
          message: "2 commits are not on origin",
          allowable: true,
        },
      });
      ctx.output.log("info", "scanning");
      ctx.output.log("debug", "deep detail");
      ctx.output.emit({ type: "phase", op: "01J9", phase: "scan", status: "end" });
      return ok({ done: "stream" });
    },
  }),
  defineCommand({
    name: "boom",
    summary: "A handler with a bug",
    risk: "read",
    dryRun: false,
    acceptsPlan: false,
    positionals: [],
    args: z.strictObject({}),
    output: done,
    examples: [],
    human,
    handler: (_args, ctx) => {
      ctx.output.emit({ type: "phase", op: "01J9", phase: "scan", status: "start" });
      throw new Error("kaboom");
    },
  }),
  defineCommand({
    name: "fragile",
    summary: "An argument schema with a bug",
    risk: "read",
    dryRun: false,
    acceptsPlan: false,
    positionals: ["word"],
    args: z.strictObject({
      word: z.string().transform((): string => {
        throw new Error("transform bug");
      }),
    }),
    output: done,
    examples: [],
    human,
    handler: () => ok({ done: "fragile" }),
  }),
];

export interface Captured {
  code: number;
  out: string;
  err: string;
}

/** Runs the CLI in process against `registry` and captures what it prints. No TTY unless asked. */
export const capture = async (
  argv: string[],
  registry: Registry = FAKE_REGISTRY,
  options: { isTTY?: boolean; stdout?: (text: string) => void } = {},
): Promise<Captured> => {
  let out = "";
  let err = "";
  const io: IO = {
    stdout:
      options.stdout ??
      ((text) => {
        out += text;
      }),
    stderr: (text) => {
      err += text;
    },
    isTTY: options.isTTY ?? false,
  };
  const code = await run(argv, io, fakePorts(), registry);
  return { code, out, err };
};
