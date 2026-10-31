// plainport resolve <project> --keep <snapshot> (confirm; M2 Task 25, Q18): settles a conflict by appending one
// resolved event to a format-2 store, made from a fresh read by core's resolve saga. Read-only inspection of the
// heads is `status`; the other copy, readable in git, is `compare`. (The project-argument resolver every command
// shares is ./resolve.ts.)

import { openEventMirror } from "@plainport/blob-fs";
import { ok } from "@plainport/contract";
import { ConfigLoader, runResolve } from "@plainport/core";
import { z } from "zod";
import { defineCommand } from "../registry.ts";
import { knownProjects, resolveKnown } from "./resolve.ts";

export const resolveConflict = defineCommand({
  name: "resolve",
  summary:
    "Settle a conflict: keep one live tip over the others, from a fresh read (a resolved event; format-2 stores only)",
  risk: "confirm",
  dryRun: false,
  acceptsPlan: false,
  group: "projects",
  positionals: ["project"],
  args: z.strictObject({
    project: z
      .string()
      .meta({ description: "An address (root:path), a unique name, a path or its .plainport stub" }),
    keep: z.string().meta({
      description:
        "The snapshot to keep: one of the live tips plainport status lists (each one's device, time, size and base). While this device holds a working copy, the copy's own snapshot. The others stay in the store: plainport restore --snapshot reads them, and a copy on one offloads as live work that conflicts again",
    }),
  }),
  output: z
    .looseObject({
      op: z.string(),
      project: z.string().meta({ description: "root:path" }),
      store: z.string().meta({ description: "The store whose catalog holds it" }),
      keep: z.string(),
      outcome: z.enum(["resolved", "nothing-to-resolve"]).meta({
        description:
          "resolved: a resolved event was appended. nothing-to-resolve: the project is not conflicted and has one live tip, so nothing was written (a re-run of a resolve that landed ends here)",
      }),
      head: z
        .string()
        .nullable()
        .meta({ description: "The head now: keep once resolved; the one live tip with nothing to resolve" }),
      event: z.string().optional().meta({ description: "resolved: the resolved event's id" }),
      over: z.array(z.string()).optional().meta({
        description:
          "resolved: the snapshots it rejects; they stay in the store, and restore --snapshot reads them",
      }),
      supersedes: z
        .array(z.string())
        .optional()
        .meta({ description: "resolved: the active resolutions it replaces" }),
    })
    .meta({ description: "The resolution appended, or that there was nothing to resolve" }),
  examples: [
    {
      argv: ["resolve", "work:clients/acme/api", "--keep", "01K7Q2VJ4ZQ8N6X3M5R2T9W1YB", "--yes"],
      summary:
        "Keep one live tip of a conflicted project (plainport status lists them); the others stay restorable by their snapshot. Not conflicted: nothing to resolve",
    },
  ],
  human: (data) =>
    data.outcome === "nothing-to-resolve"
      ? `nothing to resolve: ${data.project} is not conflicted${data.head === null ? "" : `; its head is ${data.head}`}`
      : `resolved ${data.project}: kept ${data.keep} over ${(data.over ?? []).join(", ")}${(data.supersedes ?? []).length === 0 ? "" : `, replacing resolution ${(data.supersedes ?? []).join(", ")}`}; the others stay in store ${data.store}, readable with plainport restore --snapshot`,
  handler: async (args, ctx) => {
    const known = await knownProjects(ctx);
    if (!known.ok) return known;
    const { paths, device } = known.value;
    const named = await resolveKnown(ctx, known.value, args.project, "resolve");
    if (!named.ok) return named;
    const release = ctx.holdSignal();
    try {
      const done = await runResolve(
        {
          host: ctx.system,
          paths,
          device,
          env: ctx.env,
          loader: new ConfigLoader(ctx.io, paths),
          opener: ctx.stores,
          openMirror: (storeId) => openEventMirror(ctx.io, paths, storeId),
          emit: (event) => ctx.output.emit(event),
          log: (level, message) => ctx.output.log(level, message),
          now: () => ctx.clock.now(),
        },
        {
          project: named.value.ref,
          keep: args.keep,
          ...(ctx.store === undefined ? {} : { store: ctx.store }),
        },
      );
      return done.ok ? ok(done.value) : done;
    } finally {
      release();
    }
  },
});
