// plainport init (DESIGN.md "Roots" → Setting roots up, "CLI design"): names this device, sets up its roots and
// records the store their snapshots go to. Flags do it all (`--root work=~/work --store-path <path> --device mbp`);
// on a TTY without --no-input it asks for what the flags left out, starting with a scan of the likely folders.
// Without a TTY it never prompts: a missing answer is a usage error naming the exact flags to pass. init records the
// store in managed.toml, then sets it up: its identity file, its restic repository (the password read from
// --store-secret's reference, never passed itself), and this device's record of its id (D45). A store whose disk is
// not mounted stays recorded, with a warning to run init again.

import { basename } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";
import {
  ConfigLoader,
  DeviceNameSchema,
  deviceNameFrom,
  displayPath,
  ensureDevice,
  type RootCandidate,
  type RootChange,
  RootKeySchema,
  readDevice,
  rootCandidates,
  rootKeyFrom,
  SecretRefSchema,
  type StoreSetup,
  setUpStore,
  ulid,
  writeRoots,
} from "@plainport/core";
import { z } from "zod";
import { type CommandContext, defineCommand } from "../registry.ts";
import { FindingsSchema, findingLines } from "./local.ts";

const ROOT_FORM = "<key>=<path>";
const DEFAULT_STORE = "local";

const cancelled = () =>
  fail(
    finding("command.cancelled", {
      message: "init was cancelled; nothing was written",
      fix: "run plainport init again, or pass every answer as flags: plainport help init",
    }),
  );

/** A shell word as typed: bare when it is plain, single-quoted otherwise. Placeholders such as <path> stay bare. */
const word = (text: string): string =>
  /^[A-Za-z0-9_./~=:@%+,-]+$/.test(text) || /^[^ ]*<[a-z-]+>$/.test(text)
    ? text
    : `'${text.replaceAll("'", "'\\''")}'`;

const problemOf = (schema: z.ZodType, value: string): string | undefined => {
  const checked = schema.safeParse(value);
  return checked.success ? undefined : (checked.error.issues[0]?.message ?? "not valid");
};

type Root = { key: string; path: string };

const parseRoots = (values: readonly string[]): Result<Root[]> => {
  const roots: Root[] = [];
  for (const value of values) {
    const at = value.indexOf("=");
    const key = at === -1 ? "" : value.slice(0, at);
    const path = at === -1 ? "" : value.slice(at + 1);
    if (key === "" || path === "") {
      return fail(
        finding("usage.invalid", {
          message: `--root ${value} is not ${ROOT_FORM}`,
          fix: `pass each root as --root ${ROOT_FORM}, e.g. --root work=~/work`,
        }),
      );
    }
    roots.push({ key, path });
  }
  return ok(roots);
};

/** Asks for roots: picks from the scan of likely folders, or one folder typed in, then a key for each. An empty list
 * means the person picked none; undefined means they cancelled. */
const askRoots = async (ctx: CommandContext, candidates: RootCandidate[]): Promise<Root[] | undefined> => {
  const home = ctx.env.HOME ?? "";
  let picked: string[];
  if (candidates.length > 0) {
    const answer = await ctx.prompt.multiselect({
      message: "Which folders hold your projects? Each becomes a root.",
      options: candidates.map((c) => ({
        value: c.path,
        label: displayPath(c.path, home),
        hint: `${c.projects} project${c.projects === 1 ? "" : "s"}`,
      })),
    });
    if (answer === undefined) return undefined;
    picked = answer;
  } else {
    const answer = await ctx.prompt.text({
      message: "Which folder holds your projects? It becomes your first root.",
      validate: (value) => (value.trim() === "" ? "a folder is needed" : undefined),
    });
    if (answer === undefined) return undefined;
    picked = [answer];
  }
  const roots: Root[] = [];
  for (const path of picked) {
    const key = await ctx.prompt.text({
      message: `A name for the root at ${displayPath(path, home)}`,
      initial: candidates.find((c) => c.path === path)?.key ?? rootKeyFrom(basename(path)),
      validate: (value) => problemOf(RootKeySchema, value),
    });
    if (key === undefined) return undefined;
    roots.push({ key, path });
  }
  return roots;
};

export const init = defineCommand({
  name: "init",
  summary: "Name this device, set up its roots and record the store snapshots go to",
  risk: "confirm",
  dryRun: false,
  acceptsPlan: false,
  group: "setup",
  positionals: [],
  args: z.strictObject({
    root: z
      .array(z.string())
      .optional()
      .meta({ description: `A root, as ${ROOT_FORM} (repeatable); without one, a TTY offers a scan` }),
    "store-path": z.string().min(1).optional().meta({
      description: "A local folder for the store, e.g. on an external disk; --store names it (default local)",
    }),
    // A reference, checked at the argument boundary, so a password typed here by mistake is refused before any
    // message or re-run hint could repeat it (AGENTS.md rule 9).
    "store-secret": SecretRefSchema.optional().meta({
      description:
        "Where the store's repository password is: env:<VARIABLE> or file:<path>; default env:PLAINPORT_STORE_PASSWORD",
    }),
    device: z
      .string()
      .optional()
      .meta({ description: "This device's name in every root's bindings; default: the host name" }),
  }),
  output: z.looseObject({
    device: z.looseObject({
      id: z.string(),
      name: z.string(),
      role: z.string(),
      created: z.boolean().meta({ description: "This run created the identity" }),
    }),
    roots: z.array(z.looseObject({ key: z.string(), path: z.string().optional() })),
    store: z
      .looseObject({
        name: z.string(),
        path: z.string(),
        id: z
          .string()
          .optional()
          .meta({ description: "The id in its meta/v1/store.json, once it is set up" }),
      })
      .optional(),
    files: z.looseObject({ config: z.string(), managed: z.string(), device: z.string() }),
    changed: z
      .boolean()
      .meta({ description: "This run wrote managed.toml, created device.json or set the store up" }),
    findings: FindingsSchema,
  }),
  examples: [
    {
      argv: ["init", "--root", "work=~/work", "--store-path", "/Volumes/Archive/plainport", "--yes"],
      summary: "Set up without prompts",
    },
    {
      argv: ["init", "--yes"],
      summary:
        "Re-check setup from the roots and store already configured (on a TTY, asks for what is missing)",
    },
  ],
  human: (data) =>
    [
      `device ${data.device.name}${data.device.created ? " (new)" : ""}`,
      ...data.roots.map((r) => `root ${r.key}${r.path === undefined ? "" : ` at ${r.path}`}`),
      ...(data.store === undefined
        ? []
        : [
            `store ${data.store.name} at ${data.store.path}${data.store.id === undefined ? "" : ` (${data.store.id})`}`,
          ]),
      data.changed ? `settings written to ${data.files.managed}` : "nothing changed: already set up",
      ...findingLines(data.findings),
    ].join("\n"),
  handler: async (args, ctx) => {
    const resolved = ctx.paths();
    if (!resolved.ok) return resolved;
    const paths = resolved.value;
    const home = paths.home;

    const existing = await readDevice(ctx.io, paths);
    if (!existing.ok) return existing;
    if (existing.value !== undefined && args.device !== undefined && args.device !== existing.value.name) {
      return fail(
        finding("usage.invalid", {
          message: `this device is already named ${existing.value.name}; plainport never renames a device`,
          fix: `leave out --device, or pass --device ${existing.value.name}`,
        }),
      );
    }
    const loaded = await new ConfigLoader(ctx.io, paths).load({ env: ctx.env });
    if (!loaded.ok) return loaded;
    const { config } = loaded.value;

    const given = parseRoots(args.root ?? []);
    if (!given.ok) return given;
    let roots = given.value;
    let storePath = args["store-path"];
    let deviceName = existing.value?.name ?? args.device;
    const needRoots = roots.length === 0 && Object.keys(config.roots).length === 0;
    const needStore =
      storePath === undefined && config.defaultStore === undefined && Object.keys(config.stores).length === 0;

    if (ctx.input) {
      if (needRoots) {
        const scanned = await rootCandidates(ctx.io, home);
        for (const note of scanned.notes) ctx.output.log("info", `skipped ${note.path}: ${note.reason}`);
        const asked = await askRoots(ctx, scanned.candidates);
        if (asked === undefined) return cancelled();
        if (asked.length === 0) {
          return fail(
            finding("usage.invalid", {
              message: "init needs at least one root, and no folder was picked",
              fix: [
                `plainport init --root ${ROOT_FORM}`,
                ...(needStore && storePath === undefined ? ["--store-path <path>"] : []),
                "--yes",
              ].join(" "),
            }),
          );
        }
        roots = asked;
      }
      if (needStore) {
        const asked = await ctx.prompt.text({
          message: "Where should snapshots go? A folder, e.g. on an external disk",
          validate: (value) => (value.trim() === "" ? "a folder is needed" : undefined),
        });
        if (asked === undefined) return cancelled();
        storePath = asked;
      }
      if (deviceName === undefined) {
        const asked = await ctx.prompt.text({
          message: "A name for this device",
          initial: deviceNameFrom(ctx.io.proc.hostname()),
          validate: (value) => problemOf(DeviceNameSchema, value),
        });
        if (asked === undefined) return cancelled();
        deviceName = asked;
      }
    } else if (needRoots || needStore) {
      const scanned = needRoots ? await rootCandidates(ctx.io, home) : { candidates: [], notes: [] };
      const suggested = scanned.candidates;
      const rootFlags =
        roots.length > 0
          ? roots.map((r) => `--root ${word(`${r.key}=${r.path}`)}`)
          : needRoots
            ? suggested.length > 0
              ? suggested.map((c) => `--root ${word(`${c.key}=${displayPath(c.path, home)}`)}`)
              : [`--root ${ROOT_FORM}`]
            : [];
      const fix = [
        "plainport init",
        ...rootFlags,
        `--store-path ${storePath === undefined ? "<path>" : word(storePath)}`,
        ...(ctx.store === undefined ? [] : [`--store ${word(ctx.store)}`]),
        ...(args.device === undefined ? [] : [`--device ${word(args.device)}`]),
        "--yes",
      ];
      const missing = [needRoots && "a root", needStore && "a store"].filter(Boolean).join(" and ");
      return fail(
        finding("usage.invalid", {
          message: `init needs ${missing}, and without a terminal it never prompts${scanned.notes
            .map((note) => `; skipped ${note.path}: ${note.reason}`)
            .join("")}`,
          fix: (needStore ? fix : fix.filter((part) => !part.startsWith("--store-path"))).join(" "),
        }),
      );
    }

    const name = deviceName ?? deviceNameFrom(ctx.io.proc.hostname());
    const nameProblem = problemOf(DeviceNameSchema, name);
    if (nameProblem !== undefined) {
      return fail(
        finding("usage.invalid", {
          message: `${JSON.stringify(name)} is not a device name: ${nameProblem}`,
          fix: "pass --device <name>: a lower-case word starting with a letter, e.g. --device mbp",
        }),
      );
    }

    const changes: RootChange[] = roots.map((r) =>
      config.roots[r.key] === undefined
        ? { kind: "add", key: r.key, path: r.path }
        : { kind: "bind", key: r.key, path: r.path },
    );
    const secret = args["store-secret"];
    if (secret !== undefined && storePath === undefined) {
      // The reference belongs to the store it is recorded with: never applied silently to one already set up.
      const named = ctx.store ?? config.defaultStore;
      const existing = named === undefined ? undefined : config.stores[named];
      return fail(
        finding("usage.invalid", {
          message: "--store-secret is recorded with --store-path; pass the store's path too",
          fix: [
            "plainport init",
            `--store-path ${existing !== undefined && "path" in existing ? word(existing.path) : "<path>"}`,
            ...(ctx.store === undefined ? [] : [`--store ${word(ctx.store)}`]),
            `--store-secret ${word(secret)}`,
            "--yes",
          ].join(" "),
        }),
      );
    }
    const store =
      storePath === undefined
        ? undefined
        : { name: ctx.store ?? DEFAULT_STORE, path: storePath, ...(secret === undefined ? {} : { secret }) };
    let findings: z.output<typeof FindingsSchema> = [];
    let writtenRoots: { key: string; path?: string }[] = [];
    let writtenStore: { name: string; path: string } | undefined;
    // The identity is created inside the managed.toml update, after its checks and before its write: a refused
    // root leaves no device.json, and a device.json that cannot be created leaves no bindings under its name.
    const made: { device?: Awaited<ReturnType<typeof ensureDevice>> } = {};
    const createDevice = async () => {
      made.device = await ensureDevice(ctx.io, paths, { role: "owner", name, clock: ctx.clock });
      return made.device;
    };
    const writes = changes.length > 0 || store !== undefined;
    if (writes) {
      const written = await writeRoots(ctx.io, paths, {
        device: name,
        cwd: ctx.cwd,
        changes,
        ...(store !== undefined && { store }),
        beforeWrite: createDevice,
      });
      if (!written.ok) return written;
      findings = written.value.findings;
      writtenRoots = written.value.roots;
      writtenStore = written.value.store;
    }
    const device = made.device ?? (await createDevice());
    if (!device.ok) return device;
    const { id, role } = device.value.device;

    // The store: its identity, its restic repository, and this device's record of its id (D45). A store that cannot
    // be reached yet (its disk unplugged) or used by this build stays recorded, with a warning to run init again.
    const reloaded = await new ConfigLoader(ctx.io, paths).load({ env: ctx.env });
    if (!reloaded.ok) return reloaded;
    const storeName = writtenStore?.name ?? ctx.store ?? reloaded.value.config.defaultStore;
    const storeConfig = storeName === undefined ? undefined : reloaded.value.config.stores[storeName];
    let setUp: StoreSetup | undefined;
    if (storeName !== undefined && storeConfig !== undefined) {
      const ready = await setUpStore(ctx.io, {
        paths,
        env: ctx.env,
        name: storeName,
        store: storeConfig,
        opener: ctx.stores,
        mint: () => ulid(ctx.clock.now().getTime()),
      });
      if (ready.ok) setUp = ready.value;
      else if (ready.finding.code === "store.unreachable" || ready.finding.code === "store.unsupported") {
        findings = [
          ...findings,
          finding("store.setup-pending", {
            message: `store ${storeName} is recorded but not set up yet: ${ready.finding.message}`,
            fix: "plainport init --yes once the store is reachable",
            ...(ready.finding.paths === undefined ? {} : { paths: ready.finding.paths }),
          }),
        ];
      } else return ready;
    }
    const shownStore =
      setUp !== undefined && storeName !== undefined
        ? { name: storeName, path: writtenStore?.path ?? setUp.path, id: setUp.id }
        : writtenStore;
    const storeChanged =
      setUp !== undefined && (setUp.identityCreated || setUp.repositoryCreated || setUp.recorded);
    return ok({
      device: { id, name: device.value.device.name, role, created: device.value.created },
      roots: writtenRoots,
      ...(shownStore !== undefined && { store: shownStore }),
      files: { config: paths.configFile, managed: paths.managedFile, device: paths.deviceFile },
      changed: writes || device.value.created || storeChanged,
      findings,
    });
  },
});
