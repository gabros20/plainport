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

import { join } from "node:path";
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
import { systemErrorCode } from "../io.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import { dehydrateSet } from "../plan/planner.ts";
import type { HostChecks } from "../ports/checks.ts";
import type { EcosystemPlugin, HydrateStep, ToolRequirement } from "../ports/ecosystem.ts";
import type { HostPorts } from "../ports/host.ts";
import { preflight } from "../preflight/index.ts";
import { ensureRegistered, updateRegistry } from "../registry.ts";
import type { ProjectRef } from "../roots/address.ts";
import { refreshIndex } from "../scan/git.ts";
import { scanTree } from "../scan/walk.ts";
import { ulid } from "../ulid.ts";
import { nestedProjects, withProjectLock } from "./project-gate.ts";

export type HydrateStepReport = {
  /** The install root, relative to the project; "" is the project folder. */
  path: string;
  /** The install as a person would type it, without a version manager's wrapper. */
  command: string;
  ok: boolean;
  /** The install's exit code when it ran and failed; null when a signal ended it. */
  exitCode?: number | null;
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
};

export interface HydrateDeps {
  host: HostPorts;
  plugins: readonly EcosystemPlugin[];
  /** The user's environment: the installs run with it (plainport's own PLAINPORT_* variables left out). */
  env: Env;
  /** Reads the project file, to report what it asks to run untrusted. */
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

/** The installs' environment: the user's, without unset entries and without plainport's own variables (secrets). */
const installEnv = (env: Env): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (value !== undefined && !name.startsWith("PLAINPORT_")) out[name] = value;
  return out;
};

/** Where a program is on the env's PATH, if it is anywhere. */
const onPath = async (host: HostPorts, env: Env, name: string): Promise<string | undefined> => {
  for (const folder of (env.PATH ?? "").split(":")) {
    if (folder === "") continue;
    if (await host.fs.executable(join(folder, name))) return join(folder, name);
  }
  return undefined;
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
  if (deps.loader !== undefined) {
    const loaded = await deps.loader.load({ env: deps.env, projectDir: dir });
    if (loaded.ok) {
      if (loaded.value.config.hydrate?.command !== undefined) untrusted.push("hydrate.command");
      for (const name of Object.keys(loaded.value.config.hooks ?? {}).sort()) untrusted.push(`hooks.${name}`);
    }
    if (untrusted.length > 0)
      deps.log(
        "info",
        `${address}'s .plainport.toml asks to run ${untrusted.join(", ")}; it is code from the repository, and this version of plainport never runs it (plainport trust arrives later), so it was skipped`,
      );
  }
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
  const toolchain = await resolveToolchain(host, deps.env, requirements, deps.signal, dir);
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
    const where = step.path === "" ? address : `${address} (${step.path})`;
    const ran = await host.run({
      command: argv[0] as string,
      args: argv.slice(1),
      cwd,
      env: installEnv(deps.env),
      idleTimeoutMs: INSTALL_IDLE_MS,
      timeoutMs: INSTALL_TIMEOUT_MS,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      log: { op, emit: (event) => deps.log(event.level, event.message) },
    });
    if (!ran.ok) {
      steps.push({ path: step.path, command: step.command, ok: false });
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
      steps.push({ path: step.path, command: step.command, ok: false, exitCode });
      return failed(
        `${where} is restored, but ${step.command} ${
          exitCode === null ? `was ended by ${killed}` : `failed with exit code ${exitCode}`
        }${said(ran.value.stderr.text || ran.value.stdout.text)}; the files are safe and the dependencies are not installed`,
        steps,
      );
    }
    steps.push({ path: step.path, command: step.command, ok: true });
  }
  // The index's stat data is stale after a restore: one refresh, so the first git status is not slow.
  if (manifest.get(".git") !== undefined) {
    const refreshed = await refreshIndex(host, dir, {
      env: deps.env,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
    if (!refreshed)
      deps.log("debug", `git update-index --refresh in ${dir} did not finish; git does it later`);
  }
  phase("hydrate", "end");
  return { report: { status: steps.length === 0 ? "none" : "installed", steps, untrusted } };
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
  const nested = nestedProjects(registered.value.registry, { id, root: ref.root, path: ref.path });
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
  const nested = nestedProjects(registered.value.registry, { id, root: ref.root, path: ref.path });
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
      const inner = nested
        .filter((n) => n.inside && n.override === undefined)
        .map((n) => n.path.slice(ref.path.length + 1));
      const within = (path: string) => inner.some((p) => path === p || path.startsWith(`${p}/`));
      for (const entry of set.value.filter((e) => !within(e.path))) {
        // Ctrl-C between removals: what is gone is regenerable, and plainport hydrate puts it back.
        if (deps.signal?.aborted)
          return fail(
            finding("operation.cancelled", {
              message: `dehydrate of ${ref.address} was stopped after ${removed.length} of its dependency folders were removed`,
              fix: `plainport hydrate ${shellWord(ref.address)} puts them back, or re-run plainport dehydrate to finish`,
            }),
          );
        const path = join(dir, ...entry.path.split("/"));
        try {
          await host.fs.removeTree(path);
        } catch (error) {
          const code = systemErrorCode(error);
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
      if (removed.length > 0) {
        const marked = await markHydrated(host, paths, id, false);
        if (!marked.ok) deps.log("warn", `registry.json was not updated: ${marked.finding.message}`);
      }
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
