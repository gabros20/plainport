import { describe, expect, test } from "bun:test";
import { ok } from "@plainport/contract";
import { z } from "zod";
import { REGISTRY } from "./commands/index.ts";
import { GLOBAL_OPTIONS } from "./gate.ts";
import {
  type AnyCommand,
  defineCommand,
  optionsOf,
  type Registry,
  registryProblems,
  resolveRisk,
} from "./registry.ts";
import { FAKE_REGISTRY } from "./testing.ts";

const globals = GLOBAL_OPTIONS.map((o) => o.name);

const cmd = (over: Record<string, unknown> = {}): AnyCommand =>
  defineCommand({
    name: "x",
    summary: "s",
    risk: "read",
    dryRun: false,
    acceptsPlan: false,
    group: "setup",
    positionals: [],
    args: z.strictObject({}),
    output: z.looseObject({}),
    examples: [],
    human: () => "",
    handler: () => ok({}),
    ...over,
  } as Parameters<typeof defineCommand>[0]);

const problems = (registry: Registry) => registryProblems(registry, globals);

describe("registryProblems: the rules every later command must pass", () => {
  test("the real and the fake registry pass", () => {
    expect(problems(REGISTRY)).toEqual([]);
    expect(problems(FAKE_REGISTRY)).toEqual([]);
  });

  const cases: [string, Registry, string][] = [
    ["a name registered twice", [cmd(), cmd()], "x: registered twice"],
    ["a bad name", [cmd({ name: "Root add now" })], "Root add now: not a command name"],
    [
      "a positional missing from the schema",
      [cmd({ positionals: ["nope"] })],
      "positional nope is not in the argument schema",
    ],
    [
      "a variadic positional that is not last",
      [
        cmd({
          positionals: ["a", "b"],
          args: z.strictObject({ a: z.array(z.string()), b: z.string() }),
        }),
      ],
      "variadic positional a is not last",
    ],
    [
      "an option type parseArgs cannot parse",
      [cmd({ args: z.strictObject({ n: z.number().optional() }) })],
      "option --n is not boolean, string or repeatable string",
    ],
    [
      "an option that clashes with a global option",
      [cmd({ args: z.strictObject({ json: z.boolean().optional() }) })],
      "option --json clashes with a global option",
    ],
    [
      "an option named help or version",
      [cmd({ args: z.strictObject({ help: z.boolean().optional() }) })],
      "option --help clashes with a global option",
    ],
    [
      "a misspelt option risk (I7)",
      [
        cmd({
          args: z.strictObject({
            adopt: z
              .boolean()
              .optional()
              .meta({ risk: "confrim" as "confirm" }),
          }),
        }),
      ],
      "option --adopt declares risk confrim, which is not read, safe_write or confirm",
    ],
    [
      "an option risk that does not raise the command's",
      [
        cmd({
          risk: "confirm",
          args: z.strictObject({ adopt: z.boolean().optional().meta({ risk: "safe_write" }) }),
        }),
      ],
      "option --adopt declares risk safe_write, which does not raise the command's confirm",
    ],
    [
      "an argument schema that is not strict (D16)",
      [cmd({ args: z.object({}) })],
      "argument schema is not strict",
    ],
    [
      "an output schema that is not open (D16)",
      [cmd({ output: z.looseObject({ inner: z.strictObject({ a: z.string() }) }) })],
      "output schema is not open",
    ],
    [
      "a plan schema that is not open (D16)",
      [cmd({ dryRun: { plan: z.strictObject({}), human: () => "" } })],
      "plan schema is not open",
    ],
    [
      "accepting --plan without a plan option (I5)",
      [cmd({ risk: "confirm", acceptsPlan: true })],
      "accepts --plan but has no string option named plan",
    ],
    [
      "a plan option without accepting --plan (I5)",
      [cmd({ args: z.strictObject({ plan: z.string().optional() }) })],
      "has an option named plan but does not declare acceptsPlan",
    ],
  ];
  for (const [label, registry, expected] of cases) {
    test(`refuses ${label}`, () => {
      expect(problems(registry).join("\n")).toContain(expected);
    });
  }
});

describe("options and risk", () => {
  test("options are described in D19's shape: name, type, multiple, summary, risk when it raises", () => {
    const command = cmd({
      risk: "safe_write",
      args: z.strictObject({
        adopt: z.boolean().optional().meta({ description: "Adopt", risk: "confirm" }),
        to: z.string().optional().meta({ description: "Where" }),
        allow: z.array(z.string()).optional().meta({ description: "Allow" }),
      }),
    });
    expect(optionsOf(command)).toEqual([
      { name: "adopt", type: "boolean", multiple: false, summary: "Adopt", risk: "confirm" },
      { name: "to", type: "string", multiple: false, summary: "Where" },
      { name: "allow", type: "string", multiple: true, summary: "Allow" },
    ]);
  });

  test("a repeatable option raises the risk only when given at least once", () => {
    const command = cmd({
      args: z.strictObject({ allow: z.array(z.string()).optional().meta({ risk: "confirm" }) }),
    });
    expect(resolveRisk(command, {})).toBe("read");
    expect(resolveRisk(command, { allow: [] })).toBe("read");
    expect(resolveRisk(command, { allow: ["git.unpushed"] })).toBe("confirm");
  });
});
