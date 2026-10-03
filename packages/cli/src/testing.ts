// Test helpers for the CLI: a fake registry that covers every risk class, a dry-run plan, --plan, option-level
// risk, a repeatable option, a multi-word name, a streaming handler and buggy ones; fake ports that never reach the
// real home folder or a real store; and a runner that captures stdout, stderr and the exit code.
// Used only by *.test.ts files.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, join as joinPath } from "node:path";
import { fsBlobStore } from "@plainport/blob-fs";
import { ok } from "@plainport/contract";
import { nodeLocalIo, type StoreOpener, storeRoot } from "@plainport/core";
import { nodePlugin } from "@plainport/eco-node";
import { z } from "zod";
import { quietChecks } from "../../core/src/testing/checks.ts";
import {
  type FakeEngineHooks,
  type FakeRepository,
  fakeEngine,
  fakeRepository,
} from "../../core/src/testing/fake-engine.ts";
import { testHost } from "../../core/src/testing/host.ts";
import { help } from "./commands/help.ts";
import { REGISTRY } from "./commands/index.ts";
import { type IO, run } from "./main.ts";
import type { Prompter } from "./prompt.ts";
import { type CommandContext, defineCommand, type Ports, type Registry } from "./registry.ts";

export const seen: { name: string; args: unknown; ctx: CommandContext }[] = [];

/** Plan ids the fake plan store treats as approved, as `<command> <id>`. */
export const approvedPlans = new Set<string>();

/** A prompter that fails the test: commands must not prompt unless a test injects one. */
export const noPrompts: Prompter = {
  multiselect: async ({ message }) => {
    throw new Error(`unexpected prompt: ${message}`);
  },
  text: async ({ message }) => {
    throw new Error(`unexpected prompt: ${message}`);
  },
};

const FAKE_HOME = join(tmpdir(), "plainport-fake-home-never-created");

/** PATH for the children commands run (git); nothing else of the real environment. */
const PATH = process.env.PATH ?? "/usr/bin:/bin";

/** The repository password the fake ports' environment holds (DEFAULT_LOCAL_SECRET reads it). */
export const STORE_PASSWORD = "test-store-password";

/** Every fake repository, by its folder, so the runs of one test share what they wrote. */
const fakeRepositories = new Map<string, FakeRepository>();
/** Hooks for the fake engine of the store at a folder, for tests that edit files mid-upload or damage a listing. */
export const fakeEngineHooks = new Map<string, FakeEngineHooks>();

/** The fake repository of the store at this folder (its repo/ inside), made on first use. */
export const fakeRepositoryAt = (storeFolder: string): FakeRepository => {
  const key = joinPath(storeFolder, "repo");
  let repository = fakeRepositories.get(key);
  if (repository === undefined) {
    repository = fakeRepository();
    fakeRepositories.set(key, repository);
  }
  return repository;
};

/** Local stores as the binary opens them, but with the fake engine (T0): events on disk through blob-fs. */
export const fakeStores = (home: string): StoreOpener => ({
  open: async (name, store) => {
    if (store.kind !== "local") throw new Error(`fake stores: ${name} is not local`);
    const root = storeRoot(store, home);
    return ok({
      blob: fsBlobStore(nodeLocalIo, root),
      engine: fakeEngine(fakeRepositoryAt(root), fakeEngineHooks.get(root) ?? {}),
    });
  },
});

/**
 * Ports for tests: a home folder that is never created, a fixed clock, the approvedPlans set, no prompts, a host
 * that refuses the real home, host checks that find nothing, and the Node plugin.
 */
export const fakePorts = (): Ports => ({
  host: { home: FAKE_HOME },
  clock: { now: () => new Date("2026-10-03T12:00:00Z") },
  plans: { approved: (command, id) => approvedPlans.has(`${command} ${id}`) },
  io: nodeLocalIo,
  env: { HOME: FAKE_HOME, PATH, PLAINPORT_STORE_PASSWORD: STORE_PASSWORD },
  cwd: FAKE_HOME,
  prompt: noPrompts,
  system: testHost(),
  checks: quietChecks,
  plugins: [nodePlugin],
  stores: fakeStores(FAKE_HOME),
});

/** Ports whose HOME (and cwd) is a test's sandbox, so commands read and write only inside it. */
export const sandboxPorts = (home: string, overrides: Partial<Ports> = {}): Ports => ({
  ...fakePorts(),
  host: { home },
  env: { HOME: home, PATH, PLAINPORT_STORE_PASSWORD: STORE_PASSWORD },
  cwd: home,
  stores: fakeStores(home),
  ...overrides,
});

const done = z.looseObject({ done: z.string() });
const human = (data: { done: string }) => `done: ${data.done}`;

export const FAKE_REGISTRY: Registry = [
  help,
  defineCommand({
    name: "show",
    summary: "Read something",
    risk: "read",
    dryRun: false,
    acceptsPlan: false,
    positionals: ["project"],
    args: z.strictObject({ project: z.string().optional().meta({ description: "A project" }) }),
    output: done,
    examples: [{ argv: ["show", "web"], summary: "Show web" }],
    human,
    handler: (args, ctx) => {
      seen.push({ name: "show", args, ctx });
      return ok({ done: `show ${args.project ?? ""}`.trim() });
    },
  }),
  defineCommand({
    name: "write",
    summary: "Write something that can be undone",
    risk: "safe_write",
    dryRun: false,
    acceptsPlan: false,
    positionals: ["project"],
    args: z.strictObject({
      project: z.string().meta({ description: "A project" }),
      adopt: z.boolean().optional().meta({ description: "Adopt what is there", risk: "confirm" }),
      to: z.string().optional().meta({ description: "Where to" }),
    }),
    output: done,
    examples: [{ argv: ["write", "web"], summary: "Write web" }],
    human,
    handler: (args, ctx) => {
      seen.push({ name: "write", args, ctx });
      return ok({ done: `write ${args.project}` });
    },
  }),
  defineCommand({
    name: "ship",
    summary: "Send something off this machine",
    risk: "confirm",
    dryRun: {
      plan: z.looseObject({ plan: z.string() }),
      human: (plan) => `plan: ${plan.plan}`,
    },
    acceptsPlan: true,
    positionals: ["projects"],
    args: z.strictObject({
      projects: z.array(z.string()).min(1).meta({ description: "Projects" }),
      plan: z.string().optional().meta({ description: "An approved plan id" }),
      allow: z.array(z.string()).optional().meta({ description: "Allow a finding" }),
      lie: z.boolean().optional().meta({ description: "Return the other mode's shape" }),
    }),
    output: done,
    examples: [
      { argv: ["ship", "web", "--yes"], summary: "Ship web" },
      { argv: ["ship", "web", "--dry-run"], summary: "Plan shipping web" },
    ],
    human,
    handler: (args, ctx) => {
      seen.push({ name: "ship", args, ctx });
      const planned = ctx.dryRun !== (args.lie === true);
      return planned
        ? ok({ plan: `ship ${args.projects.join(" ")}` })
        : ok({ done: `ship ${args.projects.join(" ")}` });
    },
  }),
  defineCommand({
    name: "root add",
    summary: "Add a root",
    risk: "safe_write",
    dryRun: false,
    acceptsPlan: false,
    positionals: ["key"],
    args: z.strictObject({ key: z.string().meta({ description: "The root's key" }) }),
    output: done,
    examples: [{ argv: ["root", "add", "work"], summary: "Add work" }],
    human,
    handler: (args) => ok({ done: `root add ${args.key}` }),
  }),
  defineCommand({
    name: "stream",
    summary: "Emit events, then finish",
    risk: "read",
    dryRun: false,
    acceptsPlan: false,
    positionals: [],
    args: z.strictObject({}),
    output: done,
    examples: [{ argv: ["stream"], summary: "Stream" }],
    human,
    handler: (_args, ctx) => {
      ctx.output.emit({ type: "phase", op: "01J9", phase: "scan", status: "start" });
      ctx.output.emit({
        type: "finding",
        op: "01J9",
        finding: {
          code: "git.unpushed",
          severity: "warn",
          message: "2 commits are not on origin",
          allowable: true,
        },
      });
      ctx.output.log("info", "scanning");
      ctx.output.log("debug", "deep detail");
      ctx.output.emit({ type: "phase", op: "01J9", phase: "scan", status: "end" });
      return ok({ done: "stream" });
    },
  }),
  defineCommand({
    name: "boom",
    summary: "A handler with a bug",
    risk: "read",
    dryRun: false,
    acceptsPlan: false,
    positionals: [],
    args: z.strictObject({}),
    output: done,
    examples: [],
    human,
    handler: (_args, ctx) => {
      ctx.output.emit({ type: "phase", op: "01J9", phase: "scan", status: "start" });
      throw new Error("kaboom");
    },
  }),
  defineCommand({
    name: "fragile",
    summary: "An argument schema with a bug",
    risk: "read",
    dryRun: false,
    acceptsPlan: false,
    positionals: ["word"],
    args: z.strictObject({
      word: z.string().transform((): string => {
        throw new Error("transform bug");
      }),
    }),
    output: done,
    examples: [],
    human,
    handler: () => ok({ done: "fragile" }),
  }),
];

/**
 * A sandboxed home where every registry example can run: device mbp set up with root work at ~/work (holding one
 * project, an empty git repository), store local, and the folders the examples name (~/personal,
 * ~/Developer/Work). cleanup() removes it.
 */
export const exampleHome = async (): Promise<{ home: string; ports: Ports; cleanup(): void }> => {
  const home = mkdtempSync(join(tmpdir(), "plainport-example-"));
  for (const dir of ["work/clients/acme/web", "personal", "Developer/Work"]) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  const git = Bun.spawnSync(["git", "init", "-q", join(home, "work/clients/acme/web")], {
    env: { PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (git.exitCode !== 0) throw new Error(`git init failed: ${git.stderr.toString()}`);
  const ports = sandboxPorts(home);
  const setup = await capture(
    ["init", "--root", "work=~/work", "--store-path", "~/store", "--device", "mbp", "--yes"],
    REGISTRY,
    { ports },
  );
  if (setup.code !== 0) {
    rmSync(home, { recursive: true, force: true });
    throw new Error(`example home setup failed: ${setup.err}`);
  }
  return { home, ports, cleanup: () => rmSync(home, { recursive: true, force: true }) };
};

export interface Captured {
  code: number;
  out: string;
  err: string;
}

/** Runs the CLI in process against `registry` and captures what it prints. No TTY unless asked. */
export const capture = async (
  argv: string[],
  registry: Registry = FAKE_REGISTRY,
  options: { isTTY?: boolean; stdout?: (text: string) => void; ports?: Ports } = {},
): Promise<Captured> => {
  let out = "";
  let err = "";
  const io: IO = {
    stdout:
      options.stdout ??
      ((text) => {
        out += text;
      }),
    stderr: (text) => {
      err += text;
    },
    isTTY: options.isTTY ?? false,
  };
  const code = await run(argv, io, options.ports ?? fakePorts(), registry);
  return { code, out, err };
};
