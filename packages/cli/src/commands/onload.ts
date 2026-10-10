// plainport onload, hydrate and dehydrate (DESIGN.md "Onload process", "CLI design"). All three are safe_write: they
// change files only inside the roots, in ways plainport can regenerate (an onload lands only where nothing stands, and
// dehydrate removes only installed dependencies). onload is core's onload saga: restore, verify, swap, then the
// toolchain and the frozen install; a failed install exits 10 with the restored project and snapshot as the error's
// data (D14), and `plainport hydrate` retries. onload --dry-run (always read, D18) previews the onload and writes
// nothing, not even a plan: it says whether the folder is renamed back or restored, the snapshot and the head it goes
// over, the landing folder, the space and the install; a block finding exits 6 (the lease under strict, 8) with the
// preview as the error's data (D14, D38, D71). hydrate and dehydrate have no preview, so --dry-run is refused for them.

import { openEventMirror } from "@plainport/blob-fs";
import { FindingSchema, ok, type StreamEvent } from "@plainport/contract";
import {
  ConfigLoader,
  expandHome,
  previewOnload,
  resolveProject,
  runDehydrate,
  runHydrate,
  runOnload,
} from "@plainport/core";
import { z } from "zod";
import { type CommandContext, defineCommand } from "../registry.ts";
import { thisDevice } from "./local.ts";
import { formatBytes, row } from "./offload.ts";

const HydrateReportSchema = z.looseObject({
  status: z.enum(["installed", "failed", "skipped", "reused", "none"]).meta({
    description:
      "installed: every install succeeded. failed: one failed (restored-unhydrated, exit 10). skipped: --no-hydrate. reused: the folder came back with its dependencies. none: nothing to install",
  }),
  steps: z.array(
    z.looseObject({
      path: z.string().meta({ description: 'The install root, relative to the project; "" is the project' }),
      command: z.string().meta({ description: "The frozen install, e.g. npm ci" }),
      ok: z.boolean(),
      exitCode: z.int().nullable().optional(),
      via: z.literal("corepack").optional().meta({
        description:
          "Corepack supplied the package manager; installs run with its download prompt and auto-pin off",
      }),
    }),
  ),
  untrusted: z.array(z.string()).meta({
    description:
      "What the project's .plainport.toml asks to run (hydrate.command, hooks.<name>) and was skipped: it runs only once a later milestone lets a project be trusted (D54)",
  }),
  reason: z.string().optional().meta({
    description:
      "Why nothing was installed. With reused: the folder came back with the dependencies it had when it was offloaded. With skipped: the offload stripped nothing, so the restored files are the whole folder and the project is local, not restored-unhydrated",
  }),
});

const OnloadOutputSchema = z
  .looseObject({
    op: z.string(),
    exitCode: z.union([z.literal(0), z.literal(10)]).meta({
      description: "10: the files are restored but the install failed; this is then the error's data (D14)",
    }),
    project: z.string(),
    snapshot: z.string().meta({ description: "The snapshot restored" }),
    over: z.string().meta({
      description: "The head the onload was written over; the copy's next offload builds on it (D43)",
    }),
    store: z.string(),
    dir: z.string().meta({ description: "Where the project now is" }),
    restored: z.enum(["restore", "reuse"]).meta({
      description:
        "restore: restored from the store. reuse: nothing was restored; the folder the offload of this same head released was still kept (offload.keepLocalFor) and unchanged since it was verified, so it was renamed back from the trash (see reused). To restore from the store instead, plainport gc --now --yes deletes the kept copy first; --to and an older --snapshot always restore from the store",
    }),
    reused: z
      .looseObject({
        from: z
          .string()
          .meta({ description: "The trash folder renamed back: <root>/.plainport-trash/<op>/<name>" }),
        offload: z
          .string()
          .meta({ description: "The offload that released it; its trash and journal are gone now" }),
        reason: z
          .string()
          .meta({ description: "Why it was renamed back instead of restored from the store" }),
      })
      .optional()
      .meta({ description: "Only with restored: reuse" }),
    files: z.int().nonnegative(),
    bytes: z.int().nonnegative(),
    hydrate: HydrateReportSchema,
  })
  .meta({ description: "The project onloaded; with exit 10, restored but not hydrated (D14)" });

const OnloadPreviewSchema = z
  .looseObject({
    kind: z.literal("onload"),
    project: z.string(),
    store: z.string(),
    snapshot: z.string().meta({ description: "The snapshot that would be restored" }),
    over: z.string().meta({ description: "The head it would be written over; the copy's next base (D43)" }),
    dir: z.string().meta({ description: "Where the project would land" }),
    restored: z.enum(["restore", "reuse"]).meta({
      description:
        "reuse: the folder offload released is still kept (offload.keepLocalFor) and unchanged, so it is renamed back from the trash and nothing is restored or installed. restore: restored from the store",
    }),
    why: z.string().meta({ description: "Why it is one or the other" }),
    reused: z
      .looseObject({ from: z.string(), offload: z.string(), reason: z.string() })
      .optional()
      .meta({ description: "Only with restored: reuse: the trash folder and the offload that released it" }),
    files: z.int().nonnegative(),
    bytes: z.int().nonnegative(),
    space: z.looseObject({ needed: z.int().nonnegative(), free: z.int().nonnegative() }).meta({
      description:
        "Bytes the restore needs on the landing volume (the snapshot, the dependencies the install puts back, per-file rounding and a 10% margin; 0 for a reuse) and the bytes free there",
    }),
    findings: z.array(FindingSchema).meta({
      description:
        "What preflight reports. A block finding refuses the onload: this is then the error's data and the exit code is the finding's (6; 8 for lease.held under leases = strict)",
    }),
    hydrate: z.looseObject({
      status: z.enum(["install", "reused", "skipped", "none"]).meta({
        description:
          "install: these frozen installs run after the restore. reused: the folder comes back with its dependencies. skipped: --no-hydrate or onload.hydrate = false. none: nothing to install",
      }),
      reason: z.string().optional(),
      steps: z.array(
        z.looseObject({
          path: z
            .string()
            .meta({ description: 'The install root, relative to the project; "" is the project' }),
          command: z.string().meta({ description: "The frozen install, e.g. npm ci" }),
          packageManager: z.string(),
          via: z.literal("corepack").optional().meta({
            description:
              "Corepack supplies the package manager; installs run with its download prompt and auto-pin off",
          }),
        }),
      ),
      toolchain: z
        .looseObject({
          pinnedBy: z.array(z.string()).meta({
            description:
              "Version files in the snapshot (.nvmrc, .node-version, .tool-versions, mise.toml): the pinned versions are read after the restore",
          }),
          manager: z.string().optional().meta({
            description:
              "The version manager on PATH (mise, fnm or volta) that would activate the pinned node",
          }),
        })
        .optional(),
      untrustedKnown: z.literal(false).meta({
        description:
          "Always false: what the project's .plainport.toml asks to run (and this version never runs, D54) is read after the restore, so the preview has no untrusted list; absent is not the same as none",
      }),
    }),
    pending: z
      .looseObject({
        op: z.string(),
        step: z.string(),
        action: z.enum(["resume", "roll-back"]),
      })
      .optional()
      .meta({
        description:
          "An earlier onload of this project stopped before its swap and left a journal: the run resumes it (same snapshot and folder) or rolls it back first",
      }),
  })
  .meta({ description: "What an onload would do (--dry-run): nothing was written (D71)" });

const installs = (report: z.output<typeof HydrateReportSchema>): string =>
  report.steps
    .map(
      (s) =>
        `${s.path === "" ? s.command : `${s.command} in ${s.path}`}${s.via === "corepack" ? " via Corepack" : ""}`,
    )
    .join(", ");

/** The preview as a person reads it: the onload's target, where it lands, what it needs, the install, the findings. */
const renderPreview = (preview: z.output<typeof OnloadPreviewSchema>): string => {
  const lines = [
    `${preview.project} ← ${preview.store}, snapshot ${preview.snapshot}${preview.over === preview.snapshot ? "" : ` over ${preview.over}`}`,
  ];
  lines.push(row("into", preview.dir));
  if (preview.pending !== undefined)
    lines.push(
      row(
        "pending",
        `an onload stopped at ${preview.pending.step} (${preview.pending.op}); this one ${preview.pending.action === "resume" ? "resumes it" : "rolls it back first"}`,
      ),
    );
  if (preview.reused !== undefined) {
    lines.push(row("reuse", `renamed back from ${preview.reused.from}; ${preview.reused.reason}`));
    lines.push(
      row("install", "nothing would be restored or installed: the folder keeps the dependencies it had"),
    );
  } else {
    lines.push(
      row(
        "restore",
        `from the store: ${preview.files.toLocaleString("en-US")} file${preview.files === 1 ? "" : "s"} · ${formatBytes(preview.bytes)}; ${preview.why}`,
      ),
    );
    lines.push(
      row(
        "space",
        `needs about ${formatBytes(preview.space.needed)}, ${formatBytes(preview.space.free)} free`,
      ),
    );
    const { hydrate } = preview;
    if (hydrate.status === "install") {
      for (const step of hydrate.steps)
        lines.push(
          row(
            "install",
            `${step.path === "" ? step.command : `${step.command} in ${step.path}`} (${step.packageManager}${step.via === "corepack" ? " via Corepack" : ""})`,
          ),
        );
      const tool = hydrate.toolchain;
      if (tool !== undefined && tool.pinnedBy.length > 0)
        lines.push(
          row(
            "toolchain",
            `${tool.pinnedBy.join(", ")} pin${tool.pinnedBy.length === 1 ? "s" : ""} versions${tool.manager === undefined ? "; no version manager (mise, fnm, Volta) is on PATH, so the active versions are compared" : `; ${tool.manager} activates them`}`,
          ),
        );
    } else {
      lines.push(row("install", `none: ${hydrate.reason ?? hydrate.status}`));
    }
  }
  for (const f of preview.findings) {
    // A refusal's fix is printed with the failure itself (stderr), so it is not repeated here.
    lines.push(row(f.severity, `${f.code}  ${f.message}`));
  }
  return lines.join("\n");
};

const env = (ctx: CommandContext) => ctx.env;

/** The project named on the command line, on this device. */
const project = async (ctx: CommandContext, input: string) => {
  const local = await thisDevice(ctx);
  if (!local.ok) return local;
  const { paths, device } = local.value;
  const resolved = await resolveProject(ctx.io, paths, input, {
    cwd: ctx.cwd,
    env: env(ctx),
    device: device.name,
  });
  if (!resolved.ok) return resolved;
  return ok({ paths, device, ref: resolved.value });
};

export const onload = defineCommand({
  name: "onload",
  summary: "Restore a shelved project into place and reinstall its dependencies",
  risk: "safe_write",
  dryRun: { plan: OnloadPreviewSchema, human: renderPreview },
  acceptsPlan: false,
  group: "projects",
  positionals: ["project"],
  args: z.strictObject({
    project: z
      .string()
      .meta({ description: "An address (root:path), a unique name, a path or its .plainport stub" }),
    to: z.string().optional().meta({
      description: "Land it in this folder instead of its root's place; always restored from the store",
    }),
    snapshot: z.string().optional().meta({
      description:
        "Restore this snapshot from the store instead of the head; naming the head itself still reuses a kept local copy",
    }),
    "no-hydrate": z.boolean().optional().meta({
      description:
        "Restore the files without installing dependencies: the restored tree stays exactly as stored, and no network is needed; a reused kept copy has its dependencies either way",
    }),
  }),
  output: OnloadOutputSchema,
  examples: [
    {
      argv: ["onload", "work:clients/acme/api"],
      summary:
        "Bring a shelved project back. While offload.keepLocalFor keeps its folder, onloading the head renames that folder back instead (restored: reuse, nothing installed); plainport gc --now --yes deletes the kept copy first, so onload restores from the store; plainport restore --to <path> checks the stored snapshot side by side",
    },
    {
      argv: ["onload", "work:clients/acme/api", "--no-hydrate"],
      summary:
        "Files only, exactly as stored. Without --no-hydrate, the install (e.g. npm ci) usually needs the network; if it fails the files stay restored, the project is restored-unhydrated, onload exits 10 (hydrate.failed) and plainport hydrate <project> retries. The install runs package scripts without PLAINPORT_*, RESTIC_*, RCLONE_* or any variable an env: secret in the config names, so no store password reaches them",
    },
    {
      argv: ["onload", "work:clients/acme/api", "--dry-run"],
      summary:
        "Preview it and write nothing: whether the kept folder is renamed back (restored: reuse) or restored from the store, the snapshot and the head it goes over, the landing folder, the space needed, the findings and the installs. A block finding (an occupied path, too little space) exits 6 with the preview as data; lease.held is a warning, or a block under leases = strict",
    },
    {
      argv: ["onload", "work:clients/acme/api", "--to", "~/Developer/api", "--no-hydrate"],
      summary: "Land it elsewhere, files only",
    },
  ],
  human: (data) => {
    const from = `${data.project} from snapshot ${data.snapshot} into ${data.dir}`;
    const { hydrate, reused } = data;
    if (reused !== undefined && data.exitCode === 0) {
      return [
        `onloaded ${data.project} into ${data.dir}: renamed back from ${reused.from}, not restored from the store (${reused.reason})`,
        "dependencies came back with the folder, so nothing was installed",
      ].join("\n");
    }
    if (data.exitCode === 10) {
      const failed = hydrate.steps.find((s) => !s.ok);
      return `restored ${from}; ${failed?.command ?? "the install"} failed, so its dependencies are not installed: plainport hydrate ${data.project} retries`;
    }
    const deps =
      hydrate.status === "installed"
        ? `dependencies installed (${installs(hydrate)})`
        : hydrate.status === "reused"
          ? "its folder came back from the trash with its dependencies"
          : hydrate.status === "skipped"
            ? hydrate.reason !== undefined
              ? `nothing installed: ${hydrate.reason}`
              : `dependencies not installed: plainport hydrate ${data.project} installs them`
            : "nothing to install";
    return [
      `onloaded ${from}; ${deps}`,
      ...(hydrate.untrusted.length === 0
        ? []
        : [
            `skipped   ${hydrate.untrusted.join(", ")} from .plainport.toml (untrusted: this version never runs it)`,
          ]),
    ].join("\n");
  },
  handler: async (args, ctx) => {
    const found = await project(ctx, args.project);
    if (!found.ok) return found;
    const { paths, device, ref } = found.value;
    const request = {
      project: ref,
      ...(args.to === undefined ? {} : { to: expandHome(args.to, paths.home, ctx.cwd) }),
      ...(args.snapshot === undefined ? {} : { snapshot: args.snapshot }),
      ...(args["no-hydrate"] === true ? { hydrate: false } : {}),
      ...(ctx.store === undefined ? {} : { store: ctx.store }),
    };
    const deps = {
      host: ctx.system,
      plugins: ctx.plugins,
      paths,
      device,
      env: ctx.env,
      loader: new ConfigLoader(ctx.io, paths),
      opener: ctx.stores,
      openMirror: (storeId: string) => openEventMirror(ctx.io, paths, storeId),
      emit: (event: StreamEvent) => ctx.output.emit(event),
      log: (level: "debug" | "info" | "warn", message: string) => ctx.output.log(level, message),
      signal: ctx.signal,
      now: () => ctx.clock.now(),
    };
    // --dry-run previews: it takes no lock, writes no plan and stops nothing, so it needs no signal hold (D71).
    if (ctx.dryRun) return previewOnload(deps, request);
    const release = ctx.holdSignal();
    try {
      const done = await runOnload(deps, request);
      return done.ok ? ok({ ...done.value, exitCode: 0 as const }) : done;
    } finally {
      release();
    }
  },
});

export const hydrate = defineCommand({
  name: "hydrate",
  summary: "Install a project's dependencies again with its own package manager (frozen)",
  risk: "safe_write",
  dryRun: false,
  acceptsPlan: false,
  group: "projects",
  positionals: ["project"],
  args: z.strictObject({
    project: z.string().meta({ description: "An address (root:path), a unique name, a path or ." }),
  }),
  output: z
    .looseObject({
      op: z.string(),
      exitCode: z.union([z.literal(0), z.literal(10)]),
      project: z.string(),
      dir: z.string(),
      hydrate: HydrateReportSchema,
    })
    .meta({ description: "The installs run; with exit 10, the one that failed (D14)" }),
  examples: [{ argv: ["hydrate", "work:clients/acme/web"], summary: "Reinstall a project's dependencies" }],
  human: (data) =>
    data.exitCode === 10
      ? `${data.hydrate.steps.find((s) => !s.ok)?.command ?? "the install"} failed in ${data.dir}; the files are untouched`
      : data.hydrate.status === "none"
        ? `${data.project} has no dependencies to install`
        : `installed the dependencies of ${data.project} (${installs(data.hydrate)})`,
  handler: async (args, ctx) => {
    const found = await project(ctx, args.project);
    if (!found.ok) return found;
    const { paths, ref } = found.value;
    const release = ctx.holdSignal();
    try {
      return await runHydrate(
        {
          host: ctx.system,
          plugins: ctx.plugins,
          env: ctx.env,
          loader: new ConfigLoader(ctx.io, paths),
          paths,
          emit: (event) => ctx.output.emit(event),
          log: (level, message) => ctx.output.log(level, message),
          signal: ctx.signal,
          now: () => ctx.clock.now(),
        },
        { project: ref },
      );
    } finally {
      release();
    }
  },
});

export const dehydrate = defineCommand({
  name: "dehydrate",
  summary: "Remove a project's installed dependencies (only what a plugin claims and git does not track)",
  risk: "safe_write",
  dryRun: false,
  acceptsPlan: false,
  group: "projects",
  positionals: ["project"],
  args: z.strictObject({
    project: z.string().meta({ description: "An address (root:path), a unique name, a path or ." }),
  }),
  output: z.looseObject({
    op: z.string(),
    project: z.string(),
    dir: z.string(),
    removed: z.array(z.looseObject({ path: z.string(), bytes: z.int().nonnegative() })),
    freedBytes: z.int().nonnegative(),
  }),
  examples: [
    { argv: ["dehydrate", "work:clients/acme/web"], summary: "Free the space its node_modules takes" },
  ],
  human: (data) =>
    data.removed.length === 0
      ? `${data.project} has no installed dependencies to remove`
      : `removed ${data.removed.map((r) => r.path).join(", ")} from ${data.project}; freed ${formatBytes(data.freedBytes)}; plainport hydrate ${data.project} puts them back`,
  handler: async (args, ctx) => {
    const found = await project(ctx, args.project);
    if (!found.ok) return found;
    const { paths, ref } = found.value;
    const release = ctx.holdSignal();
    try {
      return await runDehydrate(
        {
          host: ctx.system,
          checks: ctx.checks,
          plugins: ctx.plugins,
          env: ctx.env,
          loader: new ConfigLoader(ctx.io, paths),
          paths,
          emit: (event) => ctx.output.emit(event),
          log: (level, message) => ctx.output.log(level, message),
          signal: ctx.signal,
          now: () => ctx.clock.now(),
        },
        { project: ref },
      );
    } finally {
      release();
    }
  },
});
