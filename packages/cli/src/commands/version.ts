// plainport version: the version baked into the binary (ADR-0020). `plainport --version` is the same command.

import { ok } from "@plainport/contract";
import { z } from "zod";
import { defineCommand } from "../registry.ts";
import { VERSION } from "../version.ts";

export const version = defineCommand({
  name: "version",
  summary: "Print plainport's version",
  risk: "read",
  dryRun: false,
  acceptsPlan: false,
  group: "setup",
  positionals: [],
  args: z.strictObject({}),
  output: z.looseObject({ version: z.string().min(1) }),
  examples: [{ argv: ["version"], summary: "Print the version" }],
  human: (data) => `plainport ${data.version}`,
  handler: () => ok({ version: VERSION }),
});
