// plainport recover, gc and restore (DESIGN.md "CLI design"; ADR-0008; D58, D59). All three are safe_write: recover
// rolls back what had not committed and finishes what had (only plainport's own journals, staging and trash change,
// besides the release a committed offload was already approved for); gc deletes released trash past its keepLocalFor
// deadline, and `gc --now` (confirm) before it; restore writes a snapshot side by side into a free path.

import { openEventMirror } from "@plainport/blob-fs";
import { ok, ProjectStateSchema } from "@plainport/contract";
import {
  ConfigLoader,
  collectTrash,
  expandHome,
  RECOVERY_OUTCOMES,
  recover as recoverJournals,
  runRestore,
} from "@plainport/core";
import { z } from "zod";
import { defineCommand } from "../registry.ts";
import { thisDevice } from "./local.ts";
import { formatBytes } from "./offload.ts";
import { knownProjects, resolveKnown } from "./resolve.ts";

const FindingDataSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
  fix: z.string().optional(),
});

const RecoveredSchema = z.looseObject({
  op: z.string(),
  kind: z.enum(["offload", "onload"]),
  project: z.string().meta({ description: "root:path" }),
  projectId: z.string(),
  step: z.string().meta({ description: "The journal step recover found" }),
  outcome: z.enum(RECOVERY_OUTCOMES).meta({
    description:
      "rolled-back: it had not committed, nothing local changed. finished: the release or the onload is done. forked: the snapshot is kept as a fork, the folder stays. diverged-after-commit: committed, but the folder changed since, so it was kept (D51). trash-deleted, trash-kept: a released offload's trash is gone, or waits for its keepLocalFor deadline. pending: not settled now (finding says why); recover can run again",
  }),
  state: ProjectStateSchema.meta({ description: "The project's state on this device afterwards" }),
  snapshot: z.string(),
  trash: z.string().optional(),
  keepUntil: z.string().optional(),
  finding: FindingDataSchema.optional(),
  conflict: z
    .looseObject({ kind: z.enum(["fork", "diverged-after-commit"]) })
    .optional()
    .meta({ description: "diverged-after-commit: exit 8's data, as offload gives it (D52)" }),
});

const OUTCOME_TEXT: Record<(typeof RECOVERY_OUTCOMES)[number], string> = {
  "rolled-back": "rolled back; nothing local had changed",
  finished: "finished",
  forked: "kept as a fork; the folder stays (conflicted)",
  "diverged-after-commit": "committed, but the folder changed since: it was kept, with no stub",
  "trash-deleted": "its trash was deleted",
  "trash-kept": "its trash is kept",
  pending: "not settled now",
};

export const recover = defineCommand({
  name: "recover",
  summary: "Settle interrupted operations: roll back what had not committed, finish what had",
  risk: "safe_write",
  dryRun: false,
  acceptsPlan: false,
  positionals: [],
  args: z.strictObject({}),
  output: z
    .looseObject({
      operations: z.array(RecoveredSchema),
      unreadable: z
        .array(z.string())
        .meta({ description: "Journal files this version cannot read: never touched" }),
    })
    .meta({
      description:
        "What recover did with each open journal. A failure carries this report as data, with the most severe code across every project (D64): 130 when Ctrl-C stopped it, then 8 (diverged-after-commit), 7, 6 (a pending or unreadable journal), 11 (a lock held), 9 (a store that did not answer), 5, 1",
    }),
  examples: [{ argv: ["recover"], summary: "Settle whatever was interrupted on this device" }],
  human: (data) =>
    data.operations.length === 0 && data.unreadable.length === 0
      ? "nothing to recover"
      : [
          ...data.operations.map(
            (o) =>
              `${o.kind} ${o.op} of ${o.project} (stopped at ${o.step}): ${OUTCOME_TEXT[o.outcome]}${
                o.keepUntil === undefined || o.outcome !== "trash-kept" ? "" : ` until ${o.keepUntil}`
              }${o.finding === undefined || o.outcome === "diverged-after-commit" ? "" : ` (${o.finding.code}: ${o.finding.message})`}; now ${o.state}`,
          ),
          ...data.unreadable.map((u) => `${u}: a journal this version cannot read; left as it is`),
        ].join("\n"),
  handler: async (_args, ctx) => {
    const local = await thisDevice(ctx);
    if (!local.ok) return local;
    const { paths, device } = local.value;
    const release = ctx.holdSignal();
    try {
      return await recoverJournals({
        host: ctx.system,
        paths,
        device,
        env: ctx.env,
        loader: new ConfigLoader(ctx.io, paths),
        opener: ctx.stores,
        openMirror: (storeId) => openEventMirror(ctx.io, paths, storeId),
        log: (level, message) => ctx.output.log(level, message),
        now: () => ctx.clock.now(),
        signal: ctx.signal,
      });
    } finally {
      release();
    }
  },
});

const TrashItemSchema = z.looseObject({
  op: z.string(),
  project: z.string(),
  projectId: z.string(),
  trash: z.string(),
  keepUntil: z.string().optional(),
  bytes: z.int().nonnegative().optional(),
  reason: z.string().optional(),
});

export const gc = defineCommand({
  name: "gc",
  summary: "Delete released trash past its keepLocalFor deadline; --now deletes it early",
  risk: "safe_write",
  dryRun: false,
  acceptsPlan: false,
  positionals: [],
  args: z.strictObject({
    now: z
      .boolean()
      .optional()
      .meta({ description: "Also delete kept trash before its deadline", risk: "confirm" }),
  }),
  output: z
    .looseObject({
      deleted: z.array(TrashItemSchema),
      kept: z
        .array(TrashItemSchema)
        .meta({ description: "Before its deadline, or being renamed back by an onload" }),
      skipped: z.array(TrashItemSchema.extend({ finding: FindingDataSchema })),
      freedBytes: z.int().nonnegative(),
      staging: z.array(z.string()).meta({
        description:
          "Staging folders no live operation owned (a crashed restore's, an onload's whose journal is gone), removed (D60)",
      }),
      stagingKept: z.array(z.looseObject({ staging: z.string(), finding: FindingDataSchema })).meta({
        description:
          "A crashed restore's staging folder gc could not reach (its volume away), kept with its record",
      }),
    })
    .meta({ description: "The trash deleted and kept, and the abandoned staging removed" }),
  examples: [
    { argv: ["gc"], summary: "Delete trash whose deadline has passed" },
    { argv: ["gc", "--now", "--yes"], summary: "Delete every kept trash now" },
  ],
  human: (data) => {
    const lines: string[] = [];
    if (data.deleted.length > 0)
      lines.push(
        `deleted ${data.deleted.length} trash folder${data.deleted.length === 1 ? "" : "s"}, freed ${formatBytes(data.freedBytes)}`,
      );
    for (const k of data.kept)
      lines.push(
        `kept ${k.trash} (${k.project})${k.reason === undefined ? ` until ${k.keepUntil}` : `: ${k.reason}`}`,
      );
    for (const st of data.staging) lines.push(`removed ${st}, an abandoned staging folder`);
    for (const st of data.stagingKept) lines.push(`kept ${st.staging}: ${st.finding.message}`);
    return lines.length === 0 ? "no trash to delete" : lines.join("\n");
  },
  handler: async (args, ctx) => {
    const paths = ctx.paths();
    if (!paths.ok) return paths;
    return collectTrash(
      {
        host: ctx.system,
        paths: paths.value,
        env: ctx.env,
        log: (level, message) => ctx.output.log(level, message),
        now: () => ctx.clock.now(),
      },
      { early: args.now === true },
    );
  },
});

export const restore = defineCommand({
  name: "restore",
  summary: "Restore a snapshot side by side into a free path: no lease, no hydration",
  risk: "safe_write",
  dryRun: false,
  acceptsPlan: false,
  positionals: ["project"],
  args: z.strictObject({
    project: z
      .string()
      .meta({ description: "An address (root:path), a unique name, a path or its .plainport stub" }),
    to: z.string().meta({ description: "Where the copy goes; nothing may stand there" }),
    snapshot: z.string().optional().meta({ description: "The snapshot to restore; the head when absent" }),
  }),
  output: z
    .looseObject({
      op: z.string(),
      project: z.string(),
      snapshot: z.string(),
      store: z.string(),
      dir: z.string().meta({ description: "Where the copy now is" }),
      files: z.int().nonnegative(),
      bytes: z.int().nonnegative(),
    })
    .meta({ description: "The snapshot restored side by side; the project itself is unchanged" }),
  examples: [
    {
      argv: ["restore", "work:clients/acme/api", "--to", "~/personal/api-copy"],
      summary: "Read the head beside everything else",
    },
  ],
  human: (data) =>
    `restored snapshot ${data.snapshot} of ${data.project} into ${data.dir} (${data.files} file${data.files === 1 ? "" : "s"}, ${formatBytes(data.bytes)}); the project itself is unchanged`,
  handler: async (args, ctx) => {
    const known = await knownProjects(ctx);
    if (!known.ok) return known;
    const { paths, device } = known.value;
    const named = await resolveKnown(ctx, known.value, args.project, "restore");
    if (!named.ok) return named;
    const release = ctx.holdSignal();
    try {
      const done = await runRestore(
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
          signal: ctx.signal,
          now: () => ctx.clock.now(),
        },
        {
          project: named.value.ref,
          to: expandHome(args.to, paths.home, ctx.cwd),
          ...(args.snapshot === undefined ? {} : { snapshot: args.snapshot }),
          ...(ctx.store === undefined ? {} : { store: ctx.store }),
        },
      );
      return done.ok ? ok(done.value) : done;
    } finally {
      release();
    }
  },
});
