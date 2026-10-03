// plainport offload (DESIGN.md "Offload process", "CLI design"). offload is confirm-class: it sends the project off
// this machine and deletes the local copy. In this build only its preview runs: --dry-run (always read, D18) plans
// the offload, prints the plan as DESIGN.md shows it, and saves it under plans/ so `--plan <id>` can approve it
// (D36). The real run arrives with the offload saga (M1 Task 12); until then it refuses with command.unavailable
// after the gate, so --yes or an approved plan still leaves everything as it was.

import { type Finding, fail, finding, ok, shellWord } from "@plainport/contract";
import {
  ConfigLoader,
  PLAN_TTL_MS,
  type Plan,
  PlanSchema,
  planOffload,
  resolveProject,
  savePlan,
  systemErrorCode,
  ulid,
} from "@plainport/core";
import { z } from "zod";
import { defineCommand } from "../registry.ts";
import { thisDevice } from "./local.ts";

const SI = ["B", "KB", "MB", "GB", "TB"];

/** Bytes as people read them, three significant digits: 612 MB, 1.93 GB, 2.4 KB, 48 B. */
export const formatBytes = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < SI.length - 1) {
    value /= 1000;
    unit++;
  }
  if (unit === 0) return `${bytes} B`;
  const digits = value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${Number(value.toFixed(digits))} ${SI[unit]}`;
};

const LABEL = 10;
const row = (label: string, text: string): string => `  ${label.padEnd(LABEL)}${text}`;
const SHOWN_LARGEST = 3;

/** The plan as DESIGN.md "CLI design" shows it: target, totals, strip set, largest files, findings, the plan id. */
export const renderPlan = (plan: Plan): string => {
  const address = plan.project?.address ?? "";
  const lines = [`${address} → ${plan.project?.store ?? "(no store set)"}`];
  lines.push(
    row(
      "include",
      `${plan.include.files.toLocaleString("en-US")} file${plan.include.files === 1 ? "" : "s"} · ${formatBytes(plan.include.bytes)}`,
    ),
  );
  if (plan.strip.length > 0)
    lines.push(row("strip", plan.strip.map((s) => `${s.path} ${formatBytes(s.bytes)}`).join(" · ")));
  if (plan.include.largest.length > 0) {
    const largest = plan.include.largest.slice(0, SHOWN_LARGEST);
    lines.push(row("largest", largest.map((l) => `${l.path} ${formatBytes(l.bytes)}`).join(" · ")));
  }
  for (const f of plan.findings) {
    lines.push(row(f.severity, `${f.code}  ${f.message}`));
    if (f.severity === "block" && f.fix !== undefined)
      lines.push(`${" ".repeat(2 + LABEL + 2)}fix: ${f.fix}`);
  }
  const blocked = plan.findings.some((f: Finding) => f.severity === "block");
  const hours = PLAN_TTL_MS / 3_600_000;
  lines.push(
    row(
      "plan",
      blocked
        ? `${plan.id} is blocked: fix the findings above, then plan again`
        : `${plan.id} (valid ${hours}h) → plainport ${plan.kind} ${shellWord(address)} --plan ${plan.id}`,
    ),
  );
  return lines.join("\n");
};

export const offload = defineCommand({
  name: "offload",
  summary: "Snapshot a project, verify it and free its folder; --dry-run shows the plan first",
  risk: "confirm",
  dryRun: { plan: PlanSchema, human: renderPlan },
  acceptsPlan: true,
  positionals: ["project"],
  args: z.strictObject({
    project: z.string().meta({ description: "An address (root:path), a unique name, a path, . or a stub" }),
    plan: z.string().optional().meta({ description: "Run a plan a --dry-run saved, instead of --yes" }),
    "keep-deps": z
      .boolean()
      .optional()
      .meta({ description: "Keep installed dependencies (node_modules) in the snapshot" }),
  }),
  output: z.looseObject({
    op: z.string(),
    exitCode: z.literal(0),
    project: z.string(),
    snapshot: z.string(),
    freedBytes: z.int().nonnegative(),
  }),
  examples: [
    { argv: ["offload", "work:clients/acme/web", "--dry-run"], summary: "Plan offloading a project" },
  ],
  human: (data) => `offloaded ${data.project} as snapshot ${data.snapshot}`,
  handler: async (args, ctx) => {
    if (!ctx.dryRun) {
      return fail(
        finding("command.unavailable", {
          message:
            "offload cannot run for real in this build yet (the offload saga arrives in M1 Task 12); nothing was changed",
          fix: `plainport offload ${shellWord(args.project)} --dry-run`,
        }),
      );
    }
    const local = await thisDevice(ctx);
    if (!local.ok) return local;
    const { paths, device } = local.value;
    const resolved = await resolveProject(ctx.io, paths, args.project, {
      cwd: ctx.cwd,
      env: ctx.env,
      device: device.name,
    });
    if (!resolved.ok) return resolved;
    const ref = resolved.value;
    if (ref.dir === undefined) {
      return fail(
        finding("project.not-found", {
          message: `${ref.address} has no folder on this device, so there is nothing here to offload`,
          fix: `plainport root bind ${ref.root} <path> if the root lives elsewhere on this device`,
        }),
      );
    }
    const now = ctx.clock.now();
    const op = ulid(now.getTime());
    const planned = await planOffload(ctx.system, ctx.checks, ctx.plugins, {
      dir: ref.dir,
      project: {
        address: ref.address,
        root: ref.root,
        path: ref.path,
        ...(ref.id === undefined ? {} : { id: ref.id }),
      },
      loader: new ConfigLoader(ctx.io, paths),
      env: ctx.env,
      now,
      ...(ctx.store === undefined ? {} : { store: ctx.store }),
      ...(args["keep-deps"] === true ? { keepDeps: true } : {}),
      onFinding: (f) => ctx.output.emit({ type: "finding", op, finding: f }),
    });
    if (!planned.ok) return planned;
    try {
      await savePlan(ctx.io, paths, planned.value, now);
    } catch (error) {
      // The preview stands without its file; only --plan <id> cannot find it.
      ctx.output.log(
        "warn",
        `the plan could not be saved under ${paths.plansDir} (${systemErrorCode(error)}), so --plan ${planned.value.id} will not find it; use --yes instead`,
      );
    }
    return ok(planned.value);
  },
});
