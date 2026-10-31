// plainport recover, gc and restore (DESIGN.md "CLI design"; ADR-0008; D58, D59). All three are safe_write: recover
// rolls back what had not committed and finishes what had (only plainport's own journals, staging and trash change,
// besides the release a committed offload was already approved for); gc deletes released trash past its keepLocalFor
// deadline, and `gc --now` (confirm) before it; restore writes a snapshot side by side into a free path.

import { openEventMirror } from "@plainport/blob-fs";
import { failWith, finding, ok, ProjectStateSchema, type Result } from "@plainport/contract";
import {
  BOOTSTRAP_RECOVERY_OUTCOMES,
  ConfigLoader,
  collectTrash,
  expandHome,
  heldStoreOpener,
  openStore,
  RECOVERY_OUTCOMES,
  recover as recoverJournals,
  recoverUpgrades,
  runRestore,
  type UpgradeRecoveryReport,
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
    .looseObject({
      kind: z.enum(["fork", "diverged-after-commit"]),
      detail: z.enum(["after-commit"]).optional(),
    })
    .optional()
    .meta({
      description:
        "diverged-after-commit, and forked after the commit (kind fork, detail after-commit): exit 8's data, as offload gives it (D52, Q6)",
    }),
});

const RecoveredBootstrapSchema = z.looseObject({
  attempt: z.string().meta({ description: "The setup attempt's id (a ULID)" }),
  store: z.string().meta({ description: "The store's name in config" }),
  step: z.string().meta({ description: "The journal step recover found" }),
  outcome: z.enum(BOOTSTRAP_RECOVERY_OUTCOMES).meta({
    description:
      "published: this attempt's store.json is on the store and its id recorded here. lost: another attempt published first. contested: no attempt won and every visible one refuses. rolled-back: its candidacy never reached the store, so nothing was published. pending: not settled now (finding says why)",
  }),
  id: z.string().optional().meta({ description: "published, lost: the published store's id" }),
  finding: FindingDataSchema.optional(),
});

const RecoveredUpgradeSchema = z.looseObject({
  op: z.string().meta({ description: "The upgrade's id" }),
  store: z.string().meta({ description: "The store's name in config" }),
  outcome: z.enum(["cleared", "kept", "pending"]).meta({
    description:
      "cleared: this device's upgrade-intent marker was removed (store.json stays as the upgrade left it: format 2 if it was replaced, else 1). kept: the marker is another device's (or unreadable), left as it is. pending: not settled now (finding says why)",
  }),
  format: z.union([z.literal(1), z.literal(2)]).optional(),
  finding: FindingDataSchema.optional(),
});

const BOOTSTRAP_TEXT: Record<(typeof BOOTSTRAP_RECOVERY_OUTCOMES)[number], string> = {
  published: "published; the store is set up",
  lost: "lost: another attempt set the store up first",
  contested: "contested: no attempt won",
  "rolled-back": "rolled back; nothing was published",
  pending: "not settled now",
};

const OUTCOME_TEXT: Record<(typeof RECOVERY_OUTCOMES)[number], string> = {
  "rolled-back": "rolled back; nothing local had changed",
  finished: "finished",
  forked: "kept as a fork; the folder stays (conflicted)",
  "diverged-after-commit": "committed, but the folder changed since: it was kept, with no stub",
  "trash-deleted": "its trash was deleted",
  "trash-kept": "its trash is kept",
  pending: "not settled now",
};

/** recover's report with the upgrades it settled; a pending or unreadable upgrade makes an ok report exit 6. */
const withUpgrades = <T extends { unreadable: string[] }>(
  recovered: Result<T>,
  upgraded: Result<UpgradeRecoveryReport>,
): Result<T & { upgrades?: UpgradeRecoveryReport["upgrades"] }> => {
  if (!upgraded.ok) return recovered.ok ? failWith(upgraded.finding, recovered.value) : recovered;
  const extra = upgraded.value.upgrades.length === 0 ? {} : { upgrades: upgraded.value.upgrades };
  const add = (data: T) => ({
    ...data,
    ...extra,
    unreadable: [...data.unreadable, ...upgraded.value.unreadable],
  });
  if (!recovered.ok)
    return recovered.data === undefined ? recovered : { ...recovered, data: add(recovered.data as T) };
  const pending =
    upgraded.value.upgrades.some((u) => u.outcome === "pending") || upgraded.value.unreadable.length > 0;
  return pending
    ? failWith(
        finding("journal.pending", {
          message: "a store upgrade this device left could not be settled now; its journal stays",
          fix: "see the upgrade's finding in the report, then re-run plainport recover",
        }),
        add(recovered.value),
      )
    : ok(add(recovered.value));
};

export const recover = defineCommand({
  name: "recover",
  summary: "Settle interrupted operations: roll back what had not committed, finish what had",
  risk: "safe_write",
  dryRun: false,
  acceptsPlan: false,
  group: "recovery",
  positionals: [],
  args: z.strictObject({}),
  output: z
    .looseObject({
      operations: z.array(RecoveredSchema),
      bootstraps: z
        .array(RecoveredBootstrapSchema)
        .optional()
        .meta({ description: "Store setups this device left open, and what recover settled them to" }),
      upgrades: z
        .array(RecoveredUpgradeSchema)
        .optional()
        .meta({ description: "Store upgrades this device left open (Q2), and what recover settled them to" }),
      unreadable: z
        .array(z.string())
        .meta({ description: "Journal files this version cannot read: never touched" }),
    })
    .meta({
      description:
        "What recover did with each open journal. A failure carries this report as data, with the most severe code across every project (D64): 130 when Ctrl-C stopped it, then 8 (diverged-after-commit), 7, 6 (a pending or unreadable journal), 11 (a lock held), 9 (a store that did not answer), 5, 10, 4, 3, 2, 1",
    }),
  examples: [{ argv: ["recover"], summary: "Settle whatever was interrupted on this device" }],
  human: (data) =>
    data.operations.length === 0 &&
    (data.bootstraps ?? []).length === 0 &&
    (data.upgrades ?? []).length === 0 &&
    data.unreadable.length === 0
      ? "nothing to recover"
      : [
          ...data.operations.map(
            (o) =>
              `${o.kind} ${o.op} of ${o.project} (stopped at ${o.step}): ${OUTCOME_TEXT[o.outcome]}${
                o.keepUntil === undefined || o.outcome !== "trash-kept" ? "" : ` until ${o.keepUntil}`
              }${o.finding === undefined || o.outcome === "diverged-after-commit" ? "" : ` (${o.finding.code}: ${o.finding.message})`}; now ${o.state}`,
          ),
          ...(data.bootstraps ?? []).map(
            (b) =>
              `setup ${b.attempt} of store ${b.store} (stopped at ${b.step}): ${BOOTSTRAP_TEXT[b.outcome]}${b.id === undefined ? "" : ` (${b.id})`}${b.finding === undefined || b.outcome === "lost" ? "" : ` (${b.finding.code}: ${b.finding.message})`}`,
          ),
          ...(data.upgrades ?? []).map(
            (u) =>
              `upgrade ${u.op} of store ${u.store}: ${u.outcome === "cleared" ? `its marker was removed; the store is format ${u.format ?? "unchanged"}` : u.outcome === "kept" ? "the marker is not this device's; left as it is" : "not settled now"}${u.finding === undefined ? "" : ` (${u.finding.code}: ${u.finding.message})`}`,
          ),
          ...data.unreadable.map((u) => `${u}: a journal this version cannot read; left as it is`),
        ].join("\n"),
  handler: async (_args, ctx) => {
    const local = await thisDevice(ctx);
    if (!local.ok) return local;
    const { paths, device } = local.value;
    const release = ctx.holdSignal();
    try {
      // Upgrades first (Q2): a marker a crashed `store upgrade` left on a store is cleared before anything else.
      const loader = new ConfigLoader(ctx.io, paths);
      const upgraded = await recoverUpgrades({ io: ctx.io, paths }, device.id, async (name) => {
        const loaded = await loader.load({ env: ctx.env });
        if (!loaded.ok) return loaded;
        const opened = await openStore(ctx.io, {
          paths,
          env: ctx.env,
          name,
          config: loaded.value.config,
          opener: ctx.stores,
          catalog: false,
        });
        return opened.ok ? ok(opened.value.blob) : opened;
      });
      const recovered = await recoverJournals({
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
        wait: (ms) => ctx.system.clock.sleep(ms),
      });
      return withUpgrades(recovered, upgraded);
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
  group: "recovery",
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
        // A held trash gets the checked read (Q16): its store, opened as recover opens it.
        held: heldStoreOpener({
          io: ctx.system,
          paths: paths.value,
          env: ctx.env,
          loader: new ConfigLoader(ctx.io, paths.value),
          opener: ctx.stores,
          clock: () => ctx.clock.now(),
          openMirror: (storeId) => openEventMirror(ctx.io, paths.value, storeId),
          log: (level, message) => ctx.output.log(level, message),
        }),
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
  group: "projects",
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
