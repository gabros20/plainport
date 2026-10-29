// plainport store add | list | test | upgrade | remove (DESIGN.md "CLI design", "Bootstrap", "Formats and
// compatibility"; Q2, Q4, Q8, Q13). Each is a thin call into core's stores module:
//   - add (safe_write) sets a store up through bootstrap, or adopts one already set up, and records it in managed.toml;
//     --secret-stdin saves its password to the Keychain first. It sends only setup files.
//   - list (read) shows every configured store; --probe also asks each whether it answers, still writing nothing.
//   - test (safe_write) writes, reads, lists and deletes one probe key, records what it measured in this device's
//     record of the store (stores/<id>.json), and lists what bootstraps left behind.
//   - upgrade (confirm) moves a format-1 store to format 2 under Q2's quiescence checks.
//   - remove (confirm) forgets a store on this device only; store.in-use while anything here uses it.

import { fail, finding, ok } from "@plainport/contract";
import {
  addStore,
  ConfigLoader,
  DurationSchema,
  durationMs,
  listStores,
  notConfigured,
  probeStore,
  QUIET_WINDOW_MS,
  readDevice,
  removeStore,
  SecretRefSchema,
  type Store,
  testStore,
  ulid,
  upgradeStore,
} from "@plainport/core";
import { z } from "zod";
import lock from "../../../../tools.lock.json" with { type: "json" };
import { type CommandContext, defineCommand } from "../registry.ts";
import { FindingsSchema, findingLines } from "./local.ts";

/** The restic and rclone this build carries (tools.lock.json): the facts a measurement holds for (Q4). */
export const TOOLS = { restic: lock.tools.restic.version, rclone: lock.tools.rclone.version } as const;

const name = z.string().min(1).meta({ description: "The store's name in config, e.g. archive" });

const loadConfig = async (ctx: CommandContext) => {
  const paths = ctx.paths();
  if (!paths.ok) return paths;
  const loaded = await new ConfigLoader(ctx.io, paths.value).load({ env: ctx.env });
  if (!loaded.ok) return loaded;
  return ok({ paths: paths.value, config: loaded.value.config, findings: loaded.value.findings });
};

// ---------------------------------------------------------------------------------------------------------------------
// store add

const KINDS = ["local", "sftp", "s3"] as const;

const addArgs = z.strictObject({
  name,
  kind: z.enum(KINDS).optional().meta({ description: "local (a folder or disk), sftp or s3; default local" }),
  path: z.string().min(1).optional().meta({
    description: "local: the folder; sftp: the folder on the host; s3: a prefix inside the bucket (optional)",
  }),
  host: z.string().min(1).optional().meta({ description: "sftp: the host, as ssh knows it" }),
  endpoint: z.string().min(1).optional().meta({ description: "s3: the endpoint URL" }),
  bucket: z.string().min(1).optional().meta({ description: "s3: the bucket" }),
  region: z.string().min(1).optional().meta({ description: "s3: the region, when the endpoint needs one" }),
  // References only, checked at the argument boundary so a secret typed here by mistake is refused before any
  // message or re-run hint could repeat it (AGENTS.md rule 9).
  secret: SecretRefSchema.optional().meta({
    description:
      "Where the restic password is: keychain:<service>/<account>, op://…, env:<VARIABLE> or file:<path>; local default env:PLAINPORT_STORE_PASSWORD, with --secret-stdin keychain:plainport/<name>",
  }),
  "access-key-id": SecretRefSchema.optional().meta({ description: "s3: a reference to the access key id" }),
  "secret-access-key": SecretRefSchema.optional().meta({
    description: "s3: a reference to the secret access key",
  }),
  "secret-stdin": z.boolean().optional().meta({
    description: "Read the restic password from standard input and save it to the Keychain under --secret",
  }),
});

/** The store's table from the flags, or a usage error naming what its kind needs. */
const tableOf = (
  args: z.output<typeof addArgs>,
): { ok: true; store: Store } | { ok: false; missing: string[] } => {
  const kind = args.kind ?? "local";
  const secret =
    args.secret ?? (args["secret-stdin"] === true ? `keychain:plainport/${args.name}` : undefined);
  const missing = (pairs: [string, unknown][]) =>
    pairs.filter(([, v]) => v === undefined).map(([k]) => `--${k}`);
  switch (kind) {
    case "local": {
      const lacking = missing([["path", args.path]]);
      if (lacking.length > 0) return { ok: false, missing: lacking };
      return {
        ok: true,
        store: { kind, path: args.path as string, ...(secret !== undefined && { secret }) },
      };
    }
    case "sftp": {
      const lacking = missing([
        ["host", args.host],
        ["path", args.path],
        ["secret", secret],
      ]);
      if (lacking.length > 0) return { ok: false, missing: lacking };
      return {
        ok: true,
        store: { kind, host: args.host as string, path: args.path as string, secret: secret as string },
      };
    }
    case "s3": {
      const lacking = missing([
        ["endpoint", args.endpoint],
        ["bucket", args.bucket],
        ["secret", secret],
        ["access-key-id", args["access-key-id"]],
        ["secret-access-key", args["secret-access-key"]],
      ]);
      if (lacking.length > 0) return { ok: false, missing: lacking };
      return {
        ok: true,
        store: {
          kind,
          endpoint: args.endpoint as string,
          bucket: args.bucket as string,
          secret: secret as string,
          accessKeyId: args["access-key-id"] as string,
          secretAccessKey: args["secret-access-key"] as string,
          ...(args.region !== undefined && { region: args.region }),
          ...(args.path !== undefined && { path: args.path }),
        },
      };
    }
  }
};

export const storeAdd = defineCommand({
  name: "store add",
  summary: "Set a store up, or adopt one already set up, and record it in managed.toml",
  risk: "safe_write",
  dryRun: false,
  acceptsPlan: false,
  group: "setup",
  positionals: ["name"],
  args: addArgs,
  output: z.looseObject({
    name: z.string(),
    id: z.string().meta({ description: "The store's id, from its meta/v1/store.json" }),
    outcome: z.enum(["published", "adopted"]).meta({
      description: "published: this run set the store up (won its election); adopted: it was set up already",
    }),
    format: z.union([z.literal(1), z.literal(2)]),
    repo: z.string().meta({ description: "Where its restic repository lies under the store's root" }),
    location: z.string(),
    configChanged: z.boolean().meta({ description: "This run wrote managed.toml" }),
    secretSaved: z.boolean().meta({ description: "This run saved the password to the Keychain" }),
  }),
  examples: [
    {
      argv: ["store", "add", "archive", "--path", "~/Archive"],
      summary:
        "A local store (a folder, or one on an external disk), its password in PLAINPORT_STORE_PASSWORD; an SFTP store takes --kind sftp --host <host> --path <folder> --secret <ref>, and --secret-stdin saves a typed password to the Keychain",
    },
  ],
  human: (data) =>
    [
      `store ${data.name} ${data.outcome === "published" ? "set up" : "adopted"}: ${data.id} at ${data.location} (format ${data.format}, repository ${data.repo})`,
      ...(data.secretSaved ? ["password saved to the Keychain"] : []),
      data.configChanged ? "managed.toml updated" : "managed.toml already had it",
    ].join("\n"),
  handler: async (args, ctx) => {
    const table = tableOf(args);
    if (!table.ok)
      return fail(
        finding("usage.invalid", {
          message: `a ${args.kind ?? "local"} store needs ${table.missing.join(", ")}`,
          fix: "plainport help store add",
        }),
      );
    const paths = ctx.paths();
    if (!paths.ok) return paths;
    let secretValue: string | undefined;
    if (args["secret-stdin"] === true) {
      if (ctx.stdin === undefined)
        return fail(
          finding("usage.invalid", {
            message: "--secret-stdin reads standard input, and this run has none",
            fix: "pipe the password in: … | plainport store add <name> --secret-stdin",
          }),
        );
      secretValue = (await ctx.stdin()).replace(/\r?\n$/, "");
      if (secretValue === "")
        return fail(
          finding("usage.invalid", {
            message: "--secret-stdin read nothing from standard input; nothing was written",
            fix: "pipe the password in: … | plainport store add <name> --secret-stdin",
          }),
        );
    }
    return addStore(ctx.io, {
      paths: paths.value,
      env: ctx.env,
      name: args.name,
      store: table.store,
      opener: ctx.stores,
      ports: {
        faultAt: (point) => ctx.system.faultAt(point),
        clock: () => ctx.clock.now(),
        log: (level, message) => ctx.output.log(level, message),
        wait: (ms) => ctx.sleep(ms),
      },
      ...(secretValue !== undefined && { secretValue }),
    });
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// store list

const ProbeInfo = z.union([
  z.looseObject({
    reachable: z.literal(true),
    format: z.union([z.literal(1), z.literal(2)]).optional(),
    id: z.string().optional(),
    pinned: z.boolean().meta({ description: "It carries the id this device pinned for the name" }),
  }),
  z.looseObject({
    reachable: z.literal(false),
    finding: z.looseObject({ code: z.string(), message: z.string() }),
  }),
]);

const TestInfo = z.looseObject({
  at: z.string(),
  ok: z.boolean(),
  delete: z.enum(["denied", "allowed", "unreachable"]).optional(),
});

export const storeList = defineCommand({
  name: "store list",
  summary:
    "Show every configured store, its id on this device and its last test; --probe asks each whether it answers",
  risk: "read",
  dryRun: false,
  acceptsPlan: false,
  group: "setup",
  positionals: [],
  args: z.strictObject({
    probe: z.boolean().optional().meta({ description: "Also check that each store answers (reads only)" }),
  }),
  output: z.looseObject({
    stores: z.array(
      z.looseObject({
        name: z.string(),
        kind: z.string(),
        location: z.string(),
        source: z.enum(["config", "managed", "both"]),
        default: z.boolean(),
        id: z.string().optional().meta({ description: "The id this device pinned for the name (D85)" }),
        roots: z.array(z.string()),
        lastTest: TestInfo.optional(),
        probe: ProbeInfo.optional(),
      }),
    ),
    findings: FindingsSchema,
  }),
  examples: [
    { argv: ["store", "list"], summary: "List stores" },
    { argv: ["store", "list", "--probe"], summary: "List stores and check each answers" },
  ],
  human: (data) => {
    if (data.stores.length === 0) return "No stores yet: plainport store add <name> --path <folder>.";
    return [
      ...data.stores.map((s) =>
        [
          `${s.name}${s.default ? " (default)" : ""}  ${s.kind}  ${s.location}`,
          `  ${s.id === undefined ? "not set up on this device" : `id ${s.id}`}${s.roots.length === 0 ? "" : `; roots ${s.roots.join(", ")}`}`,
          ...(s.lastTest === undefined
            ? []
            : [
                `  last test ${s.lastTest.at}: ${s.lastTest.ok ? "ok" : "failed"}${s.lastTest.delete === undefined ? "" : `, delete ${s.lastTest.delete}`}`,
              ]),
          ...(s.probe === undefined
            ? []
            : [
                s.probe.reachable
                  ? `  answers${s.probe.id === undefined ? ", not set up" : `: ${s.probe.id} (format ${s.probe.format})${s.probe.pinned ? "" : ", not the id pinned here"}`}`
                  : `  does not answer: ${s.probe.finding.code} ${s.probe.finding.message}`,
              ]),
        ].join("\n"),
      ),
      ...findingLines(data.findings),
    ].join("\n");
  },
  handler: async (args, ctx) => {
    const paths = ctx.paths();
    if (!paths.ok) return paths;
    return listStores(ctx.io, {
      paths: paths.value,
      env: ctx.env,
      tools: TOOLS,
      ...(args.probe === true && {
        probe: (storeName: string, store: Store) =>
          probeStore(ctx.io, {
            paths: paths.value,
            env: ctx.env,
            name: storeName,
            store,
            opener: ctx.stores,
            signal: ctx.signal,
          }),
      }),
    });
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// store test

const Property = z.union([z.literal("unknown"), z.looseObject({ value: z.unknown(), evidence: z.string() })]);
const Leftover = z.looseObject({ attempt: z.string(), keys: z.array(z.string()) });

export const storeTest = defineCommand({
  name: "store test",
  summary: "Measure a store with one probe key, record the result on this device, and list setup leftovers",
  risk: "safe_write",
  dryRun: false,
  acceptsPlan: false,
  group: "setup",
  positionals: ["name"],
  args: z.strictObject({ name }),
  output: z.looseObject({
    name: z.string(),
    location: z.string(),
    id: z.string().optional(),
    format: z.union([z.literal(1), z.literal(2)]).optional(),
    pinned: z.string().optional(),
    reachable: z.boolean(),
    delete: z.enum(["denied", "allowed", "unreachable"]).optional().meta({
      description:
        "Whether the probe key could be deleted. denied is not append-only: that needs proof across the whole repository (M3)",
    }),
    semantics: z
      .record(z.string(), Property)
      .meta({ description: "The profile: measured here, or as stated (Q8)" }),
    operations: z.record(
      z.string(),
      z.looseObject({ eligible: z.boolean(), missing: z.array(z.string()).optional() }),
    ),
    repository: z.looseObject({ opens: z.boolean(), code: z.string().optional() }).optional(),
    losing: z.array(Leftover).meta({ description: "Repositories of setup attempts that did not win" }),
    contested: z.array(Leftover).meta({ description: "Candidacies of setup attempts besides the winner" }),
    cleanup: z.string().optional().meta({ description: "The manual steps that remove them, quiesced first" }),
    recorded: z.boolean().meta({ description: "Written to this device's record of the store" }),
    ok: z.boolean(),
    findings: FindingsSchema,
  }),
  examples: [{ argv: ["store", "test", "local"], summary: "Test store local" }],
  human: (data) => {
    const props = Object.entries(data.semantics).map(([key, p]) =>
      p === "unknown"
        ? `  ${key}: unknown`
        : `  ${key}: ${String((p as { value: unknown }).value)} (${(p as { evidence: string }).evidence})`,
    );
    const ops = Object.entries(data.operations).map(
      ([op, v]) => `  ${op}: ${v.eligible ? "yes" : `no (needs ${(v.missing ?? []).join(", ")})`}`,
    );
    return [
      `store ${data.name} at ${data.location}: ${data.reachable ? "answers" : "does not answer"}${data.id === undefined ? "" : `, ${data.id} (format ${data.format})`}`,
      ...(data.delete === undefined ? [] : [`delete: ${data.delete}`]),
      ...(data.repository === undefined
        ? []
        : [`repository: ${data.repository.opens ? "opens" : `does not open (${data.repository.code})`}`]),
      "profile:",
      ...props,
      "operations:",
      ...ops,
      ...data.losing.map((l) => `losing setup repository: repos/${l.attempt}`),
      ...data.contested.map((c) => `contested candidacy: ${c.attempt}`),
      ...(data.cleanup === undefined ? [] : [`cleanup: ${data.cleanup}`]),
      data.recorded ? "recorded on this device" : "not recorded (the store has no id this device can use)",
      ...findingLines(data.findings),
    ].join("\n");
  },
  handler: async (args, ctx) => {
    const loaded = await loadConfig(ctx);
    if (!loaded.ok) return loaded;
    const store = loaded.value.config.stores[args.name];
    if (store === undefined) return notConfigured(args.name, Object.keys(loaded.value.config.stores));
    return testStore(ctx.io, {
      paths: loaded.value.paths,
      env: ctx.env,
      name: args.name,
      store,
      opener: ctx.stores,
      tools: TOOLS,
      now: () => ctx.clock.now(),
      mint: () => ulid(ctx.clock.now().getTime()),
      signal: ctx.signal,
    });
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// store upgrade

export const storeUpgrade = defineCommand({
  name: "store upgrade",
  summary: "Move a format-1 store to format 2 once it is quiescent (Q2)",
  risk: "confirm",
  dryRun: false,
  acceptsPlan: false,
  group: "setup",
  positionals: ["name"],
  args: z.strictObject({
    name,
    "others-stopped": z.boolean().optional().meta({
      description:
        "You attest that no other device runs plainport (detached deletes included) while it upgrades",
    }),
    "quiet-window": DurationSchema.optional().meta({
      description:
        "How long the catalog must show no other device's activity, before and during; default 15m",
    }),
  }),
  output: z.looseObject({
    name: z.string(),
    id: z.string(),
    from: z.union([z.literal(1), z.literal(2)]),
    format: z.literal(2),
    upgraded: z.boolean().meta({ description: "This run replaced store.json" }),
    resumed: z.boolean().meta({ description: "This run finished or cleared this device's earlier upgrade" }),
  }),
  examples: [
    {
      argv: ["store", "upgrade", "local", "--others-stopped", "--yes"],
      summary: "Upgrade store local after stopping plainport on every other device",
    },
  ],
  human: (data) =>
    data.upgraded
      ? `store ${data.name} (${data.id}) is now format 2${data.resumed ? " (resumed)" : ""}; plainport v0.1.x refuses it from now on`
      : `store ${data.name} (${data.id}) is format 2 already${data.resumed ? "; the earlier upgrade's marker was removed" : ""}`,
  handler: async (args, ctx) => {
    const loaded = await loadConfig(ctx);
    if (!loaded.ok) return loaded;
    const device = await readDevice(ctx.io, loaded.value.paths);
    if (!device.ok) return device;
    if (device.value === undefined)
      return fail(
        finding("device.none", {
          message: "this device has no plainport identity yet, so it has set no store up",
          fix: "run plainport init first",
        }),
      );
    const release = ctx.holdSignal();
    try {
      return await upgradeStore(
        {
          io: ctx.io,
          paths: loaded.value.paths,
          env: ctx.env,
          clock: () => ctx.clock.now(),
          wait: (ms) => ctx.sleep(ms),
          faultAt: (point) => ctx.system.faultAt(point),
          signal: ctx.signal,
        },
        {
          name: args.name,
          config: loaded.value.config,
          opener: ctx.stores,
          device: device.value.id,
          othersStopped: args["others-stopped"] === true,
          windowMs: args["quiet-window"] === undefined ? QUIET_WINDOW_MS : durationMs(args["quiet-window"]),
          mint: () => ulid(ctx.clock.now().getTime()),
        },
      );
    } finally {
      release();
    }
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// store remove

export const storeRemove = defineCommand({
  name: "store remove",
  summary:
    "Forget a store on this device (its managed.toml table and its pin); the store itself is not touched",
  risk: "confirm",
  dryRun: false,
  acceptsPlan: false,
  group: "setup",
  positionals: ["name"],
  args: z.strictObject({ name }),
  output: z.looseObject({
    name: z.string(),
    id: z.string().optional().meta({ description: "The id the name was pinned to here, now forgotten" }),
    removed: z.boolean().meta({ description: "managed.toml no longer defines it" }),
  }),
  examples: [
    {
      argv: ["store", "remove", "spare", "--yes"],
      summary: "Forget store spare on this device (no root may use it)",
    },
  ],
  human: (data) =>
    `store ${data.name} forgotten on this device${data.id === undefined ? "" : ` (it was ${data.id})`}; nothing in the store was touched`,
  handler: async (args, ctx) => {
    const paths = ctx.paths();
    if (!paths.ok) return paths;
    return removeStore(ctx.io, { paths: paths.value, env: ctx.env, name: args.name });
  },
});
