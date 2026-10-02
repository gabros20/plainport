// Test helpers for the CLI: a fake registry that covers every risk class, dry-run support, option-level risk, a
// multi-word name, a streaming handler and a buggy one, and a runner that captures stdout, stderr and the exit code.
// Used only by *.test.ts files.

import { ok } from "@plainport/contract";
import { z } from "zod";
import { help } from "./commands/help.ts";
import { type IO, run } from "./main.ts";
import { type CommandContext, defineCommand, type Registry } from "./registry.ts";

export const seen: { name: string; args: unknown; ctx: CommandContext }[] = [];

const done = z.looseObject({ done: z.string() });
const human = (data: { done: string }) => `done: ${data.done}`;

export const FAKE_REGISTRY: Registry = [
  help,
  defineCommand({
    name: "show",
    summary: "Read something",
    risk: "read",
    dryRun: false,
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
    dryRun: true,
    positionals: ["projects"],
    args: z.strictObject({
      projects: z.array(z.string()).min(1).meta({ description: "Projects" }),
      plan: z.string().optional().meta({ description: "An approved plan id" }),
    }),
    output: done,
    examples: [{ argv: ["ship", "web", "--yes"], summary: "Ship web" }],
    human,
    handler: (args, ctx) => {
      seen.push({ name: "ship", args, ctx });
      return ok({ done: `ship ${args.projects.join(" ")}${ctx.dryRun ? " (dry run)" : ""}` });
    },
  }),
  defineCommand({
    name: "root add",
    summary: "Add a root",
    risk: "safe_write",
    dryRun: false,
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
    positionals: [],
    args: z.strictObject({}),
    output: done,
    examples: [{ argv: ["stream"], summary: "Stream" }],
    human,
    handler: (_args, ctx) => {
      ctx.emit({ type: "phase", op: "01J9", phase: "scan", status: "start" });
      ctx.emit({
        type: "finding",
        op: "01J9",
        finding: {
          code: "git.unpushed",
          severity: "warn",
          message: "2 commits are not on origin",
          allowable: true,
        },
      });
      ctx.log("info", "scanning");
      ctx.log("debug", "deep detail");
      ctx.emit({ type: "phase", op: "01J9", phase: "scan", status: "end" });
      return ok({ done: "stream" });
    },
  }),
  defineCommand({
    name: "boom",
    summary: "A handler with a bug",
    risk: "read",
    dryRun: false,
    positionals: [],
    args: z.strictObject({}),
    output: done,
    examples: [],
    human,
    handler: (_args, ctx) => {
      ctx.emit({ type: "phase", op: "01J9", phase: "scan", status: "start" });
      throw new Error("kaboom");
    },
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
  options: { isTTY?: boolean } = {},
): Promise<Captured> => {
  let out = "";
  let err = "";
  const io: IO = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    isTTY: options.isTTY ?? false,
  };
  const code = await run(argv, io, registry);
  return { code, out, err };
};
