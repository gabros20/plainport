// Findings: what preflight, plans and refusals report (DESIGN.md "Core API", "Edge cases").

import { z } from "zod";
import type { FailureExitCode } from "./exit-codes.ts";

/** Lower-case words joined by dots, at least two segments; a word may contain single hyphens (git.in-progress). */
export const FindingCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/)
  .meta({ title: "FindingCode", description: "Stable dotted code, e.g. git.unpushed" });

export const SeveritySchema = z.enum(["info", "warn", "block"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingSchema = z
  .strictObject({
    code: FindingCodeSchema,
    severity: SeveritySchema,
    message: z.string().min(1),
    paths: z.array(z.string()).optional(),
    fix: z.string().min(1).optional().meta({ description: "The exact next step, e.g. a command to run" }),
    allowable: z.boolean().meta({ description: "May --allow <code> override it?" }),
  })
  .meta({ title: "Finding" });
export type Finding = z.infer<typeof FindingSchema>;

export interface FindingSpec {
  severity: Severity;
  allowable: boolean;
  /** The exit code when this finding ends a command. */
  exitCode: FailureExitCode;
  summary: string;
}

/** Every finding code plainport emits. A code, once listed, keeps its meaning; later tasks add entries. */
export const FINDINGS = Object.freeze({
  "contract.invalid": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary: "A value crossing an edge did not match its schema",
  },
  "tool.missing": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "A bundled binary (restic or rclone) was not found",
  },
} as const satisfies Record<string, FindingSpec>);

export type FindingCode = keyof typeof FINDINGS;

/** Builds a catalogued finding, taking severity and allowable from the catalogue unless overridden. */
export const finding = (
  code: FindingCode,
  detail: { message: string; fix?: string; paths?: string[]; severity?: Severity },
): Finding => {
  const spec: FindingSpec = FINDINGS[code];
  return {
    code,
    severity: detail.severity ?? spec.severity,
    message: detail.message,
    ...(detail.paths === undefined ? {} : { paths: detail.paths }),
    ...(detail.fix === undefined ? {} : { fix: detail.fix }),
    allowable: spec.allowable,
  };
};
