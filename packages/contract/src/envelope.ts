// The --json envelope (ADR-0007, docs/machine-contract.md §1). Shape adapted from plainkeep's ops_json
// envelope, gabros20/plainkeep@d7eb27e docs/machine-contract.md §1, with plainport_json in place of ops_json.

import { z } from "zod";
import { type StreamEvent, StreamEventSchema } from "./events.ts";
import { EXIT, type ExitCode, type FailureExitCode, FailureExitCodeSchema } from "./exit-codes.ts";
import { finding } from "./finding.ts";
import { outputObject } from "./objects.ts";
import { fail, ok, type Result } from "./result.ts";

export const PLAINPORT_JSON = 1;

const verb = z.string().min(1).meta({ description: "The command as registered, e.g. offload or root add" });

/** Failures after which part of the work stands (D14): 8, the kept snapshot of a conflict; 10, a restore not hydrated. */
export const PARTIAL_EXIT_CODES = [EXIT.conflict, EXIT.unhydrated] as const;
export type PartialExitCode = (typeof PARTIAL_EXIT_CODES)[number];

const errorObject = <C extends z.ZodType>(code: C) =>
  outputObject({
    code: code.meta({ description: "Equal to the process exit code" }),
    message: z.string().min(1),
    hint: z.string().min(1).optional(),
  });

export const ErrorObjectSchema = errorObject(FailureExitCodeSchema);
const absent = z.never().optional();

/** The final envelope for a command whose data matches `data` (any JSON value by default). A failure carries data
 * only when part of the work stands (D14): exit 8 or 10. */
export const envelopeSchema = <D extends z.ZodType>(data: D) =>
  z.union([
    outputObject({
      plainport_json: z.literal(PLAINPORT_JSON),
      ok: z.literal(true),
      verb,
      data,
      error: absent,
    }),
    outputObject({
      plainport_json: z.literal(PLAINPORT_JSON),
      ok: z.literal(false),
      verb,
      error: ErrorObjectSchema,
      data: absent,
    }),
    outputObject({
      plainport_json: z.literal(PLAINPORT_JSON),
      ok: z.literal(false),
      verb,
      error: errorObject(z.literal(PARTIAL_EXIT_CODES)),
      data,
    }),
  ]);

export const EnvelopeSchema = envelopeSchema(z.json()).meta({ title: "Envelope" });
export type Envelope<D = z.infer<ReturnType<typeof z.json>>> =
  | { plainport_json: 1; ok: true; verb: string; data: D }
  | { plainport_json: 1; ok: false; verb: string; error: z.infer<typeof ErrorObjectSchema>; data?: D };

export const successEnvelope = <D>(verbName: string, data: D): Envelope<D> => ({
  plainport_json: PLAINPORT_JSON,
  ok: true,
  verb: verbName,
  data,
});

/** A failure envelope. `data` is accepted only with exit 8 or 10, a partial success (D14). */
export const errorEnvelope = <C extends FailureExitCode, D = never>(
  verbName: string,
  code: C,
  message: string,
  extra: { hint?: string; data?: C extends PartialExitCode ? D : never } = {},
): Envelope<D> => ({
  plainport_json: PLAINPORT_JSON,
  ok: false,
  verb: verbName,
  error: extra.hint === undefined ? { code, message } : { code, message, hint: extra.hint },
  ...(extra.data === undefined ? {} : { data: extra.data }),
});

/** The process exit code an envelope stands for: 0 on success, error.code otherwise. */
export const exitCodeOf = (envelope: Envelope<unknown>): ExitCode => (envelope.ok ? 0 : envelope.error.code);

const invalid = (message: string) => fail(finding("contract.invalid", { message }));

/**
 * Parses a --json stdout stream: zero or more event lines, then exactly one final envelope, each line one JSON
 * object, newline-terminated or not. Never throws; any break of the rule is a contract.invalid failure.
 */
export const parseJsonLines = <D extends z.ZodType = ReturnType<typeof z.json>>(
  text: string,
  data?: D,
): Result<{ events: StreamEvent[]; envelope: Envelope<z.output<D>> }> => {
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  const schema = envelopeSchema(data ?? z.json());
  const events: StreamEvent[] = [];
  for (const [index, line] of lines.entries()) {
    const at = `line ${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return invalid(`${at} is not JSON`);
    }
    const last = index === lines.length - 1;
    if (!last) {
      const event = StreamEventSchema.safeParse(value);
      if (!event.success) return invalid(`${at} is not an event line: ${z.prettifyError(event.error)}`);
      events.push(event.data);
      continue;
    }
    const envelope = schema.safeParse(value);
    if (!envelope.success)
      return invalid(`${at} is not the final envelope: ${z.prettifyError(envelope.error)}`);
    return ok({ events, envelope: envelope.data as Envelope<z.output<D>> });
  }
  return invalid("the stream is empty");
};
