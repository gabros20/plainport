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
  "command.cancelled": {
    severity: "block",
    allowable: false,
    exitCode: 130,
    summary: "The person answering the prompts cancelled; nothing was written",
  },
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
  "config.owned": {
    severity: "block",
    allowable: false,
    exitCode: 5,
    summary:
      "config.toml sets this already and wins over managed.toml, so plainport will not write a copy it would shadow; edit config.toml",
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
  "device.none": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "This device has no identity yet; plainport init creates it",
  },
  "internal.unexpected": {
    severity: "block",
    allowable: false,
    exitCode: 1,
    summary: "A bug: an exception escaped a command; the message names it",
  },
  "project.ambiguous": {
    severity: "block",
    allowable: false,
    exitCode: 2,
    summary: "A project name matches more than one project; the message lists every candidate address",
  },
  "project.not-found": {
    severity: "block",
    allowable: false,
    exitCode: 4,
    summary: "No project matches the name, address or path",
  },
  "registry.invalid": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "registry.json, this device's project registry, is unreadable; plainport never overwrites it",
  },
  "registry.locked": {
    severity: "block",
    allowable: false,
    exitCode: 11,
    summary: "Another process holds registry.json.lock",
  },
  "risk.needs-yes": {
    severity: "block",
    allowable: false,
    exitCode: 3,
    summary: "A confirm-class command ran without --yes or an approved --plan",
  },
  "root.defined-twice": {
    severity: "warn",
    allowable: false,
    exitCode: 6,
    summary: "config.toml and managed.toml both define a root; config.toml wins key by key, so edit it there",
  },
  "root.exists": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "A root with this key already exists",
  },
  "root.none": {
    severity: "block",
    allowable: false,
    exitCode: 2,
    summary: "The folder is outside every root; file it with --root and --as, or add a root that holds it",
  },
  "root.not-found": {
    severity: "block",
    allowable: false,
    exitCode: 4,
    summary: "No root has this key",
  },
  "root.not-writable": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "plainport cannot write to the root's folder",
  },
  "root.overlap": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary:
      "Two roots on this device overlap or resolve to the same real path; every project belongs to one root",
  },
  "root.path-missing": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "The root's folder on this device does not exist or is not a folder; --create makes it",
  },
  "root.synced-folder": {
    severity: "warn",
    allowable: true,
    exitCode: 6,
    summary:
      "The root is inside an iCloud Drive or Dropbox folder, whose sync clients fight with node_modules and half-written files",
  },
  "root.unbound": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "The root has no folder on this device; plainport root bind gives it one",
  },
  "stub.invalid": {
    severity: "block",
    allowable: false,
    exitCode: 6,
    summary: "A .plainport stub file does not match the stub schema",
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
