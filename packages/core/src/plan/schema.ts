// The Plan (DESIGN.md "Core API"): what an operation would do, built before anything changes. --dry-run prints it,
// --json returns it as data, and an approved plan is saved under plans/ for `--plan <id>` (run decision D36). Its
// shape is public: every frontend renders the same object.
//
// A plan is output, so its schema stays open (D16); the plan file wrapping it is plainport's own and strict.

import { FindingSchema, outputObject, PhaseSchema } from "@plainport/contract";
import { z } from "zod";
import { UlidSchema } from "../ulid.ts";

/** A plan is valid for an hour after it is made (DESIGN.md "Local state per machine"). */
export const PLAN_TTL_MS = 60 * 60 * 1000;

const bytes = z.int().nonnegative();

export const OPERATION_KINDS = [
  "offload",
  "onload",
  "move",
  "relocate",
  "restore",
  "resolve",
  "checkpoint",
  "hydrate",
  "dehydrate",
  "forget",
  "kit-apply",
  "prune",
] as const;
export const OperationKindSchema = z.enum(OPERATION_KINDS).meta({ title: "OperationKind" });
export type OperationKind = z.infer<typeof OperationKindSchema>;

export const SizedPathSchema = outputObject({
  path: z.string().min(1).meta({ description: "Relative to the project folder" }),
  bytes,
}).meta({ title: "SizedPath" });

export const StripEntrySchema = outputObject({
  path: z.string().min(1).meta({ description: "Relative to the project folder; left out of the snapshot" }),
  bytes,
  plugin: z.string().min(1).meta({ description: 'The plugin that claimed it, or "config" for strip.extra' }),
  reason: z.string().min(1).meta({ description: "Why it can be regenerated" }),
}).meta({ title: "StripEntry" });
export type StripEntry = z.infer<typeof StripEntrySchema>;

export const ProjectViewSchema = outputObject({
  address: z.string().min(1).meta({ description: "root:path" }),
  root: z.string().min(1),
  path: z.string().min(1),
  id: UlidSchema.optional().meta({ description: "The project's ULID, when this device knows it" }),
  dir: z.string().min(1).optional().meta({ description: "Its folder on this device, absolute" }),
  store: z.string().min(1).optional().meta({ description: "The store the operation would use" }),
}).meta({ title: "ProjectView" });
export type ProjectView = z.infer<typeof ProjectViewSchema>;

export const ArrivalItemSchema = outputObject({
  part: z.enum(["files", "deps", "agent-session", "secrets", "git-access", "process"]),
  outcome: z.enum(["restore", "reuse", "hydrate", "resume", "handoff", "withheld", "suggest", "skip"]),
  detail: z.string().meta({ description: 'e.g. "pnpm install --frozen-lockfile", "claude --resume <id>"' }),
}).meta({ title: "ArrivalItem" });
export type ArrivalItem = z.infer<typeof ArrivalItemSchema>;

export const PlanSchema = outputObject({
  id: UlidSchema,
  kind: OperationKindSchema,
  project: ProjectViewSchema.optional(),
  fingerprint: z.string().min(1).meta({ description: "The scan's tree hash; re-checked when the plan runs" }),
  include: outputObject({
    files: z.int().nonnegative(),
    bytes,
    largest: z.array(SizedPathSchema).meta({ description: "The ten largest included files, largest first" }),
  }),
  strip: z.array(StripEntrySchema),
  findings: z.array(FindingSchema),
  phases: z.array(PhaseSchema),
  arrival: z.array(ArrivalItemSchema).optional().meta({
    description: "What each part becomes where the project lands; for an offload, how it comes back",
  }),
  estimate: outputObject({
    uploadBytes: bytes.optional(),
    downloadBytes: bytes.optional(),
    freeBytesNeeded: bytes.optional(),
  }),
  expiresAt: z.iso.datetime().meta({ description: "After this, --plan <id> no longer runs it" }),
}).meta({ title: "Plan" });
export type Plan = z.infer<typeof PlanSchema>;

/** plans/<id>.json: a versioned wrapper around the plan (DESIGN.md "Versioned documents"). */
export const PlanFileSchema = z.strictObject({ v: z.literal(1), plan: PlanSchema });
export type PlanFile = z.infer<typeof PlanFileSchema>;
