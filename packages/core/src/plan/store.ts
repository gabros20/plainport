// Saved plans (DESIGN.md "Local state per machine": `plans/<plan>.json`, approved plans that expire after one
// hour; run decision D36). A --dry-run saves its plan here so `--plan <id>` can run it: passing a fresh plan's id is
// the approval. The file holds the whole plan, so the run checks it against the folder again (its fingerprint)
// before anything changes.

import { join } from "node:path";
import { fail, finding, ok, type Result, shellWord } from "@plainport/contract";
import { writeAtomic } from "../atomic.ts";
import { type LocalIo, systemErrorCode } from "../io.ts";
import type { PlainportPaths } from "../paths.ts";
import { isUlid } from "../ulid.ts";
import { type OperationKind, PLAN_TTL_MS, type Plan, PlanFileSchema, planBlocker } from "./schema.ts";

const SUFFIX = ".json";
const fileOf = (paths: PlainportPaths, id: string): string => join(paths.plansDir, `${id}${SUFFIX}`);
const expired = (plan: Plan, now: Date): boolean => Date.parse(plan.expiresAt) <= now.getTime();
/** Fresh and free of blockers its --allow list does not override: a plan its own dry run refused is never approved (D38, D50). */
const approvable = (plan: Plan, now: Date): boolean => !expired(plan, now) && planBlocker(plan) === undefined;

const notFound = (id: string) =>
  fail(
    finding("plan.not-found", {
      message: `no saved plan has the id ${id} on this device`,
      fix: "plan the operation again with --dry-run; it prints the plan id to pass to --plan",
    }),
  );

/** Reads one plan file: the plan, undefined when there is none, or contract.invalid for a file that is not one. */
const readFile = async (io: LocalIo, path: string): Promise<Result<Plan | undefined>> => {
  let text: string;
  try {
    text = await io.fs.readText(path);
  } catch (error) {
    const code = systemErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return ok(undefined);
    return fail(
      finding("contract.invalid", {
        message: `the plan file ${path} cannot be read: ${(error as Error).message}`,
        paths: [path],
      }),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const checked = PlanFileSchema.safeParse(parsed);
  if (!checked.success) {
    return fail(
      finding("contract.invalid", {
        message: `the plan file ${path} is not a valid plan`,
        paths: [path],
        fix: `plan again with --dry-run; the broken file can be removed: rm ${shellWord(path)}`,
      }),
    );
  }
  return ok(checked.data.plan);
};

/**
 * Removes plans that expired more than an hour before `now`, best effort, never `keep`; younger ones stay, so a late
 * --plan still hears plan.expired rather than plan.not-found. Only a real run prunes: a dry run writes nothing but its
 * plan file (D36, D61, N5). A folder that cannot be listed is left for the next run.
 */
export const prunePlans = async (
  io: LocalIo,
  paths: PlainportPaths,
  now: Date,
  keep?: string,
): Promise<void> => {
  let names: string[];
  try {
    names = await io.fs.readdir(paths.plansDir);
  } catch (error) {
    systemErrorCode(error);
    return;
  }
  for (const name of names) {
    const id = name.slice(0, -SUFFIX.length);
    if (!name.endsWith(SUFFIX) || !isUlid(id) || id === keep) continue;
    const old = await readFile(io, join(paths.plansDir, name));
    if (!old.ok || old.value === undefined) continue;
    if (Date.parse(old.value.expiresAt) + PLAN_TTL_MS <= now.getTime()) {
      try {
        await io.fs.unlink(join(paths.plansDir, name));
      } catch (error) {
        // Already gone, or not removable now: it is tried again with the next run.
        systemErrorCode(error);
      }
    }
  }
};

/** Saves a plan as plans/<id>.json, atomically; nothing else is written or removed (prunePlans does that). */
export const savePlan = async (io: LocalIo, paths: PlainportPaths, plan: Plan): Promise<void> => {
  await io.fs.mkdirp(paths.plansDir);
  await writeAtomic(io, fileOf(paths, plan.id), `${JSON.stringify({ v: 1, plan }, null, 2)}\n`);
};

/** A saved plan that has not expired: plan.not-found (exit 4), plan.expired (exit 6) or contract.invalid otherwise. */
export const readPlan = async (
  io: LocalIo,
  paths: PlainportPaths,
  id: string,
  now: Date,
): Promise<Result<Plan>> => {
  if (!isUlid(id)) return notFound(id);
  const read = await readFile(io, fileOf(paths, id));
  if (!read.ok) return read;
  if (read.value === undefined) return notFound(id);
  const plan = read.value;
  if (expired(plan, now)) {
    const target = plan.project?.address;
    return fail(
      finding("plan.expired", {
        message: `plan ${id} expired at ${plan.expiresAt}; a plan is valid for an hour after it is made`,
        fix:
          target === undefined
            ? `plan again: plainport ${plan.kind} --dry-run`
            : `plainport ${plan.kind} ${shellWord(target)} --dry-run`,
      }),
    );
  }
  return ok(plan);
};

/** The plans `--plan <id>` may approve: fresh, with no block finding left by its --allow list (D38, D50). Files that are not plans are passed over. */
export const listPlans = async (
  io: LocalIo,
  paths: PlainportPaths,
  now: Date,
): Promise<{ id: string; kind: OperationKind }[]> => {
  let names: string[];
  try {
    names = await io.fs.readdir(paths.plansDir);
  } catch (error) {
    // No plans folder, or one this process may not read: no plan is approved.
    systemErrorCode(error);
    return [];
  }
  const plans: { id: string; kind: OperationKind }[] = [];
  for (const name of names.sort()) {
    const id = name.slice(0, -SUFFIX.length);
    if (!name.endsWith(SUFFIX) || !isUlid(id)) continue;
    const read = await readFile(io, join(paths.plansDir, name));
    if (read.ok && read.value !== undefined && read.value.id === id && approvable(read.value, now))
      plans.push({ id, kind: read.value.kind });
  }
  return plans;
};
