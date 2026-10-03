// The offload planner (DESIGN.md "Offload process" steps 2 to 5): preflight, scan, the strip set, then the Plan
// that --dry-run prints and an approved run carries out. It only reads: the folder, git's index, the config files.
//
// Preflight's findings, blockers included, go into the plan, so one dry run shows everything to fix. The one
// exception is a folder preflight cannot clear for reading (placeholders, folders it cannot search): it is not
// scanned, so there is no plan, and the planner fails with the first blocker after reporting every finding.

import { join } from "node:path";
import { type Finding, fail, finding, ok, type Result } from "@plainport/contract";
import type { ConfigLoader } from "../config/load.ts";
import type { Env } from "../paths.ts";
import type { CheckContext, HostChecks } from "../ports/checks.ts";
import type { EcosystemPlugin, HydrateStep } from "../ports/ecosystem.ts";
import type { HostPorts } from "../ports/host.ts";
import { preflight, scanFindings } from "../preflight/index.ts";
import { gitTracked } from "../scan/git.ts";
import { scanProject } from "../scan/index.ts";
import type { Manifest } from "../scan/manifest.ts";
import { ulid } from "../ulid.ts";
import { type ArrivalItem, PLAN_TTL_MS, type Plan } from "./schema.ts";
import { type ProposedStrip, resolveStripSet } from "./strip.ts";

export const OFFLOAD_PHASES = [
  "resolve",
  "preflight",
  "scan",
  "plan",
  "snapshot",
  "verify",
  "commit",
  "release",
] as const satisfies Plan["phases"];

export interface OffloadPlanRequest {
  /** The project folder. */
  dir: string;
  project: { address: string; root: string; path: string; id?: string };
  /** Loads the configuration with the project's .plainport.toml, once the folder is known safe to read. */
  loader: ConfigLoader;
  /** The environment: config variables, and what git and the host checks are given. */
  env: Env;
  now: Date;
  /** --store: overrides the root's store and the default one. */
  store?: string;
  /** --keep-deps: installed dependencies travel in the snapshot. */
  keepDeps?: boolean;
  signal?: AbortSignal;
  /** Told each finding when no plan can be made, before the failure returns. */
  onFinding?(finding: Finding): void;
}

const LARGEST = 10;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Folders holding a repository of their own (a .git folder or pointer), relative; "" is the project folder. */
const repositories = (manifest: Manifest): string[] => {
  const repos: string[] = [];
  for (const entry of manifest) {
    if (entry.path === ".git") repos.push("");
    else if (entry.path.endsWith("/.git") && !entry.path.slice(0, -5).split("/").includes(".git"))
      repos.push(entry.path.slice(0, -"/.git".length));
  }
  return repos.sort();
};

/** git.unpushed becomes the blocker git.unpushed-required when the config requires pushed work (D30). */
const required = (f: Finding): Finding =>
  finding("git.unpushed-required", {
    message: `requirePushed is set: ${f.message}`,
    ...(f.fix === undefined ? {} : { fix: f.fix }),
    ...(f.paths === undefined ? {} : { paths: f.paths }),
  });

/** The repository folder (.git, vendor/lib/.git) a path lies in, if any. */
const gitFolderOf = (path: string): string | undefined => {
  if (path.startsWith(".git/")) return ".git";
  const at = path.indexOf("/.git/");
  return at === -1 ? undefined : path.slice(0, at + "/.git".length);
};

const arrivalOf = (step: HydrateStep): ArrivalItem => ({
  part: "deps",
  outcome: "hydrate",
  detail: step.path === "" ? step.command : `in ${step.path}: ${step.command}`,
});

export const planOffload = async (
  host: HostPorts,
  checks: HostChecks,
  plugins: readonly EcosystemPlugin[],
  req: OffloadPlanRequest,
): Promise<Result<Plan>> => {
  const ctx: CheckContext = { env: req.env, ...(req.signal === undefined ? {} : { signal: req.signal }) };
  const checked = await preflight(host, checks, req.dir, ctx);
  if (!checked.ok) return checked;
  const report = checked.value;
  if (!report.safeToRead) {
    for (const f of report.findings) req.onFinding?.(f);
    const blocker = report.findings.find((f) => f.severity === "block");
    return fail(
      blocker ??
        finding("fs.unreadable", {
          message: `${req.dir} could not be cleared for reading, so it was not scanned`,
          paths: [req.dir],
        }),
    );
  }

  const loaded = await req.loader.load({ env: req.env, projectDir: req.dir, root: req.project.root });
  if (!loaded.ok) return loaded;
  const { config } = loaded.value;

  const scanned = await scanProject(host, req.dir, ctx, report);
  if (!scanned.ok) return scanned;
  const { tree } = scanned.value;
  const { manifest } = tree;

  const findings: Finding[] = [...loaded.value.findings, ...report.findings];
  for (const f of scanFindings(scanned.value)) {
    findings.push(f.code === "git.unpushed" && config.offload.requirePushed ? required(f) : f);
  }

  const keepDeps = req.keepDeps === true || config.deps.mode === "keep";
  const candidates: ProposedStrip[] = [];
  const steps: HydrateStep[] = [];
  for (const plugin of plugins) {
    const detection = await plugin.detect({ dir: req.dir, manifest, fs: host.fs });
    if (detection === null) continue;
    const pluginCtx = { dir: req.dir, manifest, fs: host.fs, detection };
    for (const c of await plugin.strip(pluginCtx)) candidates.push({ ...c, plugin: plugin.id });
    if (plugin.preflight !== undefined) findings.push(...(await plugin.preflight(pluginCtx)));
    steps.push(...(await plugin.hydrate(pluginCtx)).steps);
  }

  const repos = repositories(manifest);
  const strip = await resolveStripSet({
    manifest,
    candidates,
    extra: config.strip.extra,
    keep: config.strip.keep,
    never: config.strip.never,
    keepDeps,
    repos,
    tracked: (repo, paths) => gitTracked(host, repo === "" ? req.dir : join(req.dir, repo), ctx, paths),
  });
  if (!strip.ok) return strip;
  // Candidates kept for a reason a person may want to change: why 612 MB stayed is part of the plan.
  const shown = strip.value.kept.filter((k) => k.why !== "missing" && k.why !== "inside");
  if (shown.length > 0) {
    findings.push(
      finding("strip.kept", {
        message: `${plural(shown.length, "proposed path")} ${shown.length === 1 ? "stays" : "stay"} in the snapshot: ${shown
          .slice(0, 10)
          .map((k) => `${k.path} (${k.detail})`)
          .join(", ")}${shown.length > 10 ? ", …" : ""}`,
        paths: shown
          .map((k) => k.path)
          .sort()
          .slice(0, 100),
      }),
    );
  }
  const nested = repos.filter((r) => r !== "");
  if (nested.length > 0) {
    findings.push(
      finding("git.nested-repos", {
        message: `${plural(nested.length, "repository", "repositories")} inside the project ${nested.length === 1 ? "travels" : "travel"} as files, ${nested.length === 1 ? "its" : "their"} own .git included: ${nested.slice(0, 5).join(", ")}${nested.length > 5 ? ", …" : ""}`,
        paths: nested.slice(0, 100),
      }),
    );
  }

  const stripped = new Set(strip.value.entries.map((e) => e.path));
  let files = 0;
  let bytes = 0;
  // A repository's own folder counts as one line in largest (D37): its files mean nothing to strip patterns.
  const gitFolders = new Map<string, number>();
  const largest: Plan["include"]["largest"] = [];
  const consider = (candidate: { path: string; bytes: number }) => {
    if (largest.length === LARGEST && (largest[LARGEST - 1] as { bytes: number }).bytes >= candidate.bytes)
      return;
    largest.push(candidate);
    largest.sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (largest.length > LARGEST) largest.pop();
  };
  for (const entry of manifest) {
    if (entry.type !== "file") continue;
    let left = stripped.has(entry.path);
    for (
      let slash = entry.path.indexOf("/");
      !left && slash !== -1;
      slash = entry.path.indexOf("/", slash + 1)
    )
      left = stripped.has(entry.path.slice(0, slash));
    if (left) continue;
    const size = entry.size ?? 0;
    files++;
    bytes += size;
    const folder = gitFolderOf(entry.path);
    if (folder === undefined) consider({ path: entry.path, bytes: size });
    else gitFolders.set(folder, (gitFolders.get(folder) ?? 0) + size);
  }
  for (const [path, size] of gitFolders) consider({ path, bytes: size });

  const arrival: ArrivalItem[] =
    steps.length === 0
      ? []
      : keepDeps
        ? [{ part: "deps", outcome: "restore", detail: "installed dependencies travel in the snapshot" }]
        : steps.map(arrivalOf);
  const store = req.store ?? config.roots[req.project.root]?.store ?? config.defaultStore;

  return ok({
    id: ulid(req.now.getTime()),
    kind: "offload",
    project: { ...req.project, dir: req.dir, ...(store === undefined ? {} : { store }) },
    fingerprint: tree.fingerprint,
    include: { files, bytes, largest },
    strip: strip.value.entries,
    findings,
    phases: [...OFFLOAD_PHASES],
    ...(arrival.length === 0 ? {} : { arrival }),
    estimate: { uploadBytes: bytes },
    expiresAt: new Date(req.now.getTime() + PLAN_TTL_MS).toISOString(),
  });
};
