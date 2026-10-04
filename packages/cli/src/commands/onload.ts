// plainport onload, hydrate and dehydrate (DESIGN.md "Onload process", "CLI design"). All three are safe_write: they
// change files only inside the roots, in ways plainport can regenerate (an onload lands only where nothing stands, and
// dehydrate removes only installed dependencies). onload is core's onload saga: restore, verify, swap, then the
// toolchain and the frozen install; a failed install exits 10 with the restored project and snapshot as the error's
// data (D14), and `plainport hydrate` retries. None has a preview yet, so --dry-run is refused (D18).

import { openEventMirror } from "@plainport/blob-fs";
import { ok } from "@plainport/contract";
import {
  ConfigLoader,
  expandHome,
  resolveProject,
  runDehydrate,
  runHydrate,
  runOnload,
} from "@plainport/core";
import { z } from "zod";
import { type CommandContext, defineCommand } from "../registry.ts";
import { thisDevice } from "./local.ts";
import { formatBytes } from "./offload.ts";

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
    }),
  ),
  untrusted: z.array(z.string()).meta({
    description:
      "What the project's .plainport.toml asks to run (hydrate.command, hooks.<name>) and was skipped: it runs only after plainport trust (D54)",
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

const installs = (report: z.output<typeof HydrateReportSchema>): string =>
  report.steps.map((s) => (s.path === "" ? s.command : `${s.command} in ${s.path}`)).join(", ");

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
  dryRun: false,
  acceptsPlan: false,
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
        "Files only, exactly as stored. Without --no-hydrate, the install (e.g. npm ci) usually needs the network; if it fails the files stay restored, the project is restored-unhydrated, onload exits 10 (hydrate.failed) and plainport hydrate <project> retries",
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
            `skipped   ${hydrate.untrusted.join(", ")} from .plainport.toml (untrusted: runs only after plainport trust)`,
          ]),
    ].join("\n");
  },
  handler: async (args, ctx) => {
    const found = await project(ctx, args.project);
    if (!found.ok) return found;
    const { paths, device, ref } = found.value;
    const release = ctx.holdSignal();
    try {
      const done = await runOnload(
        {
          host: ctx.system,
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
          ...(args.to === undefined ? {} : { to: expandHome(args.to, paths.home, ctx.cwd) }),
          ...(args.snapshot === undefined ? {} : { snapshot: args.snapshot }),
          ...(args["no-hydrate"] === true ? { hydrate: false } : {}),
          ...(ctx.store === undefined ? {} : { store: ctx.store }),
        },
      );
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
