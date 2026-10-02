// Operation events and results (DESIGN.md "Core API"). The CLI's --json stream prints the phase, progress and
// finding events as NDJSON lines before the final envelope; log events go to stderr.

import { z } from "zod";
import { FailureExitCodeSchema } from "./exit-codes.ts";
import { FindingSchema } from "./finding.ts";
import { outputObject } from "./objects.ts";

export const PHASES = [
  "resolve",
  "preflight",
  "scan",
  "plan",
  "snapshot",
  "verify",
  "commit",
  "release",
  "restore",
  "swap",
  "agents",
  "toolchain",
  "hydrate",
  "hooks",
] as const;
export const PhaseSchema = z.enum(PHASES).meta({ title: "Phase" });
export type Phase = z.infer<typeof PhaseSchema>;

export const PROJECT_STATES = [
  "local",
  "offloading",
  "shelved",
  "onloading",
  "restored-unhydrated",
  "conflicted",
  "unavailable",
] as const;
export const ProjectStateSchema = z.enum(PROJECT_STATES).meta({ title: "ProjectState" });
export type ProjectState = z.infer<typeof ProjectStateSchema>;

const opId = z.string().min(1);
const byteCount = z.int().nonnegative();

const resultFields = {
  state: ProjectStateSchema,
  project: z.string().optional(),
  snapshot: z.string().optional(),
  freedBytes: byteCount.optional(),
};

/** ok is true exactly when exitCode is 0. */
export const OperationResultSchema = z
  .union([
    outputObject({ ok: z.literal(true), exitCode: z.literal(0), ...resultFields }),
    outputObject({
      ok: z.literal(false),
      exitCode: FailureExitCodeSchema,
      ...resultFields,
      error: outputObject({ code: z.string().min(1), message: z.string().min(1) }).optional(),
    }),
  ])
  .meta({ title: "OperationResult" });
export type OperationResult = z.infer<typeof OperationResultSchema>;

export const PhaseEventSchema = outputObject({
  type: z.literal("phase"),
  op: opId,
  phase: PhaseSchema,
  status: z.enum(["start", "end", "skip"]),
});
export const ProgressEventSchema = outputObject({
  type: z.literal("progress"),
  op: opId,
  phase: PhaseSchema,
  bytesDone: byteCount,
  bytesTotal: byteCount,
  etaSeconds: z.number().nonnegative().optional(),
});
export const FindingEventSchema = outputObject({
  type: z.literal("finding"),
  op: opId,
  finding: FindingSchema,
});
export const LogEventSchema = outputObject({
  type: z.literal("log"),
  op: opId,
  level: z.enum(["debug", "info", "warn"]),
  message: z.string(),
});
export const ResultEventSchema = outputObject({
  type: z.literal("result"),
  op: opId,
  result: OperationResultSchema,
});

export const PlainportEventSchema = z
  .discriminatedUnion("type", [
    PhaseEventSchema,
    ProgressEventSchema,
    FindingEventSchema,
    LogEventSchema,
    ResultEventSchema,
  ])
  .meta({ title: "PlainportEvent" });
export type PlainportEvent = z.infer<typeof PlainportEventSchema>;

/** The events that appear as lines on stdout under --json, before the final envelope. */
export const StreamEventSchema = z
  .discriminatedUnion("type", [PhaseEventSchema, ProgressEventSchema, FindingEventSchema])
  .meta({ title: "StreamEvent" });
export type StreamEvent = z.infer<typeof StreamEventSchema>;

const KNOWN_EVENT_TYPES = ["phase", "progress", "finding", "log", "result"] as const;

/** An event line whose type this version does not know (run decision D17): a reader passes it through or skips it.
 * New event types are additive; new phases or project states are not (machine-contract §7). */
export const UnknownEventSchema = outputObject({
  type: z.string().regex(new RegExp(`^(?!(?:${KNOWN_EVENT_TYPES.join("|")})$).+$`)),
}).meta({ title: "UnknownEvent" });
export type UnknownEvent = z.infer<typeof UnknownEventSchema>;

/** What a reader accepts as a stdout line before the envelope: a known stream event or an unknown type. */
export const StreamLineSchema = z
  .union([StreamEventSchema, UnknownEventSchema])
  .meta({ title: "StreamLine" });

/** What a reader accepts as an event over JSON-RPC: a known event or an unknown type. */
export const EventLineSchema = z
  .union([PlainportEventSchema, UnknownEventSchema])
  .meta({ title: "EventLine" });
