// Risk classes (ADR-0007, docs/machine-contract.md §4). gate.ts turns one into a verdict (D15).

import { z } from "zod";

/** In rising order of consequence: read runs freely, safe_write changes only what plainport can undo or
 * regenerate, confirm sends data off the machine or deletes it and needs --yes. */
export const RISK_CLASSES = ["read", "safe_write", "confirm"] as const;
export const RiskClassSchema = z.enum(RISK_CLASSES).meta({ title: "RiskClass" });
export type RiskClass = z.infer<typeof RiskClassSchema>;

/** A command that declares no risk class is gated as confirm (ADR-0007; ADR-0003, after plainkeep's guardrail). */
export const DEFAULT_RISK: RiskClass = "confirm";
