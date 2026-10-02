// The --json envelope (ADR-0007, docs/machine-contract.md §1). Shape adapted from plainkeep's ops_json
// envelope, gabros20/plainkeep@d7eb27e docs/machine-contract.md §1, with plainport_json in place of ops_json.

import { z } from "zod";
import { type StreamEvent, StreamEventSchema, type UnknownEvent, UnknownEventSchema } from "./events.ts";
import { EXIT, type ExitCode, type FailureExitCode, FailureExitCodeSchema } from "./exit-codes.ts";
import { type Finding, FindingSchema, finding } from "./finding.ts";
import { outputObject } from "./objects.ts";
import { decode, fail, ok, type Result } from "./result.ts";

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
    finding: FindingSchema.optional().meta({
      description: "The finding behind the failure, so a reader can branch on its code",
    }),
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
  | { plainport_json: 1; ok: false; verb: string; error: z.infer<typeof ErrorObjectSchema>; data?: undefined }
  | {
      plainport_json: 1;
      ok: false;
      verb: string;
      error: z.infer<typeof ErrorObjectSchema> & { code: PartialExitCode };
      data: D;
    };

export const successEnvelope = <D>(verbName: string, data: D): Envelope<D> => ({
  plainport_json: PLAINPORT_JSON,
  ok: true,
  verb: verbName,
  data,
});

const isPartial = (code: FailureExitCode): code is PartialExitCode =>
  (PARTIAL_EXIT_CODES as readonly number[]).includes(code);

/**
 * A failure envelope. `data` is accepted only with exit 8 or 10, a partial success (D14): the types refuse it for
 * any other code, and a caller that gets past them with a non-literal code is a bug, so it throws.
 */
export const errorEnvelope = <C extends FailureExitCode, D = never>(
  verbName: string,
  code: C,
  message: string,
  extra: { hint?: string; finding?: Finding; data?: [C] extends [PartialExitCode] ? D : never } = {},
): Envelope<D> => {
  const error = {
    code,
    message,
    ...(extra.hint === undefined ? {} : { hint: extra.hint }),
    ...(extra.finding === undefined ? {} : { finding: extra.finding }),
  };
  if (extra.data === undefined) return { plainport_json: PLAINPORT_JSON, ok: false, verb: verbName, error };
  if (!isPartial(code)) throw new TypeError(`exit ${code} cannot carry data; only 8 and 10 can (D14)`);
  return {
    plainport_json: PLAINPORT_JSON,
    ok: false,
    verb: verbName,
    error: { ...error, code },
    data: extra.data,
  };
};

/** The process exit code an envelope stands for: 0 on success, error.code otherwise. */
export const exitCodeOf = (envelope: Envelope<unknown>): ExitCode => (envelope.ok ? 0 : envelope.error.code);

const invalid = (message: string) => fail(finding("contract.invalid", { message }));

/**
 * Parses a --json stdout stream: zero or more event lines, then exactly one final envelope, each line one JSON
 * object, newline-terminated or not. An event line of a type this version does not know is collected in
 * unknownEvents, not a failure (D17). Never throws, even if `data` does; any break of the rule is contract.invalid.
 */
export const parseJsonLines = <D extends z.ZodType = ReturnType<typeof z.json>>(
  text: string,
  data?: D,
): Result<{
  events: StreamEvent[];
  unknownEvents: { line: number; event: UnknownEvent }[];
  envelope: Envelope<z.output<D>>;
}> => {
  if (text === "" || text === "\n") return invalid("the stream is empty");
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  const values: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      values.push(JSON.parse(line));
    } catch {
      return invalid(`line ${index + 1} is not JSON`);
    }
  }
  const last = values.length - 1;
  const events: StreamEvent[] = [];
  const unknownEvents: { line: number; event: UnknownEvent }[] = [];
  for (const [index, value] of values.slice(0, last).entries()) {
    const unknownEvent = UnknownEventSchema.safeParse(value);
    if (unknownEvent.success) {
      unknownEvents.push({ line: index + 1, event: unknownEvent.data });
      continue;
    }
    const event = decode(StreamEventSchema, value, `line ${index + 1} (an event line)`);
    if (!event.ok) return event;
    events.push(event.value);
  }
  const envelope = decode(
    envelopeSchema(data ?? z.json()),
    values[last],
    `line ${last + 1} (the final envelope)`,
  );
  if (!envelope.ok) return envelope;
  return ok({ events, unknownEvents, envelope: envelope.value as Envelope<z.output<D>> });
};
