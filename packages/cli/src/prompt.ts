// The prompt port: how a command asks a person something. Only `plainport init` asks, and only when stdin is a TTY
// and --no-input is not given (ctx.input); without one it never prompts. The real prompter draws with
// @clack/prompts on stderr, so stdout stays the command's result (or NDJSON under --json). Tests inject a scripted
// prompter instead of a terminal.

import { isCancel, multiselect, text } from "@clack/prompts";

export interface Choice {
  value: string;
  label: string;
  hint?: string;
}

export interface Prompter {
  /** The values picked, or undefined if the person cancelled. */
  multiselect(request: { message: string; options: Choice[] }): Promise<string[] | undefined>;
  /** The answer, or undefined if the person cancelled. `validate` returns a problem to show, or undefined. */
  text(request: {
    message: string;
    initial?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string | undefined>;
}

export const clackPrompter: Prompter = {
  multiselect: async ({ message, options }) => {
    const picked = await multiselect({ message, options, required: false, output: process.stderr });
    return isCancel(picked) ? undefined : picked;
  },
  text: async ({ message, initial, validate }) => {
    const answer = await text({
      message,
      ...(initial !== undefined && { initialValue: initial }),
      ...(validate !== undefined && { validate: (value: string | undefined) => validate(value ?? "") }),
      output: process.stderr,
    });
    return isCancel(answer) ? undefined : answer;
  },
};
