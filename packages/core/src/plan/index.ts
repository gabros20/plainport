// The planner (DESIGN.md "Offload process" steps 4–5, "Core API → Plan"): the strip set, the Plan, and saved plans.

export { compilePatterns, type PatternSet } from "./patterns.ts";
export {
  OFFLOAD_PHASES,
  type OffloadPlanRequest,
  type PlanBoundary,
  type PreparedOffload,
  planOffload,
  prepareOffload,
} from "./planner.ts";
export {
  type ArrivalItem,
  ArrivalItemSchema,
  OPERATION_KINDS,
  type OperationKind,
  OperationKindSchema,
  PLAN_TTL_MS,
  type Plan,
  type PlanFile,
  PlanFileSchema,
  type PlanOptions,
  PlanSchema,
  type ProjectView,
  ProjectViewSchema,
  SizedPathSchema,
  type StripEntry,
  StripEntrySchema,
} from "./schema.ts";
export { listPlans, readPlan, savePlan } from "./store.ts";
export {
  type KeptReason,
  type ProposedStrip,
  resolveStripSet,
  type StripInput,
  type StripSet,
} from "./strip.ts";
