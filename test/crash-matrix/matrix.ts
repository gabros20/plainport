// The crash matrix's rows (ADR-0017, DESIGN.md "Testing and fault injection"), enumerated from what the sagas and
// recover export, never listed by hand: every journal step (OFFLOAD_STEPS, ONLOAD_STEPS) and every after-effect seam
// (OFFLOAD_AFTER_EFFECT, ONLOAD_AFTER_EFFECT, D52) is a crash point; the branches (OFFLOAD_BRANCHES, ONLOAD_BRANCHES)
// say which points a plain run cannot reach and what a run needs to reach them. A new step, seam or branch adds rows
// by itself; a new branch also fails the typecheck until each variant says how to set it up (BranchSetups).
//
// Each row names the journal step a crash there leaves on disk (the point itself, or the step its seam follows) and
// the recover rule for that step (OFFLOAD_RECOVERY, ONLOAD_RECOVERY); RECOVERY_RULE_OUTCOMES bounds what recover may
// report for it.

import {
  OFFLOAD_RECOVERY,
  ONLOAD_RECOVERY,
  RECOVERY_RULE_OUTCOMES,
  type RecoveryOutcome,
} from "../../packages/core/src/recover/recover.ts";
import {
  OFFLOAD_AFTER_EFFECT,
  OFFLOAD_BRANCHES,
  OFFLOAD_STEPS,
  type OffloadAfterEffect,
  type OffloadStep,
} from "../../packages/core/src/saga/offload.ts";
import {
  ONLOAD_AFTER_EFFECT,
  ONLOAD_BRANCHES,
  ONLOAD_STEPS,
  type OnloadStep,
} from "../../packages/core/src/saga/onload.ts";

export type Saga = "offload" | "onload";
export type OffloadBranch = keyof typeof OFFLOAD_BRANCHES;
export type OnloadBranch = keyof typeof ONLOAD_BRANCHES;

/**
 * How a branch is reached, which each variant must state for every branch:
 * - plain: the plain run already takes it (the default config, a first offload); its points are plain rows.
 * - exclusive: only a run set up for it reaches its points (an unreadable file, a moved head, a kept trash).
 * - again: the run reaches its points a second time (a retry); rows crash at that second time.
 * - resumed: a second run reaches them after a first one crashed (an onload taken over); rows crash the second run.
 */
export type BranchKind = "plain" | "exclusive" | "again" | "resumed";

export const OFFLOAD_BRANCH_KINDS = {
  discarded: "exclusive",
  diverged: "exclusive",
  retry: "again",
  firstOffloadOfRoot: "plain",
  keepStub: "plain",
  detached: "plain",
} as const satisfies Record<OffloadBranch, BranchKind>;

export const ONLOAD_BRANCH_KINDS = {
  reuse: "exclusive",
  resume: "resumed",
  stub: "plain",
} as const satisfies Record<OnloadBranch, BranchKind>;

export interface Row {
  saga: Saga;
  /** "plain", or the branch whose setup the run needs. */
  scenario: string;
  /** The step or seam the run crashes at. */
  point: string;
  /** Which time the run reaches the point when it crashes there (2 for a retry's second attempt). */
  occurrence: number;
  /** The journal step a crash there leaves: the point itself, or for a seam the step it follows. */
  step: string;
  /** recover's rule for that step. */
  rule: string;
  /** What recover may report for it. */
  outcomes: readonly RecoveryOutcome[];
  /** A test name: saga · point (#occurrence) · scenario. */
  name: string;
}

interface SagaTables {
  saga: Saga;
  steps: readonly string[];
  seams: Readonly<Record<string, string>>;
  branches: Readonly<Record<string, { reaches: readonly string[] }>>;
  kinds: Readonly<Record<string, BranchKind>>;
  recovery: Readonly<Record<string, string>>;
}

const rowsOf = (t: SagaTables): Row[] => {
  const points = [...t.steps, ...Object.keys(t.seams)];
  const exclusive = new Set(
    Object.entries(t.branches)
      .filter(([name]) => t.kinds[name] === "exclusive")
      .flatMap(([, b]) => b.reaches),
  );
  const rows = new Map<string, Row>();
  const add = (scenario: string, point: string, occurrence: number) => {
    const step = Object.hasOwn(t.seams, point) ? (t.seams[point] as string) : point;
    if (!t.steps.includes(step)) throw new Error(`${point}: ${step} is not a ${t.saga} step`);
    const rule = t.recovery[step];
    if (rule === undefined) throw new Error(`${step} has no recover rule`);
    const outcomes = RECOVERY_RULE_OUTCOMES[rule as keyof typeof RECOVERY_RULE_OUTCOMES];
    const key = `${scenario} ${point} ${occurrence}`;
    if (rows.has(key)) return;
    rows.set(key, {
      saga: t.saga,
      scenario,
      point,
      occurrence,
      step,
      rule,
      outcomes,
      name: `${point}${occurrence > 1 ? ` #${occurrence}` : ""} · ${scenario}`,
    });
  };
  for (const point of points) if (!exclusive.has(point)) add("plain", point, 1);
  for (const [name, branch] of Object.entries(t.branches)) {
    const kind = t.kinds[name];
    for (const point of branch.reaches) {
      if (!points.includes(point))
        throw new Error(`branch ${name} reaches ${point}, which is no step or seam`);
      if (kind === "plain") add("plain", point, 1);
      else add(name, point, kind === "again" ? 2 : 1);
    }
  }
  return [...rows.values()];
};

export const OFFLOAD_ROWS: readonly Row[] = rowsOf({
  saga: "offload",
  steps: OFFLOAD_STEPS,
  seams: OFFLOAD_AFTER_EFFECT,
  branches: OFFLOAD_BRANCHES,
  kinds: OFFLOAD_BRANCH_KINDS,
  recovery: OFFLOAD_RECOVERY satisfies Record<OffloadStep, string>,
});

export const ONLOAD_ROWS: readonly Row[] = rowsOf({
  saga: "onload",
  steps: ONLOAD_STEPS,
  seams: ONLOAD_AFTER_EFFECT,
  branches: ONLOAD_BRANCHES,
  kinds: ONLOAD_BRANCH_KINDS,
  recovery: ONLOAD_RECOVERY satisfies Record<OnloadStep, string>,
});

/** The scenarios a variant must set up for a saga: plain, and each branch that is not plain. */
export type ScenarioOf<K extends Record<string, BranchKind>> =
  | "plain"
  | { [B in keyof K]: K[B] extends "plain" ? never : B }[keyof K];

/**
 * What each saga's folder means to the checks, so a new saga is a compile error here until it is said:
 * - crashLeavesTheProject: whatever the crash left in place or in the trash is the project as it was before the run;
 * - folderKeepsStripped: a folder in place after recover still holds the strip set (an offload never strips the
 *   user's folder; an onload restores without dependencies, --no-hydrate, or renames a trash back with them).
 */
export const SAGA_FOLDER: {
  readonly [S in Saga]: { crashLeavesTheProject: boolean; folderKeepsStripped: boolean };
} = {
  offload: { crashLeavesTheProject: true, folderKeepsStripped: true },
  onload: { crashLeavesTheProject: false, folderKeepsStripped: false },
};

/** The steps and seams the harness itself names, typed so a renamed one fails the typecheck. */
export const MATRIX_POINTS = {
  /** Where a run pauses, or dies part-way, while the test changes the world: just before restic starts. */
  upload: "offload.snapshot.start" satisfies OffloadStep,
  /** A first offload dies here to register the project and its root (the diverged branch's setup). */
  register: "offload.planned" satisfies OffloadStep,
  /** Where the first onload of the resume branch dies: the last step it says a resumed onload reaches again. */
  resumeFrom: ONLOAD_BRANCHES.resume.reaches[ONLOAD_BRANCHES.resume.reaches.length - 1] as OnloadStep,
  /** Past the detached delete's start: it races recover and may remove the journal first. */
  raced: "offload.release.detached" satisfies OffloadAfterEffect,
} as const;

export const ALL_ROWS: readonly Row[] = [...OFFLOAD_ROWS, ...ONLOAD_ROWS];

/** The plain row that crashes at a point the first time it is reached. */
export const plainRowAt = (point: string): Row => {
  const row = ALL_ROWS.find((r) => r.point === point && r.scenario === "plain" && r.occurrence === 1);
  if (row === undefined) throw new Error(`no plain row at ${point}`);
  return row;
};
