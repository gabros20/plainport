// The compatibility matrix's bookkeeping (Task 7). The matrix itself is DESIGN.md's "Formats and compatibility"; this
// module reads it and the test sources so that the two cannot drift apart:
//   - every format in INVENTORY has a row, and every row is in INVENTORY;
//   - every row has at least one test whose title carries its id in brackets, "[store.json.v1] ...";
//   - a `test.todo` is a row (or part of one) a later task owns and must turn on, and the guard fails the M2 gate
//     (PLAINPORT_COMPAT_GATE=1) while any remains.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

/** Every persisted format and closed public value M2 touches. A new one is added here and in DESIGN in one change. */
export const INVENTORY = [
  // catalog events, by type
  "event.registered",
  "event.offloaded",
  "event.onloaded",
  "event.checkpointed",
  "event.snapshot-discarded",
  "event.root-created",
  "event.root-bound",
  "event.resolved",
  "event.unknown",
  "event.sealed",
  // the store's own files
  "store.json.v1",
  "store.json.v2",
  "root.json",
  "store.election",
  "store.upgrade-intent",
  "store.sidecar",
  // this device's state
  "registry.json",
  "device.json",
  "config.keys",
  "managed.toml",
  "journal",
  "journal.held",
  "plan",
  "claim",
  "claim.boot",
  "stub",
  "restic.tags",
  "mirror",
  // closed public values and printed output
  "value.exit-codes",
  "value.project-state",
  "value.offload-kind",
  "value.plan-fp",
  "value.phases",
  "output.additive",
  "output.plan-git",
  "output.plan-nested",
  "output.onload-plan",
  "output.git-unpushed-tags",
  "output.untrusted-known",
  "output.hydrate-via",
  "finding.case-unknown",
] as const;

/** Schemas under schemas/ that v0.2 added since v0.1.1, with the matrix row each belongs to. */
export const NEW_SCHEMAS: Readonly<Record<string, string>> = {
  "trash-claim-boot": "claim.boot",
  "election-record": "store.election",
  "store-semantics": "store.sidecar",
};
/** Schemas that exist at v0.1.1 and differ now, with their row. A changed file schema is a compatibility event. */
export const CHANGED_SCHEMAS: Readonly<Record<string, string>> = {};

export interface Row {
  id: string;
  cells: string[];
}

/** The matrix rows of DESIGN.md's "Formats and compatibility" section: table lines whose first cell is `id`. */
export const matrixRows = (design: string): Row[] => {
  const start = design.indexOf("\n## Formats and compatibility");
  if (start < 0) return [];
  const rest = design.slice(start + 1);
  const next = rest.indexOf("\n## ", 5);
  const section = next < 0 ? rest : rest.slice(0, next);
  const rows: Row[] = [];
  for (const line of section.split("\n")) {
    const m = /^\|\s*`([a-z0-9.-]+)`\s*\|(.*)\|\s*$/.exec(line);
    if (m) rows.push({ id: m[1] as string, cells: (m[2] as string).split("|").map((c) => c.trim()) });
  }
  return rows;
};

export const readDesign = (): string => readFileSync(join(root, "docs/DESIGN.md"), "utf8");

export interface CompatTest {
  title: string;
  todo: boolean;
  /** Row ids in the title's leading brackets. */
  ids: string[];
}

/**
 * Every `test(...)`, `it(...)` and `test.todo(...)` (also `.skipIf(...)`, `.concurrent`, `.only`, `.skip`) with a
 * double-quoted, single-quoted or template-literal title. A title with an interpolation cannot name a row, so it is
 * listed with no ids and the DESIGN-vs-tests check reports a todo it hides through its own count (see matrix.test.ts).
 */
export const testsIn = (sources: readonly string[]): CompatTest[] => {
  const out: CompatTest[] = [];
  const call =
    /\b(?:test|it)(\.todo|\.skipIf\([^)]*\)|\.concurrent|\.only|\.skip)?\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
  for (const source of sources) {
    for (const m of source.matchAll(call)) {
      const title = (m[2] ?? m[3] ?? m[4]) as string;
      const lead = /^((?:\[[a-z0-9.-]+\])+)/.exec(title)?.[1] ?? "";
      const ids = [...lead.matchAll(/\[([a-z0-9.-]+)\]/g)].map((x) => x[1] as string);
      out.push({ title, todo: m[1] === ".todo", ids });
    }
  }
  return out;
};

export const compatSources = (): string[] =>
  readdirSync(import.meta.dir)
    .filter((f) => f.endsWith(".test.ts") && f !== "matrix.test.ts")
    .map((f) => readFileSync(join(import.meta.dir, f), "utf8"));

/** The titles of the todos that remain. */
export const remainingTodos = (sources: readonly string[] = compatSources()): string[] =>
  testsIn(sources)
    .filter((t) => t.todo)
    .map((t) => t.title);
