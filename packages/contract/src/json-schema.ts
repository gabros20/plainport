// JSON Schema export of the contract schemas, for consumers outside TypeScript (the SwiftUI app, agents).

import { z } from "zod";
import { EnvelopeSchema } from "./envelope.ts";
import {
  EventLineSchema,
  OperationResultSchema,
  PhaseSchema,
  ProjectStateSchema,
  StreamLineSchema,
} from "./events.ts";
import { ExitCodeSchema } from "./exit-codes.ts";
import { FindingSchema } from "./finding.ts";
import { RiskClassSchema } from "./risk.ts";

const CONTRACT_SCHEMAS = {
  envelope: EnvelopeSchema,
  event: EventLineSchema,
  "exit-code": ExitCodeSchema,
  finding: FindingSchema,
  "operation-result": OperationResultSchema,
  phase: PhaseSchema,
  "project-state": ProjectStateSchema,
  "risk-class": RiskClassSchema,
  "stream-event": StreamLineSchema,
} as const;

export type ContractSchemaName = keyof typeof CONTRACT_SCHEMAS;

/** Each public contract schema as a draft 2020-12 JSON Schema document, keyed by its file name stem. */
export const contractJsonSchemas = (): Record<ContractSchemaName, Record<string, unknown>> => {
  const out = {} as Record<ContractSchemaName, Record<string, unknown>>;
  for (const [name, schema] of Object.entries(CONTRACT_SCHEMAS) as [ContractSchemaName, z.ZodType][]) {
    out[name] = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>;
  }
  return out;
};
