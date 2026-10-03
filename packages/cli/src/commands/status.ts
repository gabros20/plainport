// plainport ls and plainport status (DESIGN.md "CLI design", "Project lifecycle"): what this device knows of its
// projects, from its registry and the catalog of every store it set up (core's projectViews). Both are read: the
// catalog is read through the one read path, which only downloads into this device's mirror and never writes to a
// store (D45); an unreachable store is read from the mirror, marked stale, or never synced.

import { openEventMirror } from "@plainport/blob-fs";
import { ok, ProjectStateSchema, shellWord } from "@plainport/contract";
import {
  ConfigLoader,
  findView,
  type ProjectStatus,
  projectViews,
  resolveProject,
  type Views,
} from "@plainport/core";
import { z } from "zod";
import { type CommandContext, defineCommand } from "../registry.ts";
import { thisDevice } from "./local.ts";
import { formatBytes } from "./offload.ts";

export const ProjectStatusSchema = z
  .looseObject({
    address: z.string().meta({ description: "root:path" }),
    root: z.string(),
    path: z.string(),
    id: z.string().meta({ description: "The project's ULID" }),
    state: ProjectStateSchema.meta({
      description:
        "The project's one lifecycle state on this device: unavailable (its root's volume is not mounted), offloading or onloading (a journal is open), conflicted, restored-unhydrated, local or shelved",
    }),
    conditions: z.array(z.string()).meta({
      description:
        "What needs attention, an open set: incomplete (the catalog names snapshots it does not hold, so it has no head), diverged-after-commit (committed, but the folder stayed here with later edits, D51), head-moved, interrupted or running (the open journal), folder-missing, stale, never-synced",
    }),
    dir: z.string().optional().meta({ description: "Its folder on this device" }),
    here: z.boolean().meta({ description: "The folder is on this device" }),
    stub: z.string().optional().meta({ description: "Its .plainport stub, when one is here" }),
    store: z.string().optional().meta({ description: "The store whose catalog holds it" }),
    head: z.string().nullable().meta({ description: "The catalog's head; null when there is none" }),
    base: z.string().optional().meta({ description: "The snapshot this device's copy came from" }),
    lease: z
      .looseObject({ device: z.string(), at: z.string(), base: z.string(), here: z.boolean() })
      .optional()
      .meta({ description: "The device whose onload holds the lease, and whether it is this one" }),
    snapshots: z.int().nonnegative(),
    bytes: z.int().nonnegative().optional().meta({ description: "Files' bytes in the head snapshot" }),
    strippedBytes: z
      .int()
      .nonnegative()
      .optional()
      .meta({ description: "Dependencies the head's offload stripped, which an onload installs again" }),
    lastActivity: z.string().optional(),
    stale: z
      .boolean()
      .meta({ description: "The catalog was read from this device's mirror: the store did not answer" }),
    syncedAt: z
      .string()
      .optional()
      .meta({ description: "When the catalog last came from the store; absent: never" }),
    journal: z
      .looseObject({
        op: z.string(),
        kind: z.enum(["offload", "onload"]),
        step: z.string(),
        running: z.boolean(),
      })
      .optional()
      .meta({ description: "Its open journal; when not running, plainport recover settles it" }),
  })
  .meta({ description: "A project as this device sees it" });

const StoreStatusSchema = z.looseObject({
  name: z.string(),
  id: z.string().optional(),
  stale: z.boolean(),
  syncedAt: z.string().optional(),
  finding: z.looseObject({ code: z.string(), message: z.string() }).optional(),
});

/** The views, from this device's state and its stores' catalogs. */
const views = async (ctx: CommandContext) => {
  const local = await thisDevice(ctx);
  if (!local.ok) return local;
  const { paths, device } = local.value;
  const read = await projectViews({
    io: ctx.io,
    paths,
    env: ctx.env,
    device,
    loader: new ConfigLoader(ctx.io, paths),
    opener: ctx.stores,
    openMirror: (storeId) => openEventMirror(ctx.io, paths, storeId),
    now: () => ctx.clock.now(),
  });
  if (!read.ok) return read;
  return ok({ ...local.value, views: read.value });
};

const stateText = (p: z.output<typeof ProjectStatusSchema>): string =>
  p.conditions.length === 0 ? p.state : `${p.state} (${p.conditions.join(", ")})`;

const freshness = (p: {
  stale: boolean;
  syncedAt?: string | undefined;
  store?: string | undefined;
}): string =>
  !p.stale
    ? `store ${p.store ?? "?"}, synced`
    : p.syncedAt === undefined
      ? `store ${p.store ?? "?"} not reached, never synced`
      : `store ${p.store ?? "?"} not reached; stale, last synced ${p.syncedAt}`;

/** What to do next for a project in this state. */
const nextStep = (p: z.output<typeof ProjectStatusSchema>): string | undefined => {
  const address = shellWord(p.address);
  if (p.journal !== undefined && !p.journal.running) return "plainport recover";
  if (p.conditions.includes("diverged-after-commit"))
    return `keep working in the folder; plainport offload ${address} --yes builds on snapshot ${p.head}`;
  if (p.conditions.includes("incomplete"))
    return "connect the store that holds every snapshot, or plainport doctor";
  if (p.state === "conflicted")
    return `plainport resolve ${address} (M2); plainport restore ${address} --snapshot <id> --to <path> reads either copy`;
  if (p.state === "restored-unhydrated") return `plainport hydrate ${address}`;
  if (p.state === "shelved") return `plainport onload ${address}`;
  if (p.state === "unavailable") return "mount the volume its root lives on";
  return undefined;
};

const LABEL = 9;
const row = (label: string, text: string): string => `  ${label.padEnd(LABEL)}${text}`;

export const renderStatus = (p: z.output<typeof ProjectStatusSchema>): string => {
  const lines = [`${p.address}  ${stateText(p)}`];
  if (p.dir !== undefined)
    lines.push(
      row(
        "folder",
        `${p.dir}${p.here ? "" : " (not here)"}${p.stub === undefined ? "" : `, stub ${p.stub}`}`,
      ),
    );
  lines.push(
    row(
      "head",
      p.head === null
        ? "none"
        : `${p.head}${p.bytes === undefined ? "" : ` · ${formatBytes(p.bytes)}`}${
            p.strippedBytes === undefined || p.strippedBytes === 0
              ? ""
              : ` (+ ${formatBytes(p.strippedBytes)} of dependencies)`
          } · ${p.snapshots} snapshot${p.snapshots === 1 ? "" : "s"}`,
    ),
  );
  if (p.base !== undefined) lines.push(row("base", p.base));
  lines.push(
    row(
      "lease",
      p.lease === undefined
        ? "none"
        : `${p.lease.here ? "this device" : `device ${p.lease.device}`} since ${p.lease.at}`,
    ),
  );
  lines.push(row("catalog", freshness(p)));
  if (p.journal !== undefined)
    lines.push(
      row(
        "journal",
        `${p.journal.kind} ${p.journal.op} ${p.journal.running ? "running" : "interrupted"} at ${p.journal.step}`,
      ),
    );
  const next = nextStep(p);
  if (next !== undefined) lines.push(row("next", next));
  return lines.join("\n");
};

export const status = defineCommand({
  name: "status",
  summary: "One project in detail: its state, head, lease and what to do next",
  risk: "read",
  dryRun: false,
  acceptsPlan: false,
  positionals: ["project"],
  args: z.strictObject({
    project: z.string().optional().meta({
      description: "An address (root:path), a unique name, a path or its .plainport stub; default .",
    }),
  }),
  output: ProjectStatusSchema,
  examples: [
    {
      argv: ["status", "work:clients/acme/api"],
      summary: "A shelved project's head and how to bring it back",
    },
  ],
  human: renderStatus,
  handler: async (args, ctx) => {
    const read = await views(ctx);
    if (!read.ok) return read;
    const { paths, device } = read.value;
    const resolved = await resolveProject(ctx.io, paths, args.project ?? ".", {
      cwd: ctx.cwd,
      env: ctx.env,
      device: device.name,
    });
    if (!resolved.ok) return resolved;
    return findView(read.value.views, resolved.value);
  },
});

const LOCAL_STATES: ReadonlySet<string> = new Set(["local", "restored-unhydrated", "onloading"]);

const lsRow = (p: ProjectStatus, width: number): string => {
  const device = p.lease === undefined ? "-" : p.lease.here ? "here" : p.lease.device.slice(0, 10);
  const size = p.bytes === undefined ? "-" : formatBytes(p.bytes);
  const when = p.lastActivity === undefined ? "-" : p.lastActivity.slice(0, 10);
  return `${p.address.padEnd(width)}  ${stateText(p).padEnd(24)}  ${device.padEnd(10)}  ${size.padStart(8)}  ${when}`;
};

export const ls = defineCommand({
  name: "ls",
  summary: "Every project with its root, state, device, size and last activity",
  risk: "read",
  dryRun: false,
  acceptsPlan: false,
  positionals: [],
  args: z.strictObject({
    root: z.string().optional().meta({ description: "Only this root's projects" }),
    local: z.boolean().optional().meta({ description: "Only projects whose folder is on this device" }),
    shelved: z.boolean().optional().meta({ description: "Only shelved projects" }),
    sort: z
      .enum(["size", "age"])
      .optional()
      .meta({ description: "size: largest first; age: least recently used first" }),
  }),
  output: z
    .looseObject({
      projects: z.array(ProjectStatusSchema),
      stores: z
        .array(StoreStatusSchema)
        .meta({ description: "Each store's catalog: stale when it did not answer" }),
    })
    .meta({ description: "The projects, and how fresh each store's catalog is" }),
  examples: [
    { argv: ["ls"], summary: "Every project this device knows" },
    { argv: ["ls", "--shelved", "--sort", "size"], summary: "Shelved projects, largest first" },
  ],
  human: (data) => {
    if (data.projects.length === 0)
      return "no projects yet: plainport root scan <root> registers a root's projects";
    const width = Math.max(...data.projects.map((p) => p.address.length));
    const stale = data.stores.filter((s) => s.stale);
    return [
      ...data.projects.map((p) => lsRow(p as ProjectStatus, width)),
      ...stale.map(
        (s) =>
          `store ${s.name}: ${s.syncedAt === undefined ? "not reached, never synced" : `not reached; stale, last synced ${s.syncedAt}`}`,
      ),
    ].join("\n");
  },
  handler: async (args, ctx) => {
    const read = await views(ctx);
    if (!read.ok) return read;
    const all: Views = read.value.views;
    let projects = all.projects.filter(
      (p) =>
        (args.root === undefined || p.root === args.root) &&
        (args.local !== true || (p.here && LOCAL_STATES.has(p.state))) &&
        (args.shelved !== true || p.state === "shelved"),
    );
    if (args.sort === "size") projects = [...projects].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
    if (args.sort === "age")
      projects = [...projects].sort((a, b) => (a.lastActivity ?? "").localeCompare(b.lastActivity ?? ""));
    for (const f of all.findings) ctx.output.log("warn", `${f.code}: ${f.message}`);
    return ok({ projects, stores: all.stores });
  },
});
