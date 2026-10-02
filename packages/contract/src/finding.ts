// Findings: what preflight, plans and refusals report (DESIGN.md "Core API", "Edge cases").

import { z } from "zod";
import type { FailureExitCode } from "./exit-codes.ts";
import { outputObject } from "./objects.ts";

/** Lower-case words joined by dots, at least two segments; a word may contain single hyphens (git.in-progress). */
export const FindingCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/)
  .meta({ title: "FindingCode", description: "Stable dotted code, e.g. git.unpushed" });

export const SeveritySchema = z.enum(["info", "warn", "block"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingSchema = outputObject({
  code: FindingCodeSchema,
  severity: SeveritySchema,
  message: z.string().min(1),
  paths: z.array(z.string()).optional(),
  fix: z.string().min(1).optional().meta({ description: "The exact next step, e.g. a command to run" }),
  allowable: z.boolean().meta({ description: "May --allow <code> override it?" }),
}).meta({ title: "Finding" });
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
  "command.unknown": {
    severity: "block",
    allowable: false,
    exitCode: 4,
    summary: "No registered command has this name; the message suggests the closest one",
  },
  "config.invalid": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "A config file does not parse or does not match its schema, and there is no last good copy to keep",
  },
  "config.kept-last-good": {
    severity: "warn",
    allowable: false,
    exitCode: 6,
    summary: "A config file broke since it was last loaded; its last good contents stay in effect",
  },
  "config.locked": {
    severity: "block",
    allowable: false,
    exitCode: 11,
    summary: "Another process holds managed.toml.lock",
  },
  "config.no-home": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "HOME is unset or not an absolute path, so plainport cannot find its config and state",
  },
  "config.not-found": {
    severity: "block",
    allowable: false,
    exitCode: 4,
    summary: "The config file named by --config or PLAINPORT_CONFIG does not exist",
  },
  "config.read-only": {
    severity: "block",
    allowable: false,
    exitCode: 5,
    summary: "A write would rewrite config.toml, which plainport never does",
  },
  "config.write-failed": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary: "managed.toml or device.json could not be written; the old file is intact",
  },
  "contract.invalid": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary: "A value crossing an edge did not match its schema",
  },
  "device.invalid": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "device.json, this device's identity, is unreadable; plainport never replaces it",
  },
  "internal.unexpected": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary: "A bug: an exception escaped a command; the message names it",
  },
  "risk.needs-yes": {
    severity: "block",
    allowable: false,
    exitCode: 3,
    summary: "A confirm-class command ran without --yes or an approved --plan",
  },
  "usage.dry-run-unsupported": {
    severity: "block",
    allowable: false,
    exitCode: 2,
    summary: "--dry-run was given to a command that has no preview",
  },
  "usage.invalid": {
    severity: "block",
    allowable: false,
    exitCode: 2,
    summary: "The arguments or options do not match the command's declared arguments",
  },
  "tool.missing": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "A bundled binary (restic or rclone) was not found",
  },
} as const satisfies Record<string, FindingSpec>);

export type FindingCode = keyof typeof FINDINGS;

/** Builds a catalogued finding. Severity and allowable are properties of the code, so they come from the catalogue. */
export const finding = (
  code: FindingCode,
  detail: { message: string; fix?: string; paths?: string[] },
): Finding => {
  const spec: FindingSpec = FINDINGS[code];
  return {
    code,
    severity: spec.severity,
    message: detail.message,
    ...(detail.paths === undefined ? {} : { paths: detail.paths }),
    ...(detail.fix === undefined ? {} : { fix: detail.fix }),
    allowable: spec.allowable,
  };
};
