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
const SHOWN_IGNORED = 5;

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
  // Without git, nothing says what is gitignored: say that all of it travels (HANDOFF, carried into M2).
  if (plan.git === false)
    lines.push(row("git", "not a git repository: every file travels except stripped dependency folders"));
  if (plan.strip.length > 0)
    lines.push(row("strip", plan.strip.map((s) => `${s.path} ${formatBytes(s.bytes)}`).join(" · ")));
  if (plan.include.largest.length > 0) {
    const largest = plan.include.largest.slice(0, SHOWN_LARGEST);
    lines.push(row("largest", largest.map((l) => `${l.path} ${formatBytes(l.bytes)}`).join(" · ")));
  }
  // Gitignored does not mean disposable (AGENTS.md rule 2): say plainly that these travel.
  const ignored = plan.include.gitignored;
  if (ignored !== undefined) {
    const more = ignored.files - SHOWN_IGNORED;
    lines.push(
      row(
        "ignored",
        `${ignored.paths.length === 0 ? "none found" : ignored.paths.slice(0, SHOWN_IGNORED).join(" · ")}${more > 0 ? ` and ${more} more` : ""}: gitignored, and they travel; only what a plugin declares regenerable is stripped${ignored.incomplete === true ? " (incomplete: git could not be asked in every repository, so more may travel)" : ""}`,
      ),
    );
  }
  // An install that may not run at onload says so (D71).
  for (const a of plan.arrival ?? [])
    if (a.note !== undefined) lines.push(row("arrival", `${a.detail} at onload; ${a.note}`));
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

/** A real run's data: the offload done; or, with exit 8, the snapshot kept as a fork, or committed while the folder
 * changed after the commit (kind); or, with exit 6 for a plan that no longer holds, the fresh plan (D14, D38, D52). */
const OffloadOutputSchema = z.union([
  z.looseObject({
    op: z.string(),
    exitCode: z.literal(0),
    project: z.string(),
    snapshot: z.string(),
    freedBytes: z.int().nonnegative().meta({
      description:
        "Bytes freed now: the whole folder once its detached delete has started; 0 while the local copy is kept (offload.keepLocalFor) or waits for recover, and then keptBytes has them",
    }),
    keptBytes: z.int().nonnegative().optional().meta({
      description:
        "Bytes the local copy still holds in the trash: the whole folder while it is kept or waits for recover, else 0. They are freed by freedBy",
    }),
    freedBy: z.string().optional().meta({
      description:
        "With keptBytes: what frees them. plainport gc once keepUntil has passed (a write command's housekeeping also hands a due trash to a detached delete; plainport gc --now --yes frees it early), or plainport recover when the delete could not start",
    }),
    store: z.string(),
    stub: z.string().optional().meta({ description: "The .plainport stub left where the folder was" }),
    trash: z.string().optional().meta({
      description:
        "Where the folder was moved: kept there, or waiting there for recover. Absent when localCopy is deleted: it is already being deleted (D77)",
    }),
    localCopy: z.enum(["deleted", "kept", "waiting"]).optional().meta({
      description:
        "deleted: keepLocalFor is 0 and the folder's detached delete has started, so nothing is kept (freedBytes has it). kept: offload.keepLocalFor keeps it until keepUntil, and onload renames it back. waiting: the delete could not start; plainport recover deletes it",
    }),
    keepUntil: z.iso.datetime().optional().meta({
      description: "offload.keepLocalFor: the local copy is kept until then, and onload renames it back",
    }),
    deleteStarted: z.literal(true).optional().meta({
      description:
        "With localCopy deleted: the detached delete has started, nothing more. It checks the folder first (D87); a refusal (delete.guard-refused) keeps it, and status, ls, gc and the start of the next command name the reason and the way out",
    }),
  }),
  z
    .looseObject({
      op: z.string(),
      exitCode: z.literal(8),
      kind: z.enum(["fork", "diverged-after-commit"]).meta({
        description:
          "fork: the head moved during the upload; the snapshot is kept as a fork and the folder stays (catalog.head-moved). diverged-after-commit: the snapshot is committed and is the head, but the folder changed after the commit; it stays here with its edits and the next offload builds on the snapshot (offload.diverged-after-commit, D52)",
      }),
      project: z.string(),
      snapshot: z.string(),
      store: z.string(),
      stored: z.string().meta({ description: "The store's restic id for the snapshot" }),
    })
    .meta({
      description:
        "Exit 8: the snapshot is kept as a fork (the head moved), or committed as the head while the folder changed after the commit (kind tells them apart); the folder stays either way (D14, D52)",
    }),
  PlanSchema.meta({ description: "Exit 6 (plan.stale): the fresh plan to review and approve (D14, D38)" }),
]);

export const offload = defineCommand({
  name: "offload",
  summary:
    "Snapshot a project, verify it, then remove its folder: deleted at once, or kept for keepLocalFor until gc frees it",
  risk: "confirm",
  dryRun: { plan: PlanSchema, human: renderPlan },
  acceptsPlan: true,
  group: "projects",
  positionals: ["project"],
  args: z.strictObject({
    project: z
      .array(z.string())
      .min(1)
      .max(1, "one project per offload until bulk offload lands (D38)")
      .meta({ description: "An address (root:path), a unique name, a path, . or a stub; one for now" }),
    plan: z.string().optional().meta({
      description:
        "Run the plan a --dry-run saved, by its id, instead of --yes; it runs only while the folder still matches it (else plan.stale, exit 6)",
    }),
    "keep-deps": z.boolean().optional().meta({
      description:
        "Keep installed dependencies (node_modules) in the snapshot. Either way, gitignored files such as .env and local databases always travel; only what a plugin declares regenerable (node_modules, build output) is stripped",
    }),
    allow: z.array(z.string()).optional().meta({
      description: "Override an allowable blocker by its code, e.g. --allow git.locked (repeatable)",
    }),
  }),
  output: OffloadOutputSchema,
  examples: [
    {
      argv: ["offload", "work:clients/acme/web", "--dry-run"],
      summary: "Plan offloading a project; --plan <id> then runs that plan, instead of --yes",
    },
    { argv: ["offload", "work:clients/acme/web", "--yes"], summary: "Offload a project without a prompt" },
  ],
  human: (data) => {
    if ("fingerprint" in data) return renderPlan(data as Plan);
    if (data.exitCode === 8)
      return data.kind === "diverged-after-commit"
        ? `offloaded ${data.project} to ${data.store} as snapshot ${data.snapshot}, now its head; the folder changed after the commit, so it stays here with its edits, and the next offload builds on that snapshot`
        : `kept snapshot ${data.snapshot} (${data.stored.slice(0, 8)} in ${data.store}) as a fork of ${data.project}; the folder stays`;
    const kept = data.keptBytes === undefined ? "" : ` (${formatBytes(data.keptBytes)})`;
    return [
      `offloaded ${data.project} to ${data.store} as snapshot ${data.snapshot}; ${data.freedBy !== undefined ? "nothing freed yet" : data.deleteStarted === true ? `freeing ${formatBytes(data.freedBytes)}` : `freed ${formatBytes(data.freedBytes)}`}`,
      ...(data.stub === undefined ? [] : [`stub      ${data.stub}`]),
      ...(data.keepUntil !== undefined
        ? [
            `kept      ${data.trash}${kept} until ${data.keepUntil}; plainport gc frees it then (plainport gc --now --yes frees it early)`,
          ]
        : data.localCopy === "waiting"
          ? [`trash     ${data.trash}${kept} waits for plainport recover to delete it`]
          : [
              "deleting  the local copy in the background (keepLocalFor is 0); it is checked first, and plainport status says if it was kept",
            ]),
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
    let saved = true;
    try {
      await savePlan(ctx.io, paths, planned.value);
    } catch (error) {
      saved = false;
      // The preview stands without its file; only --plan <id> cannot find it.
      ctx.output.log(
        "warn",
        `the plan could not be saved under ${paths.plansDir} (${systemErrorCode(error)}), so --plan ${planned.value.id} will not find it; use --yes instead`,
      );
    }
    // A plan with blockers its --allow leaves (D50) is a refusal that still shows the plan (D38): exit 6, the plan as
    // data (D14).
    const blocker = planBlocker(planned.value);
    if (blocker !== undefined) return failWith(blocker, planned.value, 6);
    // The command that runs it, as the human plan prints it (agent smoke).
    return ok(
      saved
        ? {
            ...planned.value,
            next: {
              command: planCommand(planned.value),
              reason: `runs this plan instead of --yes, until ${planned.value.expiresAt}, while the folder still matches it`,
            },
          }
        : planned.value,
    );
  },
});
