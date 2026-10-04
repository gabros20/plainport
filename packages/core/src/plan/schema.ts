// The Plan (DESIGN.md "Core API"): what an operation would do, built before anything changes. --dry-run prints it,
// --json returns it as data, and an approved plan is saved under plans/ for `--plan <id>` (run decision D36). Its
// shape is public: every frontend renders the same object.
//
// A plan is output, so its schema stays open (D16); the plan file wrapping it is plainport's own and strict.

import { type Finding, FindingSchema, outputObject, PhaseSchema, shellWord } from "@plainport/contract";
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
  note: z.string().optional().meta({
    description:
      "When this step may not happen, e.g. the install skipped while onload renames back the local copy offload.keepLocalFor keeps (D71)",
  }),
}).meta({ title: "ArrivalItem" });
export type ArrivalItem = z.infer<typeof ArrivalItemSchema>;

export const PlanSchema = outputObject({
  id: UlidSchema,
  kind: OperationKindSchema,
  project: ProjectViewSchema.optional(),
  fingerprint: z.string().min(1).meta({
    description:
      "The scan's tree hash over the included paths (the strip set left out); re-checked when the plan runs",
  }),
  fp: z.literal(2).optional().meta({
    description:
      "The fingerprint's kind (D53); a plan without it is of an older kind, never compared, so its approval is stale",
  }),
  include: outputObject({
    files: z.int().nonnegative(),
    bytes,
    largest: z.array(SizedPathSchema).meta({ description: "The ten largest included files, largest first" }),
    gitignored: outputObject({
      files: z.int().nonnegative(),
      paths: z.array(z.string()).meta({ description: "The first 20, sorted" }),
    })
      .optional()
      .meta({
        description:
          "Included files a .gitignore in the project ignores, such as .env and local databases: they travel in the snapshot, since only what a plugin declares regenerable is stripped (gitignored does not mean disposable). Absent when there are none",
      }),
  }),
  strip: z.array(StripEntrySchema),
  findings: z.array(FindingSchema),
  phases: z.array(PhaseSchema),
  arrival: z.array(ArrivalItemSchema).optional().meta({
    description: "What each part becomes where the project lands; for an offload, how it comes back",
  }),
  options: outputObject({
    keepDeps: z.boolean(),
    allow: z.array(z.string()).meta({ description: "--allow codes, sorted" }),
    store: z.string().min(1).optional().meta({ description: "--store, when it was given" }),
    storeId: UlidSchema.optional().meta({
      description:
        "The id in the store's meta/v1/store.json (D45): an approval holds for that store only (D48)",
    }),
    keepLocalFor: z.string(),
    stub: z.boolean(),
  })
    .optional()
    .meta({
      description:
        "What the plan was made with: options and the release settings. An approved plan runs only with the same",
    }),
  estimate: outputObject({
    uploadBytes: bytes.optional(),
    downloadBytes: bytes.optional(),
    freeBytesNeeded: bytes.optional(),
  }),
  expiresAt: z.iso.datetime().meta({ description: "After this, --plan <id> no longer runs it" }),
}).meta({ title: "Plan" });
export type Plan = z.infer<typeof PlanSchema>;
export type PlanOptions = NonNullable<Plan["options"]>;

/**
 * The block finding that stops this plan: the first one its own --allow list (options.allow) does not override, as
 * an allowable blocker named there is overridden (D50). A plan with one is refused and never approvable (D38).
 */
export const planBlocker = (plan: Plan): Finding | undefined => {
  const allow = new Set(plan.options?.allow ?? []);
  return plan.findings.find((f) => f.severity === "block" && !(f.allowable && allow.has(f.code)));
};

/** The exact command that runs this plan: `--plan <id>` with the options it was made with (D36, D38). */
export const planCommand = (plan: Plan): string => {
  const options = plan.options;
  return [
    `plainport ${plan.kind} ${shellWord(plan.project?.address ?? "")} --plan ${plan.id}`,
    ...(options?.keepDeps === true ? ["--keep-deps"] : []),
    ...(options?.allow ?? []).map((code) => `--allow ${shellWord(code)}`),
    ...(options?.store === undefined ? [] : [`--store ${shellWord(options.store)}`]),
  ].join(" ");
};

/** plans/<id>.json: a versioned wrapper around the plan (DESIGN.md "Versioned documents"). */
export const PlanFileSchema = z.strictObject({ v: z.literal(1), plan: PlanSchema });
export type PlanFile = z.infer<typeof PlanFileSchema>;
