import { FindingSchema, ok, ProjectStateSchema } from "@plainport/contract";
import { PROJECT_CONDITIONS, type ProjectStatus } from "@plainport/core";
import { z } from "zod";
import { defineCommand } from "../registry.ts";
import { formatBytes } from "./offload.ts";
import { knownProjects, notKnown, resolveKnown } from "./resolve.ts";

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
        "What needs attention, an open set: incomplete (the catalog names snapshots it does not hold, so it has no head), diverged-after-commit (committed, but the folder stayed here with later edits, D51), head-moved, interrupted or running (the open journal), folder-missing, stale, never-synced, catalog-unreadable, journal-unreadable (a journal this version cannot read names it, or names no project)",
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
    gitWarnings: z
      .array(FindingSchema)
      .optional()
      .meta({ description: "status, for a project whose folder is here: the git findings a scan makes now" }),
    strippableBytes: z
      .int()
      .nonnegative()
      .optional()
      .meta({ description: "status, for a project whose folder is here: what an offload would strip now" }),
    journal: z
      .looseObject({
        op: z.string(),
        kind: z.enum(["offload", "onload"]),
        step: z.string(),
        running: z.boolean(),
      })
      .optional()
      .meta({ description: "Its newest open journal; when not running, plainport recover settles it" }),
    journals: z
      .array(
        z.looseObject({
          op: z.string(),
          kind: z.enum(["offload", "onload"]),
          step: z.string(),
          running: z.boolean(),
        }),
      )
      .meta({ description: "Every open journal of it, oldest first (the order recover settles them in)" }),
    trash: z
      .array(
        z.looseObject({
          op: z.string(),
          path: z.string(),
          keepUntil: z.string().optional(),
          deleting: z.boolean(),
          due: z
            .boolean()
            .meta({ description: "Past its keepUntil (or none): gc deletes it when nothing is deleting it" }),
        }),
      )
      .meta({
        description:
          "Released offloads' trash awaiting deletion: kept until keepUntil, or deleting while its detached delete runs (D64)",
      }),
    conditionDetails: z
      .array(
        z.looseObject({
          condition: z.string().meta({ description: `One of ${PROJECT_CONDITIONS.join(", ")}; an open set` }),
          message: z.string(),
          finding: FindingSchema.optional(),
        }),
      )
      .meta({ description: "One sentence per condition, with the finding behind it when there is one" }),
    next: z
      .looseObject({ command: z.string(), reason: z.string() })
      .optional()
      .meta({ description: "What to do next, when anything is to be done" }),
    unreadableJournals: z.array(z.string()).optional().meta({
      description:
        "Journals this version cannot read that name it, or name no project: they hold it back from offload and onload",
    }),
  })
  .meta({ description: "A project as this device sees it" });

const StoreStatusSchema = z.looseObject({
  name: z.string(),
  id: z.string().optional(),
  stale: z.boolean(),
  syncedAt: z.string().optional(),
  finding: z.looseObject({ code: z.string(), message: z.string() }).optional(),
});

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
  if (p.strippableBytes !== undefined)
    lines.push(row("strip", `${formatBytes(p.strippableBytes)} an offload would strip now`));
  for (const f of p.gitWarnings ?? []) lines.push(row(f.severity, `${f.code}  ${f.message}`));
  lines.push(
    row(
      "lease",
      p.lease === undefined
        ? "none"
        : `${p.lease.here ? "this device" : `device ${p.lease.device}`} since ${p.lease.at}`,
    ),
  );
  lines.push(row("catalog", freshness(p)));
  for (const j of p.journals)
    lines.push(row("journal", `${j.kind} ${j.op} ${j.running ? "running" : "interrupted"} at ${j.step}`));
  for (const path of p.unreadableJournals ?? [])
    lines.push(row("journal", `${path} cannot be read by this version of plainport`));
  for (const t of p.trash)
    lines.push(
      row(
        "trash",
        `${t.path} ${t.deleting ? "being deleted" : t.keepUntil === undefined ? "awaiting deletion" : `kept until ${t.keepUntil}`}`,
      ),
    );
  if (p.next !== undefined) lines.push(row("next", `${p.next.command}  (${p.next.reason})`));
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
    const known = await knownProjects(ctx);
    if (!known.ok) return known;
    const named = await resolveKnown(ctx, known.value, args.project ?? ".", "status");
    if (!named.ok) return named;
    if (named.value.known === undefined) return notKnown(named.value.ref);
    // Only this project's view is built, with its local details (D64 quality: views are lazy).
    for (const f of known.value.set.findings) ctx.output.log("warn", `${f.code}: ${f.message}`);
    return ok(await known.value.set.view(named.value.known.id, { detail: true }));
  },
});

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
      unreadableJournals: z.array(z.string()).meta({
        description:
          "Every journal this version cannot read: each holds its project back, or every project when it names none",
      }),
    })
    .meta({ description: "The projects, and how fresh each store's catalog is" }),
  examples: [
    { argv: ["ls"], summary: "Every project this device knows" },
    { argv: ["ls", "--shelved", "--sort", "size"], summary: "Shelved projects, largest first" },
  ],
  human: (data) => {
    const unreadable = data.unreadableJournals.map(
      (path) => `${path}: a journal this version of plainport cannot read; plainport recover reports it`,
    );
    if (data.projects.length === 0)
      return [
        "no projects yet: plainport offload <root>:<folder> works on any project folder under a root without registering it first; plainport root scan <root> lists and registers a root's projects",
        ...unreadable,
      ].join("\n");
    const width = Math.max(...data.projects.map((p) => p.address.length));
    const stale = data.stores.filter((s) => s.stale);
    return [
      ...data.projects.map((p) => lsRow(p as ProjectStatus, width)),
      ...stale.map(
        (s) =>
          `store ${s.name}: ${s.syncedAt === undefined ? "not reached, never synced" : `not reached; stale, last synced ${s.syncedAt}`}`,
      ),
      ...unreadable,
    ].join("\n");
  },
  handler: async (args, ctx) => {
    const read = await knownProjects(ctx);
    if (!read.ok) return read;
    const all = read.value.set;
    // Views only for the root asked for; the size column needs each folder's size (dependency folders not walked).
    const views: ProjectStatus[] = [];
    for (const known of all.known)
      if (args.root === undefined || known.root === args.root)
        views.push(await all.view(known.id, { sizes: true }));
    let projects = views.filter(
      (p) => (args.local !== true || p.here) && (args.shelved !== true || p.state === "shelved"),
    );
    if (args.sort === "size") projects = [...projects].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
    if (args.sort === "age")
      projects = [...projects].sort((a, b) => (a.lastActivity ?? "").localeCompare(b.lastActivity ?? ""));
    for (const f of all.findings) ctx.output.log("warn", `${f.code}: ${f.message}`);
    return ok({ projects, stores: all.stores, unreadableJournals: all.unreadableJournals });
  },
});
