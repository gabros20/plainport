// plainport init (DESIGN.md "Roots" → Setting roots up, "CLI design"): names this device, sets up its roots and
// records the store their snapshots go to. Flags do it all (`--root work=~/work --store-path <path> --device mbp`);
// on a TTY without --no-input it asks for what the flags left out, starting with a scan of the likely folders.
// Without a TTY it never prompts: a missing answer is a usage error naming the exact flags to pass. Creating the
// restic repository itself arrives with the engine (run decision D22); init records the store in managed.toml.

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

/** Asks for roots: picks from the scan of likely folders, or one folder typed in, then a key for each. */
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
  positionals: [],
  args: z.strictObject({
    root: z
      .array(z.string())
      .optional()
      .meta({ description: `A root, as ${ROOT_FORM} (repeatable); without one, a TTY offers a scan` }),
    "store-path": z.string().min(1).optional().meta({
      description: "A local folder for the store, e.g. on an external disk; --store names it (default local)",
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
    store: z.looseObject({ name: z.string(), path: z.string() }).optional(),
    files: z.looseObject({ config: z.string(), managed: z.string(), device: z.string() }),
    findings: FindingsSchema,
  }),
  examples: [
    {
      argv: ["init", "--root", "work=~/work", "--store-path", "/Volumes/Archive/plainport", "--yes"],
      summary: "Set up without prompts",
    },
    { argv: ["init", "--yes"], summary: "Set up interactively, from a scan of likely folders" },
  ],
  human: (data) =>
    [
      `device ${data.device.name}${data.device.created ? " (new)" : ""}`,
      ...data.roots.map((r) => `root ${r.key}${r.path === undefined ? "" : ` at ${r.path}`}`),
      ...(data.store === undefined ? [] : [`store ${data.store.name} at ${data.store.path}`]),
      `settings written to ${data.files.managed}`,
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
        const asked = await askRoots(ctx, await rootCandidates(ctx.io, home));
        if (asked === undefined) return cancelled();
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
      const suggested = needRoots ? await rootCandidates(ctx.io, home) : [];
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
          message: `init needs ${missing}, and without a terminal it never prompts`,
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
          fix: "pass --device <name> with a lower-case word, e.g. --device mbp",
        }),
      );
    }

    const changes: RootChange[] = roots.map((r) =>
      config.roots[r.key] === undefined
        ? { kind: "add", key: r.key, path: r.path }
        : { kind: "bind", key: r.key, path: r.path },
    );
    const store = storePath === undefined ? undefined : { name: ctx.store ?? DEFAULT_STORE, path: storePath };
    let findings: z.output<typeof FindingsSchema> = [];
    let writtenRoots: { key: string; path?: string }[] = [];
    let writtenStore: { name: string; path: string } | undefined;
    if (changes.length > 0 || store !== undefined) {
      const written = await writeRoots(ctx.io, paths, {
        device: name,
        cwd: ctx.cwd,
        changes,
        ...(store !== undefined && { store }),
      });
      if (!written.ok) return written;
      findings = written.value.findings;
      writtenRoots = written.value.roots;
      writtenStore = written.value.store;
    }

    const device = await ensureDevice(ctx.io, paths, { role: "owner", name, clock: ctx.clock });
    if (!device.ok) return device;
    const { id, role } = device.value.device;
    return ok({
      device: { id, name: device.value.device.name, role, created: device.value.created },
      roots: writtenRoots,
      ...(writtenStore !== undefined && { store: writtenStore }),
      files: { config: paths.configFile, managed: paths.managedFile, device: paths.deviceFile },
      findings,
    });
  },
});
