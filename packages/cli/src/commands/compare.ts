// plainport compare <project> (M2 Task 26, Q18): every other head of the project, written into its own repository as
// refs/plainport/theirs/<snapshot>/{HEAD,heads/*,index,worktree}, for git diff and git checkout -p before resolve.
// The saga is core's runCompare; this file is its registry entry and its rendering.

import { openEventMirror } from "@plainport/blob-fs";
import { ok, shellWord } from "@plainport/contract";
import { ConfigLoader, runCompare, shortDeviceId } from "@plainport/core";
import { z } from "zod";
import { defineCommand } from "../registry.ts";
import { knownProjects, resolveKnown } from "./resolve.ts";

const SetSchema = z.looseObject({
  snapshot: z.string(),
  device: z.string().meta({ description: "The device that made the snapshot" }),
  at: z.string().meta({ description: "When it was made" }),
  refs: z.array(z.string()).meta({ description: "The set's refs, sorted" }),
  head: z.string().optional().meta({ description: "Their HEAD commit; absent when it has no commit yet" }),
  detached: z.boolean().meta({ description: "Their HEAD was detached" }),
  branches: z.array(z.string()).meta({ description: "Their branches, as heads/<name>" }),
  index: z
    .string()
    .optional()
    .meta({ description: "The commit of their staged index; absent when unmerged" }),
  worktree: z.string().meta({ description: "The commit of their working tree, parent = their HEAD" }),
  unmerged: z.array(z.string()).meta({ description: "Paths their index holds unmerged" }),
  submodules: z.array(z.string()).meta({ description: "Gitlinks, kept as their index records them" }),
  nested: z
    .array(z.string())
    .meta({ description: "Untracked repositories inside their copy, not committed" }),
  intentToAdd: z.array(z.string()).meta({
    description: "Intent-to-add entries (git add -N): not in index, their files in worktree",
  }),
  withheld: z.array(z.string()).meta({
    description:
      "Files that look like secrets (.env*, key files) whose bytes their index does not hold: never committed, listed",
  }),
  ignored: z.array(z.string()).meta({
    description: "Ignored files that differ between the copies (the first 100): listed, never committed",
  }),
  ignoredTotal: z.int().nonnegative(),
  changed: z.boolean().meta({ description: "Refs changed; false when the set was already exactly this" }),
});

const ListedSchema = z.looseObject({
  snapshot: z.string(),
  leaves: z.array(z.string()),
  complete: z.boolean(),
  missing: z
    .array(z.string())
    .meta({ description: "Leaves it should have that are missing or hold another value" }),
  extra: z.array(z.string()).meta({ description: "Leaves it should not have" }),
});

const OutputSchema = z
  .looseObject({
    op: z.string(),
    project: z.string(),
    dir: z.string().meta({ description: "The project's folder, whose repository holds the refs" }),
    store: z.string().optional(),
    base: z.string().optional().meta({ description: "The snapshot this copy came from" }),
    sets: z.array(SetSchema).meta({ description: "One per other head, written by this run" }),
    nothing: z.string().optional().meta({ description: "Why there was nothing to compare" }),
    incomplete: z.array(ListedSchema).meta({
      description:
        "Sets still incomplete (a crash inside git's ref transaction, or an earlier run's): a rerun replaces them, --clean removes them",
    }),
    removed: z.array(z.string()).optional().meta({ description: "--clean: the refs removed" }),
  })
  .meta({ description: "The theirs refs written, or removed with --clean" });

type Output = z.output<typeof OutputSchema>;

const human = (data: Output): string => {
  if (data.removed !== undefined)
    return data.removed.length === 0
      ? `no refs under refs/plainport/theirs/ in ${data.dir}`
      : `removed ${data.removed.length} ref${data.removed.length === 1 ? "" : "s"} under refs/plainport/theirs/ in ${data.dir}`;
  const lines: string[] = [];
  if (data.nothing !== undefined) lines.push(`nothing to compare: ${data.nothing}`);
  for (const s of data.sets) {
    const at = `refs/plainport/theirs/${s.snapshot}`;
    lines.push(
      `${s.snapshot} from device ${shortDeviceId(s.device)}, ${s.at}${s.changed ? "" : " (unchanged)"}`,
    );
    lines.push(`  ${at}/worktree  their working tree`);
    lines.push(
      s.index === undefined
        ? `  (no ${at}/index: their index is unmerged at ${s.unmerged.join(", ")})`
        : `  ${at}/index     their staged index`,
    );
    if (s.head !== undefined) lines.push(`  ${at}/HEAD      their HEAD${s.detached ? " (detached)" : ""}`);
    if (s.branches.length > 0) lines.push(`  ${at}/heads/*   ${s.branches.join(", ")}`);
    if (s.submodules.length > 0) lines.push(`  submodules kept as gitlinks: ${s.submodules.join(", ")}`);
    if (s.nested.length > 0) lines.push(`  repositories inside, not committed: ${s.nested.join(", ")}`);
    if (s.intentToAdd.length > 0)
      lines.push(`  intent-to-add, in worktree only: ${s.intentToAdd.join(", ")}`);
    if (s.withheld.length > 0)
      lines.push(`  files that look like secrets, not committed: ${s.withheld.join(", ")}`);
    if (s.ignoredTotal > 0)
      lines.push(
        `  ignored files that differ, not committed: ${s.ignored.join(", ")}${s.ignoredTotal > s.ignored.length ? `, … (${s.ignoredTotal} in all)` : ""}`,
      );
    lines.push(`  git diff HEAD ${at}/worktree`);
  }
  for (const s of data.incomplete)
    lines.push(
      `incomplete: refs/plainport/theirs/${s.snapshot}/ ${[
        ...(s.missing.length === 0 ? [] : [`lacks ${s.missing.join(", ")}`]),
        ...(s.extra.length === 0 ? [] : [`holds ${s.extra.join(", ")} it should not`]),
      ].join(
        " and ",
      )}; plainport compare ${shellWord(data.project)} replaces it while it is a head, --clean removes it`,
    );
  return lines.join("\n");
};

export const compare = defineCommand({
  name: "compare",
  summary: "Write each other head of a project into its repository as refs/plainport/theirs/<snapshot>/…",
  details: [
    "While a conflict stands, each head other than the snapshot this copy came from is restored beside the project and written into its repository as sibling refs:",
    [
      "  refs/plainport/theirs/<snapshot>/HEAD       their HEAD commit, detached or not",
      "  refs/plainport/theirs/<snapshot>/heads/*    their branches",
      "  refs/plainport/theirs/<snapshot>/index      a commit of their staged index (absent when it is unmerged)",
      "  refs/plainport/theirs/<snapshot>/worktree   a commit of their working tree, parent = their HEAD",
    ].join("\n"),
    "Compare them with git diff HEAD refs/plainport/theirs/<snapshot>/worktree, and take hunks with git checkout -p. Your index, branches, working tree and config are not touched, and no filter or hook of either copy runs; ignored files (.env) and files that look like secrets (.env*, key files) are never committed, and are listed. A shallow or partial clone, replace refs or a grafts file, two object formats, or files tracked with Git LFS are refused (compare.unsupported-repo). Each set is written in one ref transaction, so a rerun replaces it whole; --clean removes every ref under refs/plainport/theirs/ and nothing else. A project that is not a git repository gets the paths that differ instead.",
  ],
  risk: "safe_write",
  dryRun: false,
  acceptsPlan: false,
  group: "projects",
  positionals: ["project"],
  args: z.strictObject({
    project: z.string().optional().meta({
      description: "An address (root:path), a unique name, a path or its .plainport stub; default .",
    }),
    clean: z
      .boolean()
      .optional()
      .meta({ description: "Remove every ref under refs/plainport/theirs/ instead, and nothing else" }),
  }),
  output: OutputSchema,
  examples: [
    {
      argv: ["compare", "work:clients/acme/web"],
      summary:
        "Write the other heads as refs/plainport/theirs/<snapshot>/…; nothing to do until there is one",
    },
    { argv: ["compare", "work:clients/acme/web", "--clean"], summary: "Remove the theirs refs" },
  ],
  human,
  handler: async (args, ctx) => {
    const known = await knownProjects(ctx);
    if (!known.ok) return known;
    const { paths, device } = known.value;
    const named = await resolveKnown(ctx, known.value, args.project ?? ".", "compare");
    if (!named.ok) return named;
    const release = ctx.holdSignal();
    try {
      const done = await runCompare(
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
          ...(args.clean === true ? { clean: true } : {}),
          ...(ctx.store === undefined ? {} : { store: ctx.store }),
        },
      );
      return done.ok ? ok(done.value) : done;
    } finally {
      release();
    }
  },
});
