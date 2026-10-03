// plainport root add | bind | list | scan (DESIGN.md "Roots", "CLI design"). add and bind write managed.toml and
// scan records what it finds in this device's registry.json, so all three are safe_write (run decision D23); list
// only reads.
// unbind and rename arrive later; bind --device for another device needs pairing (M3, run decision D22).

import { fail, finding, ok } from "@plainport/contract";
import { listRoots, readDevice, readRegistry, scanRoot, writeRoots } from "@plainport/core";
import { z } from "zod";
import { defineCommand } from "../registry.ts";
import { FindingsSchema, findingLines, thisDevice } from "./local.ts";

const key = z.string().meta({ description: "The root's key, a lower-case word such as work" });
const create = z.boolean().optional().meta({ description: "Create the folder if it does not exist" });

const WrittenRoot = z.looseObject({
  key: z.string(),
  path: z.string().optional().meta({ description: "This device's folder for the root, absolute" }),
});

const RootInfo = z.looseObject({
  key: z.string(),
  label: z.string().optional(),
  store: z.string().optional(),
  devices: z.array(z.string()).optional(),
  bindings: z
    .record(z.string(), z.string())
    .meta({ description: "Device name → folder, as the config writes it" }),
  path: z
    .string()
    .optional()
    .meta({ description: "This device's folder, absolute; absent when unbound here" }),
  state: z.enum(["ok", "unbound", "missing", "unavailable"]),
  source: z.enum(["config", "managed", "both"]).meta({ description: "Which config file defines the root" }),
  projects: z
    .number()
    .int()
    .nonnegative()
    .meta({ description: "Projects registered under it on this device" }),
});

export const rootList = defineCommand({
  name: "root list",
  summary: "Show every root, its folder on each device and its state here",
  risk: "read",
  dryRun: false,
  acceptsPlan: false,
  positionals: [],
  args: z.strictObject({}),
  output: z.looseObject({
    device: z.string().optional().meta({ description: "This device's name; absent before plainport init" }),
    roots: z.array(RootInfo),
    findings: FindingsSchema,
  }),
  examples: [{ argv: ["root", "list"], summary: "List roots" }],
  human: (data) => {
    if (data.roots.length === 0)
      return ["No roots yet: plainport init or plainport root add <key> <path>."].join("\n");
    const rows = data.roots.map((r) => [
      r.key,
      r.state,
      r.path ?? "(not bound here)",
      `${r.projects} project${r.projects === 1 ? "" : "s"}`,
      r.source === "both"
        ? "config.toml + managed.toml"
        : `${r.source === "config" ? "config" : "managed"}.toml`,
    ]);
    const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => (row[i] as string).length))) ?? [];
    const lines = rows.map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join("  ")
        .trimEnd(),
    );
    return [...lines, ...findingLines(data.findings)].join("\n");
  },
  handler: async (_args, ctx) => {
    const paths = ctx.paths();
    if (!paths.ok) return paths;
    const device = await readDevice(ctx.io, paths.value);
    if (!device.ok) return device;
    const name = device.value?.name;
    const listed = await listRoots(ctx.io, paths.value, {
      env: ctx.env,
      ...(name !== undefined && { device: name }),
    });
    if (!listed.ok) return listed;
    const registry = await readRegistry(ctx.io, paths.value);
    if (!registry.ok) return registry;
    const entries = Object.values(registry.value.projects);
    return ok({
      ...(name !== undefined && { device: name }),
      roots: listed.value.roots.map((r) => ({
        ...r,
        projects: entries.filter((e) => e.root === r.key).length,
      })),
      findings: listed.value.findings,
    });
  },
});

const written = z.looseObject({ root: WrittenRoot, findings: FindingsSchema });

const writtenHuman =
  (verb: string) =>
  (data: z.output<typeof written>): string =>
    [
      `${verb} root ${data.root.key}${data.root.path === undefined ? "" : ` at ${data.root.path}`}`,
      ...findingLines(data.findings),
    ].join("\n");

export const rootAdd = defineCommand({
  name: "root add",
  summary: "Add a root, optionally with this device's folder for it; the global --store sets its store",
  risk: "safe_write",
  dryRun: false,
  acceptsPlan: false,
  positionals: ["key", "path"],
  args: z.strictObject({
    key,
    path: z.string().optional().meta({ description: "This device's folder for the root" }),
    label: z.string().min(1).optional().meta({ description: "A display name, e.g. Work" }),
    create,
  }),
  output: written,
  examples: [
    { argv: ["root", "add", "personal", "~/personal"], summary: "Add root personal at ~/personal" },
    {
      argv: ["root", "add", "studio", "--label", "Studio", "--store", "mini"],
      summary: "Add a root, unbound here",
    },
  ],
  human: writtenHuman("added"),
  handler: async (args, ctx) => {
    const local = await thisDevice(ctx);
    if (!local.ok) return local;
    const result = await writeRoots(ctx.io, local.value.paths, {
      device: local.value.device.name,
      cwd: ctx.cwd,
      create: args.create === true,
      changes: [
        {
          kind: "add",
          key: args.key,
          ...(args.label !== undefined && { label: args.label }),
          ...(ctx.store !== undefined && { store: ctx.store }),
          ...(args.path !== undefined && { path: args.path }),
        },
      ],
    });
    if (!result.ok) return result;
    return ok({ root: result.value.roots[0] ?? { key: args.key }, findings: result.value.findings });
  },
});

export const rootBind = defineCommand({
  name: "root bind",
  summary: "Point a root at its folder on this device",
  risk: "safe_write",
  dryRun: false,
  acceptsPlan: false,
  positionals: ["key", "path"],
  args: z.strictObject({
    key,
    path: z.string().meta({ description: "The root's folder on this device" }),
    device: z
      .string()
      .optional()
      .meta({ description: "The device to bind; only this one until pairing arrives (M3)" }),
    create,
  }),
  output: written,
  examples: [{ argv: ["root", "bind", "work", "~/Developer/Work"], summary: "Move root work's folder here" }],
  human: writtenHuman("bound"),
  handler: async (args, ctx) => {
    const local = await thisDevice(ctx);
    if (!local.ok) return local;
    const { device, paths } = local.value;
    if (args.device !== undefined && args.device !== device.name) {
      return fail(
        finding("usage.invalid", {
          message: `this device is ${device.name}; binding a root on ${args.device} runs there over SSH, which arrives with device pairing in M3`,
          fix: `run plainport root bind ${args.key} <path> on ${args.device} itself`,
        }),
      );
    }
    const result = await writeRoots(ctx.io, paths, {
      device: device.name,
      cwd: ctx.cwd,
      create: args.create === true,
      changes: [{ kind: "bind", key: args.key, path: args.path }],
    });
    if (!result.ok) return result;
    return ok({ root: result.value.roots[0] ?? { key: args.key }, findings: result.value.findings });
  },
});

export const rootScan = defineCommand({
  name: "root scan",
  summary: "Find every project under a root's folder here and register the new ones",
  risk: "safe_write",
  dryRun: false,
  acceptsPlan: false,
  positionals: ["key"],
  args: z.strictObject({ key }),
  output: z.looseObject({
    root: z.string(),
    path: z.string(),
    projects: z.array(
      z.looseObject({
        id: z.string(),
        address: z.string(),
        path: z.string(),
        dir: z.string(),
        marker: z.string().meta({ description: ".git, package.json, pyproject.toml, Cargo.toml or go.mod" }),
        new: z.boolean().meta({ description: "Registered by this scan" }),
      }),
    ),
  }),
  examples: [{ argv: ["root", "scan", "work"], summary: "Register work's projects" }],
  human: (data) => {
    const added = data.projects.filter((p) => p.new).length;
    return [
      `${data.root} at ${data.path}: ${data.projects.length} project${data.projects.length === 1 ? "" : "s"}, ${added} new`,
      ...data.projects.map((p) => `  ${p.new ? "+" : " "} ${p.address}`),
    ].join("\n");
  },
  handler: async (args, ctx) => {
    const local = await thisDevice(ctx);
    if (!local.ok) return local;
    const scanned = await scanRoot(ctx.io, local.value.paths, {
      key: args.key,
      device: local.value.device.name,
      env: ctx.env,
      now: () => ctx.clock.now(),
    });
    if (!scanned.ok) return scanned;
    const { root, projects } = scanned.value;
    return ok({ root: root.key, path: root.path, projects });
  },
});
