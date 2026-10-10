// Hydration (DESIGN.md "Onload process" steps 7 and 8, "Plugin interfaces → Node plugin"): bring a restored project's
// dependencies back with its own package manager. The plugins read the project (detection, the tool versions it asks
// for, the frozen install of each install root) and run nothing; this module meets the toolchain and runs the
// installs, each through the one process runner (AGENTS.md rule 6) with an idle and an overall deadline, its output
// streamed as log events.
//
// Toolchain: a version pinned by a file a version manager reads (.nvmrc, .node-version, .tool-versions, mise.toml) is
// activated through the first manager on PATH, mise, then fnm, then Volta: the install runs as `mise exec node@<v> --
// <install>`, `fnm exec --using=<v> -- <install>` or `volta run --node <v> <install>`. Without a manager (or with
// only a range, such as engines.node), the active version of each tool is compared and toolchain.mismatch warns;
// the install still runs with what is there.
//
// Trust (D54): a project's .plainport.toml hydrate.command and hooks are code from the repository and run only after
// `plainport trust`, which M1 does not have; they never run here, and the report lists them as untrusted. The
// plugin's frozen install runs with package scripts enabled.
//
// A failed install never undoes a restore: the project is restored-unhydrated (registry.json `unhydrated`), exit 10,
// and `plainport hydrate` (runHydrate) retries. `plainport dehydrate` (runDehydrate) is the way back: it removes the
// installed dependencies a plugin claims and git does not track, nothing else.

import { join, relative, sep } from "node:path";
import {
  type Failure,
  type Finding,
  fail,
  failWith,
  finding,
  ok,
  type Result,
  type StreamEvent,
  shellWord,
} from "@plainport/contract";
import type { ConfigLoader } from "../config/load.ts";
import { deleteGuard } from "../delete-guard.ts";
import { type LocalFs, systemErrorCode } from "../io.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import { dehydrateSet } from "../plan/planner.ts";
import type { HostChecks } from "../ports/checks.ts";
import type { EcosystemPlugin, HydrateStep, ToolRequirement } from "../ports/ecosystem.ts";
import type { HostPorts } from "../ports/host.ts";
import { preflight } from "../preflight/index.ts";
import { ensureRegistered, updateRegistry } from "../registry.ts";
import type { ProjectRef } from "../roots/address.ts";
import { canonicalPath } from "../roots/canonical.ts";
import { refreshIndex } from "../scan/git.ts";
import type { Manifest } from "../scan/manifest.ts";
import { scanTree } from "../scan/walk.ts";
import { secretVariables } from "../store.ts";
import { ulid } from "../ulid.ts";
import { nestedProjects, registeredFolders, withProjectLock } from "./project-gate.ts";

export type HydrateStepReport = {
  /** The install root, relative to the project; "" is the project folder. */
  path: string;
  /** The install as a person would type it, without a version manager's wrapper. */
  command: string;
  ok: boolean;
  /** The install's exit code when it ran and failed; null when a signal ended it. */
  exitCode?: number | null;
  /** Set when Corepack supplied the package manager (its shim is what `command` ran). */
  via?: "corepack";
};

export type HydrateReport = {
  /**
   * installed: every install ran and succeeded. failed: one failed (restored-unhydrated). skipped: --no-hydrate.
   * reused: the folder came back with its dependencies (renamed back from the trash). none: nothing to install.
   */
  status: "installed" | "failed" | "skipped" | "reused" | "none";
  steps: HydrateStepReport[];
  /** What the project file asks to run that M1 never runs, untrusted (D54): hydrate.command, hooks.<name>. */
  untrusted: string[];
  /** Why nothing was installed, when the status is reused. */
  reason?: string;
};

export interface HydrateDeps {
  host: HostPorts;
  plugins: readonly EcosystemPlugin[];
  /** The user's environment: the installs run with it, without plainport's and its engines' variables (D79). */
  env: Env;
  /**
   * Reads the configuration: the variables its `env:` secret references name are left out of the installs'
   * environment, and the project file's commands are reported as untrusted.
   */
  loader?: ConfigLoader;
  op: string;
  emit(event: StreamEvent): void;
  log(level: "debug" | "info" | "warn", message: string): void;
  /** Stops the running install's whole process group. */
  signal?: AbortSignal;
}

/** An install that prints nothing for this long is stopped (process.idle-timeout). */
const INSTALL_IDLE_MS = 10 * 60_000;
/** No install may take longer than this (process.timeout). */
const INSTALL_TIMEOUT_MS = 60 * 60_000;
const VERSION_TIMEOUT_MS = 30_000;

/**
 * Corepack must never wait on a prompt to download a package manager, nor write the manager it used into the
 * project's package.json (M2 Task 3). Set after the user's own values, whatever they are.
 */
const COREPACK_POLICY = { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", COREPACK_ENABLE_AUTO_PIN: "0" } as const;

/** Variables only plainport and its engines read: a store password or a restic or rclone setting may be among them. */
const PRIVATE_PREFIXES = ["PLAINPORT_", "RESTIC_", "RCLONE_"];

/**
 * The installs' environment (D79): the user's, without unset entries, without plainport's, restic's and rclone's
 * variables, and without `secrets`, the variables a configured `env:` secret reference names. Package scripts run
 * with it, so no store password reaches them.
 */
const installEnv = (env: Env, secrets: readonly string[] = []): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (
      value !== undefined &&
      !PRIVATE_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
      !secrets.includes(name)
    )
      out[name] = value;
  return { ...out, ...COREPACK_POLICY };
};

/** Where a program is on the env's PATH, if it is anywhere. */
const onPath = async (host: HostPorts, env: Env, name: string): Promise<string | undefined> => {
  for (const folder of (env.PATH ?? "").split(":")) {
    if (folder === "") continue;
    if (await host.fs.executable(join(folder, name))) return join(folder, name);
  }
  return undefined;
};

const COREPACK_MANAGERS: ReadonlySet<string> = new Set(["pnpm", "yarn", "npm"]);

/**
 * Whether the package manager the install will run is Corepack's shim: a link that resolves into the corepack
 * package. It is looked up the way the install finds it: through the version manager's own environment when the
 * install is wrapped, else on the install's PATH.
 */
const suppliedByCorepack = async (
  host: HostPorts,
  env: Record<string, string>,
  toolchain: Toolchain,
  name: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<boolean> => {
  // Corepack shims only these three; anything else is never asked about.
  if (!COREPACK_MANAGERS.has(name)) return false;
  try {
    let found: string | undefined;
    if (toolchain.manager === undefined) found = await onPath(host, env, name);
    else {
      const argv = toolchain.wrap(["sh", "-c", `command -v ${shellWord(name)}`]);
      const ran = await host.run({
        command: argv[0] as string,
        args: argv.slice(1),
        cwd,
        env,
        timeoutMs: VERSION_TIMEOUT_MS,
        idleTimeoutMs: VERSION_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
      });
      if (ran.ok && ran.value.exitCode === 0) found = ran.value.stdout.text.trim().split("\n")[0];
    }
    return (
      found !== undefined && found !== "" && (await host.fs.realpath(found)).split(sep).includes("corepack")
    );
  } catch {
    return false; // a path the host refuses or cannot read: not credited to Corepack
  }
};

export interface Toolchain {
  /** The install's argv, run through the version manager that activates the pinned version, if any. */
  wrap(argv: readonly string[]): string[];
  /** toolchain.mismatch warnings. */
  findings: Finding[];
  /** The manager that activates the pinned version: mise, fnm or volta. */
  manager?: string;
}

const MANAGERS = ["mise", "fnm", "volta"] as const;
const EXACT = /^v?\d+(?:\.\d+){0,2}$/;

/** An exact or partial version (20, 20.11, v20.11.0), as a semver range; an alias (lts/*, latest) is undefined. */
const asRange = (version: string): string | undefined => {
  const trimmed = version.trim().replace(/^v(?=\d)/, "");
  if (trimmed === "" || /^[a-z]/i.test(trimmed)) return undefined;
  return trimmed;
};

/** The version a tool's --version prints: the first x.y.z in it. */
const parseVersion = (text: string): string | undefined => /(\d+\.\d+\.\d+)/.exec(text)?.[1];

/**
 * How the installs meet the project's tool versions (see the file comment): the pinned node version through a
 * version manager on PATH, else a comparison with the active versions that warns on a mismatch.
 */
export const resolveToolchain = async (
  host: HostPorts,
  env: Env,
  requirements: readonly ToolRequirement[],
  signal?: AbortSignal,
  /** The project folder: versions are asked there, where shims read the project's own pins. */
  cwd = "/",
): Promise<Toolchain> => {
  const findings: Finding[] = [];
  // Only an exact or partial version (20, 20.11, v20.11.0) is handed to a manager; a range is compared instead.
  const pinned = requirements.find((r) => r.tool === "node" && r.pinned && EXACT.test(r.version.trim()));
  let manager: (typeof MANAGERS)[number] | undefined;
  if (pinned !== undefined) {
    for (const name of MANAGERS) {
      if ((await onPath(host, env, name)) !== undefined) {
        manager = name;
        break;
      }
    }
  }
  const handled = manager === undefined ? undefined : pinned;
  const active = new Map<string, string | undefined>();
  const versionOf = async (tool: string): Promise<string | undefined> => {
    if (active.has(tool)) return active.get(tool);
    const ran = await host.run({
      command: tool,
      args: ["--version"],
      cwd,
      env: installEnv(env),
      timeoutMs: VERSION_TIMEOUT_MS,
      idleTimeoutMs: VERSION_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    const version =
      ran.ok && ran.value.exitCode === 0
        ? parseVersion(`${ran.value.stdout.text} ${ran.value.stderr.text}`)
        : undefined;
    active.set(tool, version);
    return version;
  };
  for (const requirement of requirements) {
    // The manager meets the pinned node version, so only other requirements of node are compared.
    if (handled !== undefined && requirement.tool === "node") continue;
    const range = asRange(requirement.version);
    if (range === undefined) continue;
    const version = await versionOf(requirement.tool);
    let fits: boolean;
    try {
      fits = version !== undefined && Bun.semver.satisfies(version, range);
    } catch {
      continue; // not a range Bun can read: nothing to compare
    }
    if (fits) continue;
    findings.push(
      finding("toolchain.mismatch", {
        message: `${requirement.source} asks for ${requirement.tool} ${requirement.version}, but ${
          version === undefined
            ? `${requirement.tool} is not on PATH`
            : `${requirement.tool} ${version} is active`
        }; the install runs with what is there`,
        fix:
          requirement.tool === "node"
            ? `install node ${requirement.version} with mise, fnm or Volta (plainport uses whichever is on PATH), then plainport hydrate`
            : `install ${requirement.tool} ${requirement.version} (corepack enable can provide it), then plainport hydrate`,
      }),
    );
  }
  const wrap = (argv: readonly string[]): string[] => {
    if (handled === undefined || manager === undefined) return [...argv];
    const version = asRange(handled.version) as string;
    if (manager === "mise") return ["mise", "exec", `node@${version}`, "--", ...argv];
    if (manager === "fnm") return ["fnm", "exec", `--using=${version}`, "--", ...argv];
    return ["volta", "run", "--node", version, ...argv];
  };
  return { wrap, findings, ...(manager === undefined ? {} : { manager }) };
};

/** The tail of what an install said, for the failure's message. */
const said = (text: string): string => {
  const lines = text
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return lines.length === 0 ? "" : `: ${lines.slice(-3).join(" / ")}`;
};

/**
 * Meets the toolchain and runs every plugin's install in the project folder (see the file comment). A failed install
 * stops the rest and is returned as `failure` (hydrate.failed) beside the report; the files are never touched.
 */
export const hydrateProject = async (
  deps: HydrateDeps,
  dir: string,
  address: string,
): Promise<{ report: HydrateReport; failure?: Failure }> => {
  const { host, op } = deps;
  const phase = (name: "toolchain" | "hydrate", status: "start" | "end") =>
    deps.emit({ type: "phase", op, phase: name, status });
  const untrusted: string[] = [];
  const failed = (message: string, steps: HydrateStepReport[], fix?: string) => ({
    report: { status: "failed" as const, steps, untrusted },
    failure: fail(
      finding("hydrate.failed", {
        message,
        fix: fix ?? `plainport hydrate ${shellWord(address)}`,
        paths: [dir],
      }),
    ),
  });

  /** Ctrl-C (D56): the restore stands, the dependencies are not installed, and plainport hydrate retries. */
  const stopped = (steps: HydrateStepReport[]) => ({
    report: { status: "failed" as const, steps, untrusted },
    failure: fail(
      finding("operation.cancelled", {
        message: `${address} is restored, but its install was stopped; its dependencies are not installed (restored-unhydrated)`,
        fix: `plainport hydrate ${shellWord(address)}`,
        paths: [dir],
      }),
    ),
  });

  // The installs run package scripts (D54): no variable a configured secret reference names may reach them (D79).
  let secrets: string[] = [];
  if (deps.loader !== undefined) {
    // The stores are global settings, read without the project file (which cannot name one), and fail closed.
    const global = await deps.loader.load({ env: deps.env });
    if (!global.ok)
      return failed(
        `${address} is restored, but its install did not run: the configuration could not be read, so plainport cannot tell which variables hold a store's password (${global.finding.message})`,
        [],
        `${(global.finding.fix ?? "fix the configuration").replace(/, then re-run$/, "")}, then plainport hydrate ${shellWord(address)}`,
      );
    secrets = secretVariables(global.value.config);
    const loaded = await deps.loader.load({ env: deps.env, projectDir: dir });
    if (loaded.ok) {
      if (loaded.value.config.hydrate?.command !== undefined) untrusted.push("hydrate.command");
      for (const name of Object.keys(loaded.value.config.hooks ?? {}).sort()) untrusted.push(`hooks.${name}`);
    }
    if (untrusted.length > 0)
      deps.log(
        "info",
        `${address}'s .plainport.toml asks to run ${untrusted.join(", ")}; it is code from the repository, and this version of plainport never runs it (trusting a project arrives in a later milestone), so it was skipped`,
      );
  }
  const env = installEnv(deps.env, secrets);

  phase("toolchain", "start");
  const scanned = await scanTree(host.fs, dir);
  if (!scanned.ok)
    return failed(`${dir} could not be read to plan the install: ${scanned.finding.message}`, []);
  const manifest = scanned.value.manifest;
  const installs: HydrateStep[] = [];
  const requirements: ToolRequirement[] = [];
  for (const plugin of deps.plugins) {
    const detection = await plugin.detect({ dir, manifest, fs: host.fs });
    if (detection === null) continue;
    const ctx = { dir, manifest, fs: host.fs, detection };
    if (plugin.toolchain !== undefined) requirements.push(...(await plugin.toolchain(ctx)));
    installs.push(...(await plugin.hydrate(ctx)).steps);
  }
  const toolchain = await resolveToolchain(host, env, requirements, deps.signal, dir);
  for (const f of toolchain.findings) deps.emit({ type: "finding", op, finding: f });
  if (toolchain.manager !== undefined)
    deps.log(
      "info",
      `the installs run through ${toolchain.manager}, which activates the project's node version`,
    );
  phase("toolchain", "end");

  phase("hydrate", "start");
  const steps: HydrateStepReport[] = [];
  for (const step of installs) {
    if (deps.signal?.aborted) return stopped(steps);
    const argv = toolchain.wrap(step.argv);
    const cwd = step.path === "" ? dir : join(dir, ...step.path.split("/"));
    const via = (await suppliedByCorepack(host, env, toolchain, step.argv[0] as string, cwd, deps.signal))
      ? { via: "corepack" as const }
      : {};
    const where = step.path === "" ? address : `${address} (${step.path})`;
    const ran = await host.run({
      command: argv[0] as string,
      args: argv.slice(1),
      cwd,
      env,
      idleTimeoutMs: INSTALL_IDLE_MS,
      timeoutMs: INSTALL_TIMEOUT_MS,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      log: { op, emit: (event) => deps.log(event.level, event.message) },
    });
    if (!ran.ok) {
      steps.push({ path: step.path, command: step.command, ok: false, ...via });
      if (ran.finding.code === "process.cancelled" || deps.signal?.aborted) return stopped(steps);
      return failed(
        `${where} is restored, but ${step.command} could not run: ${ran.finding.message}`,
        steps,
        ran.finding.code === "process.spawn-failed"
          ? `install ${step.argv[0]} (or put it on PATH), then plainport hydrate ${shellWord(address)}`
          : undefined,
      );
    }
    const { exitCode, signal: killed } = ran.value;
    if (exitCode !== 0) {
      steps.push({ path: step.path, command: step.command, ok: false, exitCode, ...via });
      return failed(
        `${where} is restored, but ${step.command} ${
          exitCode === null ? `was ended by ${killed}` : `failed with exit code ${exitCode}`
        }${said(ran.value.stderr.text || ran.value.stdout.text)}; the files are safe and the dependencies are not installed`,
        steps,
      );
    }
    steps.push({ path: step.path, command: step.command, ok: true, ...via });
  }
  // The index's stat data is stale after a restore: one refresh, so the first git status is not slow.
  if (manifest.get(".git") !== undefined) {
    const refreshed = await refreshIndex(host, dir, {
      env,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
    if (!refreshed)
      deps.log("debug", `git update-index --refresh in ${dir} did not finish; git does it later`);
  }
  phase("hydrate", "end");
  return { report: { status: steps.length === 0 ? "none" : "installed", steps, untrusted } };
};

export type HydratePlanStep = {
  /** The install root, relative to the project; "" is the project folder. */
  path: string;
  /** The install as a person would type it, e.g. npm ci. */
  command: string;
  /** The package manager it runs (the first word of the command). */
  packageManager: string;
  /** Set when the manager the install will run is Corepack's shim; absent when that cannot be told before the restore. */
  via?: "corepack";
};

/** What an onload would install (onload --dry-run, D71). */
export type HydratePlan = {
  /** install: these commands run. reused: the folder comes back with its dependencies. skipped: not asked for. none: nothing to install. */
  status: "install" | "reused" | "skipped" | "none";
  reason?: string;
  steps: HydratePlanStep[];
  /**
   * With steps: the toolchain the install meets. `pinnedBy` lists the version files in the snapshot (.nvmrc,
   * .node-version, .tool-versions, mise.toml); `manager` is the version manager on PATH that would activate the pinned
   * version (mise, fnm or Volta). Their contents, and package.json's packageManager and engines, are read after the
   * restore, so the versions themselves are not shown.
   */
  toolchain?: { pinnedBy: string[]; manager?: string };
  /**
   * Always false: what the project file asks to run that this version never runs (D54) is read from the restored
   * .plainport.toml, so a preview cannot say; `untrusted` is deliberately absent, never an empty list.
   */
  untrustedKnown: false;
};

const VERSION_FILES = [".nvmrc", ".node-version", ".tool-versions", "mise.toml", ".mise.toml"];

/**
 * The install an onload would run for a snapshot not yet restored (D71), from its file list alone: the plugins
 * see the snapshot's entries but every file reads as missing, so the package manager comes from the lockfiles and
 * the commands are the frozen installs those choose. Nothing is run beyond looking for the version managers and
 * Corepack on PATH, and nothing is written.
 */
export const previewHydrate = async (
  deps: { host: HostPorts; plugins: readonly EcosystemPlugin[]; env: Env },
  manifest: Manifest,
  dir: string,
): Promise<HydratePlan> => {
  const { host } = deps;
  const absent = Object.assign(new Error("not restored yet"), { code: "ENOENT" });
  const fs: LocalFs = Object.create(host.fs, {
    readText: { value: async () => Promise.reject(absent) },
  });
  const steps: HydrateStep[] = [];
  for (const plugin of deps.plugins) {
    const detection = await plugin.detect({ dir, manifest, fs });
    if (detection === null) continue;
    steps.push(...(await plugin.hydrate({ dir, manifest, fs, detection })).steps);
  }
  if (steps.length === 0) {
    return {
      status: "none",
      reason: "no ecosystem plugin finds dependencies to install",
      steps: [],
      untrustedKnown: false,
    };
  }
  const pinnedBy = VERSION_FILES.filter((name) => manifest.get(name)?.type === "file");
  let manager: string | undefined;
  if (pinnedBy.length > 0)
    for (const name of MANAGERS) {
      if ((await onPath(host, deps.env, name)) !== undefined) {
        manager = name;
        break;
      }
    }
  const env = installEnv(deps.env);
  const planned: HydratePlanStep[] = [];
  for (const step of steps) {
    const name = step.argv[0] as string;
    // A version manager around the install may swap the tool: Corepack is then known only after the restore.
    const via =
      manager === undefined &&
      (await suppliedByCorepack(host, env, { wrap: (argv) => [...argv], findings: [] }, name, dir))
        ? { via: "corepack" as const }
        : {};
    planned.push({ path: step.path, command: step.command, packageManager: name, ...via });
  }
  return {
    status: "install",
    steps: planned,
    toolchain: { pinnedBy, ...(manager === undefined ? {} : { manager }) },
    untrustedKnown: false,
  };
};

/** Records whether the project's dependencies are installed (registry.json `unhydrated`). */
export const markHydrated = async (
  host: HostPorts,
  paths: PlainportPaths,
  id: string,
  hydrated: boolean,
): Promise<Result<void>> => {
  const updated = await updateRegistry(host, paths, (registry) => {
    const entry = registry.projects[id];
    if (entry === undefined) return ok(registry);
    const { unhydrated: _, ...rest } = entry;
    return ok({
      ...registry,
      projects: { ...registry.projects, [id]: hydrated ? rest : { ...rest, unhydrated: true } },
    });
  });
  return updated.ok ? ok(undefined) : updated;
};

export interface HydrateCommandDeps extends Omit<HydrateDeps, "op"> {
  paths: PlainportPaths;
  now?: () => Date;
}

export type HydrateOutcome = {
  op: string;
  exitCode: 0 | 10;
  project: string;
  dir: string;
  hydrate: HydrateReport;
};

/** The project's folder on this device, checked to be a folder; project.not-found when it is not here. */
const folderOf = async (host: HostPorts, ref: ProjectRef, verb: string): Promise<Result<string>> => {
  const dir = ref.dir;
  const notHere = (detail: string) =>
    fail(
      finding("project.not-found", {
        message: `${ref.address} ${detail}, so there is nothing here to ${verb}`,
        fix:
          ref.stub !== undefined || detail.includes("shelved")
            ? `it is shelved: plainport onload ${shellWord(ref.address)} brings it back`
            : `plainport root bind ${ref.root} <path> if the root lives elsewhere on this device`,
      }),
    );
  if (dir === undefined) return notHere("has no folder on this device");
  try {
    if ((await host.fs.lstat(dir)).kind !== "dir") return notHere(`is not a folder at ${dir}`);
    return ok(dir);
  } catch (error) {
    const code = systemErrorCode(error);
    if (code === "ENOENT") return notHere(`has no folder at ${dir} (it may be shelved)`);
    return fail(
      finding("fs.unreadable", {
        message: `${dir} cannot be inspected (${code})`,
        fix: `check that you can read ${shellWord(dir)}, then re-run`,
        paths: [dir],
      }),
    );
  }
};

/** `plainport hydrate`: installs a project's dependencies again, under its lock; exit 10 when the install fails. */
export const runHydrate = async (
  deps: HydrateCommandDeps,
  req: { project: ProjectRef },
): Promise<Result<HydrateOutcome>> => {
  const { host, paths } = deps;
  const clock = () => deps.now?.() ?? host.clock.now();
  const op = ulid(clock().getTime());
  const ref = req.project;
  const located = await folderOf(host, ref, "hydrate");
  if (!located.ok) return located;
  const dir = located.value;
  const registered = await ensureRegistered(
    host,
    paths,
    { ...(ref.id === undefined ? {} : { id: ref.id }), root: ref.root, path: ref.path },
    () => ulid(clock().getTime()),
    clock().toISOString(),
  );
  if (!registered.ok) return registered;
  const id = registered.value.id;
  // The registered projects nested with this one are locked too (D53, D56).
  const folders = await registeredFolders(host, paths, deps.env);
  if (!folders.ok) return folders;
  const related = await nestedProjects(host, paths, folders.value, { id, folder: dir });
  if (!related.ok) return related;
  const nested = related.value;
  const gate = { io: host, paths, clock, log: deps.log };
  return withProjectLock(
    gate,
    { id, address: ref.address },
    async () => {
      // Looked at again under the lock: an offload may have finished in between.
      const here = await folderOf(host, ref, "hydrate");
      if (!here.ok) return here;
      const done = await hydrateProject({ ...deps, op }, dir, ref.address);
      const marked = await markHydrated(host, paths, id, done.failure === undefined);
      if (!marked.ok) deps.log("warn", `registry.json was not updated: ${marked.finding.message}`);
      const outcome: HydrateOutcome = {
        op,
        exitCode: done.failure === undefined ? 0 : 10,
        project: ref.address,
        dir,
        hydrate: done.report,
      };
      if (done.failure?.exitCode === 130) return done.failure;
      if (done.failure !== undefined) return failWith(done.failure.finding, outcome, 10);
      return ok(outcome);
    },
    { related: nested },
  );
};

export interface DehydrateDeps extends HydrateCommandDeps {
  checks: HostChecks;
}

export type DehydrateOutcome = {
  op: string;
  project: string;
  dir: string;
  removed: { path: string; bytes: number }[];
  freedBytes: number;
};

/**
 * `plainport dehydrate`: removes the project's installed dependencies, only those a plugin claims as installed
 * dependencies and git does not track (AGENTS.md rule 2), never while a process works in the folder.
 */
export const runDehydrate = async (
  deps: DehydrateDeps,
  req: { project: ProjectRef },
): Promise<Result<DehydrateOutcome>> => {
  const { host, paths } = deps;
  const clock = () => deps.now?.() ?? host.clock.now();
  const op = ulid(clock().getTime());
  const ref = req.project;
  const located = await folderOf(host, ref, "dehydrate");
  if (!located.ok) return located;
  const dir = located.value;
  const registered = await ensureRegistered(
    host,
    paths,
    { ...(ref.id === undefined ? {} : { id: ref.id }), root: ref.root, path: ref.path },
    () => ulid(clock().getTime()),
    clock().toISOString(),
  );
  if (!registered.ok) return registered;
  const id = registered.value.id;
  // The registered projects nested with this one are locked too (D53, D56).
  const folders = await registeredFolders(host, paths, deps.env);
  if (!folders.ok) return folders;
  const related = await nestedProjects(host, paths, folders.value, { id, folder: dir });
  if (!related.ok) return related;
  const nested = related.value;
  const gate = { io: host, paths, clock, log: deps.log };
  return withProjectLock(
    gate,
    { id, address: ref.address },
    async () => {
      // Looked at again under the lock: an offload may have finished in between.
      const here = await folderOf(host, ref, "dehydrate");
      if (!here.ok) return here;
      // A dev server or an editor in the folder would see its dependencies vanish: the same process checks offload has.
      const checked = await preflight(host, deps.checks, dir, {
        env: deps.env,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
      if (!checked.ok) return checked;
      const busy = checked.value.findings.find(
        (f) => f.severity === "block" && (f.code.startsWith("proc.") || f.code === "env.docker-mount"),
      );
      if (busy !== undefined) return fail(busy);
      const set = await dehydrateSet(host, deps.plugins, {
        dir,
        loader: deps.loader,
        env: deps.env,
        root: ref.root,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
      if (!set.ok) return set;
      const removed: DehydrateOutcome["removed"] = [];
      // A registered inner project's dependencies are its own to remove (D56): its subtree is left alone.
      const canon = await canonicalPath(host, dir, paths.home);
      if (!canon.ok) return canon;
      const inner = nested.filter((n) => n.inside).map((n) => relative(canon.value.real, n.canon.real));
      const within = (path: string) => inner.some((p) => path === p || path.startsWith(`${p}/`));
      // Whatever was removed, the project is unhydrated from then on, however the run ends (N2).
      const markUnhydrated = async () => {
        const marked = await markHydrated(host, paths, id, false);
        if (!marked.ok) deps.log("warn", `registry.json was not updated: ${marked.finding.message}`);
      };
      for (const entry of set.value.filter((e) => !within(e.path))) {
        // Ctrl-C between removals: what is gone is regenerable, and plainport hydrate puts it back.
        if (deps.signal?.aborted) {
          if (removed.length > 0) await markUnhydrated();
          return fail(
            finding("operation.cancelled", {
              message: `dehydrate of ${ref.address} was stopped after ${removed.length} of its dependency folders were removed`,
              fix: `plainport hydrate ${shellWord(ref.address)} puts them back, or re-run plainport dehydrate to finish`,
            }),
          );
        }
        const path = join(dir, ...entry.path.split("/"));
        // The one guard before every recursive delete (D87): a dependency folder lies inside its project by design,
        // but never holds a mount, a store or another project.
        const guarded = await deleteGuard({ io: host, paths, env: deps.env }, path, { insideProject: true });
        if (!guarded.ok) {
          if (removed.length > 0) await markUnhydrated();
          return guarded;
        }
        try {
          await host.fs.removeTree(path);
        } catch (error) {
          const code = systemErrorCode(error);
          // Part of it may be gone already.
          await markUnhydrated();
          return fail(
            finding("fs.write-failed", {
              message: `${path} could not be removed (${code}); what was removed before it is regenerable, and plainport hydrate puts it back`,
              fix: `check the permissions of ${shellWord(path)}, then re-run`,
              paths: [path],
            }),
          );
        }
        removed.push({ path: entry.path, bytes: entry.bytes });
      }
      if (removed.length > 0) await markUnhydrated();
      return ok({
        op,
        project: ref.address,
        dir,
        removed,
        freedBytes: removed.reduce((sum, r) => sum + r.bytes, 0),
      });
    },
    { related: nested },
  );
};
