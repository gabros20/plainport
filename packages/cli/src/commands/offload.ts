// plainport offload (DESIGN.md "Offload process", "CLI design"). offload is confirm-class: it sends the project off
// this machine and deletes the local copy, so it runs with --yes or an approved --plan <id> (D36). --dry-run (always
// read, D18) plans the offload, prints the plan as DESIGN.md shows it, and saves it under plans/ so `--plan <id>` can
// approve it; a plan with blockers exits 6 with the plan as the error's data (D14, D38), and --allow applies there as in
// a real run, so a plan whose allowable blockers it names is approvable (D50). A real run is core's offload
// saga: it plans afresh (with --plan, the folder must still match the approved plan), stops on blockers that
// --allow does not override, snapshots, verifies, commits and releases. The argument is variadic in the contract;
// M1 takes one project (D38).

import { openEventMirror } from "@plainport/blob-fs";
import { fail, failWith, finding, ok } from "@plainport/contract";
import {
  ConfigLoader,
  PLAN_TTL_MS,
  type Plan,
  PlanSchema,
  planBlocker,
  planCommand,
  planOffload,
  readRegistry,
  resolveProject,
  runOffload,
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
  const blocker = planBlocker(plan);
  const allowed = new Set(plan.options?.allow ?? []);
  for (const f of plan.findings) {
    // A blocker the plan's --allow overrides (D50) is shown as allowed, without a fix to apply.
    const overridden = f.severity === "block" && f.allowable && allowed.has(f.code);
    lines.push(row(overridden ? "allowed" : f.severity, `${f.code}  ${f.message}`));
    if (f.severity === "block" && !overridden && f.fix !== undefined)
      lines.push(`${" ".repeat(2 + LABEL + 2)}fix: ${f.fix}`);
  }
  const blocked = blocker !== undefined;
  const hours = PLAN_TTL_MS / 3_600_000;
  lines.push(
    row(
      "plan",
      blocked
        ? `${plan.id} is blocked: fix the findings above, then plan again`
        : `${plan.id} (valid ${hours}h) → ${planCommand(plan)}`,
    ),
  );
  return lines.join("\n");
};

/** A real run's data: the offload done; or, with exit 8, the snapshot kept as a fork; or, with exit 6 for a plan
 * that no longer holds, the fresh plan (D14, D38). */
const OffloadOutputSchema = z.union([
  z.looseObject({
    op: z.string(),
    exitCode: z.literal(0),
    project: z.string(),
    snapshot: z.string(),
    freedBytes: z.int().nonnegative().meta({
      description: "Bytes freed now: 0 while the trash is kept (keepLocalFor) or waits for recover",
    }),
    store: z.string(),
    stub: z.string().optional().meta({ description: "The .plainport stub left where the folder was" }),
    trash: z.string().meta({ description: "Where the folder waits to be deleted, by a detached process" }),
    keepUntil: z.iso
      .datetime()
      .optional()
      .meta({ description: "keepLocalFor: the trash is kept until then" }),
  }),
  z
    .looseObject({
      op: z.string(),
      exitCode: z.literal(8),
      project: z.string(),
      snapshot: z.string(),
      store: z.string(),
      stored: z.string().meta({ description: "The store's restic id for the snapshot kept as a fork" }),
    })
    .meta({
      description: "Exit 8: the head moved, the snapshot is kept as a fork and the folder stays (D14)",
    }),
  PlanSchema.meta({ description: "Exit 6 (plan.stale): the fresh plan to review and approve (D14, D38)" }),
]);

export const offload = defineCommand({
  name: "offload",
  summary: "Snapshot a project, verify it and free its folder; --dry-run shows the plan first",
  risk: "confirm",
  dryRun: { plan: PlanSchema, human: renderPlan },
  acceptsPlan: true,
  positionals: ["project"],
  args: z.strictObject({
    project: z
      .array(z.string())
      .min(1)
      .max(1, "one project per offload until bulk offload lands (D38)")
      .meta({ description: "An address (root:path), a unique name, a path, . or a stub; one for now" }),
    plan: z.string().optional().meta({ description: "Run a plan a --dry-run saved, instead of --yes" }),
    "keep-deps": z
      .boolean()
      .optional()
      .meta({ description: "Keep installed dependencies (node_modules) in the snapshot" }),
    allow: z.array(z.string()).optional().meta({
      description: "Override an allowable blocker by its code, e.g. --allow git.locked (repeatable)",
    }),
  }),
  output: OffloadOutputSchema,
  examples: [
    { argv: ["offload", "work:clients/acme/web", "--dry-run"], summary: "Plan offloading a project" },
    { argv: ["offload", "work:clients/acme/web", "--yes"], summary: "Offload a project without a prompt" },
  ],
  human: (data) => {
    if ("fingerprint" in data) return renderPlan(data as Plan);
    if (data.exitCode === 8)
      return `kept snapshot ${data.snapshot} (${data.stored.slice(0, 8)} in ${data.store}) as a fork of ${data.project}; the folder stays`;
    return [
      `offloaded ${data.project} to ${data.store} as snapshot ${data.snapshot}; freed ${formatBytes(data.freedBytes)}`,
      ...(data.stub === undefined ? [] : [`stub      ${data.stub}`]),
      ...(data.keepUntil !== undefined
        ? [`kept      ${data.trash} until ${data.keepUntil}`]
        : data.freedBytes === 0
          ? [`trash     ${data.trash} waits for plainport recover to delete it`]
          : []),
    ].join("\n");
  },
  handler: async (args, ctx) => {
    const local = await thisDevice(ctx);
    if (!local.ok) return local;
    const { paths, device } = local.value;
    const resolved = await resolveProject(ctx.io, paths, args.project[0] as string, {
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
    if (!ctx.dryRun) {
      const release = ctx.holdSignal();
      try {
        const done = await runOffload(
          {
            host: ctx.system,
            checks: ctx.checks,
            plugins: ctx.plugins,
            paths,
            device,
            env: ctx.env,
            loader: new ConfigLoader(ctx.io, paths),
            opener: ctx.stores,
            openMirror: (storeId) => openEventMirror(ctx.io, paths, storeId),
            emit: (event) => ctx.output.emit(event),
            log: (level, message) => ctx.output.log(level, message),
            signal: ctx.signal,
            now: () => ctx.clock.now(),
          },
          {
            project: ref,
            ...(args.plan === undefined ? {} : { plan: args.plan }),
            ...(args.allow === undefined ? {} : { allow: args.allow }),
            ...(args["keep-deps"] === true ? { keepDeps: true } : {}),
            ...(ctx.store === undefined ? {} : { store: ctx.store }),
          },
        );
        return done.ok ? ok({ ...done.value, exitCode: 0 as const }) : done;
      } finally {
        release();
      }
    }
    const now = ctx.clock.now();
    const op = ulid(now.getTime());
    // The store's id this device recorded, so an approval binds that store (D48); none before it is set up.
    const registry = await readRegistry(ctx.io, paths);
    if (!registry.ok) return registry;
    const loaded = await new ConfigLoader(ctx.io, paths).load({ env: ctx.env, root: ref.root });
    if (!loaded.ok) return loaded;
    const storeName =
      ctx.store ?? loaded.value.config.roots[ref.root]?.store ?? loaded.value.config.defaultStore;
    const storeId = storeName === undefined ? undefined : registry.value.stores?.[storeName];
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
      ...(args.allow === undefined ? {} : { allow: args.allow }),
      ...(storeId === undefined ? {} : { storeId }),
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
    // A plan with blockers its --allow leaves (D50) is a refusal that still shows the plan (D38): exit 6, the plan as
    // data (D14).
    const blocker = planBlocker(planned.value);
    return blocker === undefined ? ok(planned.value) : failWith(blocker, planned.value, 6);
  },
});
