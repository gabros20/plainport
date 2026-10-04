import { parseArgs } from "node:util";
import { GLOBAL_OPTIONS } from "../../packages/cli/src/gate.ts";

/** Match the CLI's positional scan, including global option values and the terminator. */
export function commandVerb(argv: readonly string[]): string | undefined {
  try {
    const { tokens } = parseArgs({
      args: [...argv],
      options: Object.fromEntries(GLOBAL_OPTIONS.map((option) => [option.name, { type: option.type }])),
      strict: false,
      allowPositionals: true,
      tokens: true,
    });
    const end = tokens.find((token) => token.kind === "option-terminator")?.index ?? argv.length;
    const first = tokens.find((token) => token.kind === "positional" && token.index < end);
    return first?.kind === "positional" ? first.value : undefined;
  } catch {
    return undefined;
  }
}
