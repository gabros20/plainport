// The strip set (DESIGN.md "Offload process" step 4, "Plugin interfaces → Contracts every plugin follows"): what
// the snapshot leaves out because it can be regenerated. Plugins propose and strip.extra adds; the core then keeps
// anything that
//
// - is not on disk (nothing to leave out),
// - the plugin itself declines, saying why (a node_modules no install puts back),
// - is installed dependencies while deps.mode is keep (or --keep-deps),
// - strip.keep or strip.never match: the candidate itself or a folder above it, never something inside it (D39),
// - holds a repository of its own, whose unpushed work could live nowhere else,
// - git tracks, in whole or in part (a tracked build/, a committed .yarn/cache),
//
// and collapses what is left to the outermost paths. "Gitignored does not mean disposable": nothing is stripped
// for being ignored, only for being claimed.

import { ok, type Result } from "@plainport/contract";
import type { StripCandidate } from "../ports/ecosystem.ts";
import type { Manifest } from "../scan/manifest.ts";
import { compilePatterns } from "./patterns.ts";
import type { StripEntry } from "./schema.ts";

export interface ProposedStrip extends StripCandidate {
  plugin: string;
}

export type KeptReason =
  | "missing"
  | "declined"
  | "keep-deps"
  | "protected"
  | "holds-repo"
  | "tracked"
  | "inside";

export interface StripInput {
  manifest: Manifest;
  candidates: readonly ProposedStrip[];
  /** strip.extra: more regenerable paths, in gitignore syntax. */
  extra: readonly string[];
  /** strip.keep and strip.never: paths never stripped. */
  keep: readonly string[];
  never: readonly string[];
  keepDeps: boolean;
  /** Folders holding a repository (their own .git, a folder or a pointer), relative; "" is the project folder. */
  repos: readonly string[];
  /** Which of the paths (relative to the repository) the repository at `repo` tracks. */
  tracked(repo: string, paths: string[]): Promise<Result<Set<string>>>;
}

export interface StripSet {
  /** Largest first, then by path. */
  entries: StripEntry[];
  /** Candidates the core kept, and why; `detail` says it to people, e.g. "strip.never matches a/cert.pem". */
  kept: { path: string; plugin: string; why: KeptReason; detail: string }[];
}

const inside = (path: string, folder: string): boolean => folder === "" || path.startsWith(`${folder}/`);

/** The path's folders, innermost last: a/b/c → a, a/b. */
const ancestors = (path: string): string[] => {
  const out: string[] = [];
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    out.push(path.slice(0, slash));
  }
  return out;
};

/** Whether the path is in a repository's own folder (.git, or a nested repository's .git). */
const inGitDir = (path: string): boolean =>
  path === ".git" || path.startsWith(".git/") || path.endsWith("/.git") || path.includes("/.git/");

/** A candidate path as a plain relative path, or undefined when it is not one (absolute, "..", empty). */
const normalized = (path: string): string | undefined => {
  const trimmed = path.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (trimmed === "" || trimmed.startsWith("/")) return undefined;
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  return trimmed;
};

/**
 * strip.extra's matches: the outermost entries the patterns strip, outside any repository's own folder. The last
 * matching pattern decides and a folder's state passes to what it holds, as in gitignore; a negation re-includes
 * (D39). A folder holding anything re-included is not stripped whole: what it holds is looked at one by one.
 */
const extraMatches = (manifest: Manifest, patterns: readonly string[]): ProposedStrip[] => {
  if (patterns.length === 0) return [];
  const all = compilePatterns(patterns);
  const each = patterns.map((pattern) => ({ pattern, set: compilePatterns([pattern]) }));
  /** Folders whose state is "strip". */
  const stripped = new Set<string>();
  /** Folders holding something re-included. */
  const mixed = new Set<string>();
  const hits: string[] = [];
  for (const entry of manifest) {
    if (inGitDir(entry.path)) continue;
    const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
    const inherited = stripped.has(parent);
    const state = all.decide(entry.path, entry.type) ?? inherited;
    if (state) {
      hits.push(entry.path);
      if (entry.type === "dir") stripped.add(entry.path);
    } else if (inherited || ancestors(entry.path).some((folder) => stripped.has(folder))) {
      for (const folder of ancestors(entry.path)) mixed.add(folder);
    }
  }
  const chosen = new Set<string>();
  const out: ProposedStrip[] = [];
  for (const path of hits) {
    if (mixed.has(path) || ancestors(path).some((folder) => chosen.has(folder))) continue;
    chosen.add(path);
    const by = [...each].reverse().find((p) => p.set.covers(path));
    out.push({
      path,
      plugin: "config",
      kind: "output",
      reason: `matches strip.extra ${by?.pattern ?? ""}`.trim(),
    });
  }
  return out;
};

export const resolveStripSet = async (input: StripInput): Promise<Result<StripSet>> => {
  const { manifest } = input;
  const kept: StripSet["kept"] = [];
  const keep = (c: ProposedStrip, why: KeptReason, detail: string) =>
    kept.push({ path: c.path, plugin: c.plugin, why, detail });

  const extras = extraMatches(manifest, input.extra);
  const protect = [
    { name: "strip.keep", set: compilePatterns(input.keep) },
    { name: "strip.never", set: compilePatterns(input.never) },
  ];

  const seen = new Set<string>();
  let remaining: ProposedStrip[] = [];
  for (const proposed of [...input.candidates, ...extras]) {
    const path = normalized(proposed.path);
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    const candidate = { ...proposed, path };
    // keep and never look at the candidate (or a folder above it), never inside it (D39).
    const covering = protect.find((p) => p.set.covers(path));
    const repo = input.repos.find((r) => r !== "" && (r === path || inside(r, path)));
    if (manifest.get(path) === undefined) keep(candidate, "missing", "it is not on disk");
    else if (candidate.declined !== undefined) keep(candidate, "declined", candidate.declined);
    else if (input.keepDeps && candidate.kind === "deps")
      keep(candidate, "keep-deps", "installed dependencies are kept (deps = keep, or --keep-deps)");
    else if (covering !== undefined) keep(candidate, "protected", `${covering.name} matches it`);
    else if (repo !== undefined)
      keep(candidate, "holds-repo", `it holds the repository ${repo === path ? "itself" : repo}`);
    else remaining.push(candidate);
  }

  // Ask each candidate's innermost repository whether it tracks the candidate.
  const byRepo = new Map<string, ProposedStrip[]>();
  for (const candidate of remaining) {
    const repo = input.repos
      .filter((r) => inside(candidate.path, r))
      .reduce<string | undefined>(
        (best, r) => (best === undefined || r.length > best.length ? r : best),
        undefined,
      );
    if (repo === undefined) continue;
    const list = byRepo.get(repo);
    if (list === undefined) byRepo.set(repo, [candidate]);
    else list.push(candidate);
  }
  const trackedPaths = new Set<string>();
  for (const [repo, candidates] of byRepo) {
    const local = candidates.map((c) => (repo === "" ? c.path : c.path.slice(repo.length + 1)));
    const answer = await input.tracked(repo, local);
    if (!answer.ok) return answer;
    for (const c of candidates) {
      if (answer.value.has(repo === "" ? c.path : c.path.slice(repo.length + 1))) trackedPaths.add(c.path);
    }
  }
  remaining = remaining.filter((c) => {
    if (!trackedPaths.has(c.path)) return true;
    keep(c, "tracked", "git tracks it");
    return false;
  });

  // Outermost only: one inside another is left out with it.
  const outer = new Set(remaining.map((c) => c.path));
  remaining = remaining.filter((c) => {
    if (!ancestors(c.path).some((folder) => outer.has(folder))) return true;
    keep(c, "inside", "it is inside another stripped path");
    return false;
  });

  const bytes = new Map(remaining.map((c) => [c.path, 0]));
  for (const entry of manifest) {
    if (entry.type !== "file") continue;
    const owner = [entry.path, ...ancestors(entry.path)].find((p) => bytes.has(p));
    if (owner !== undefined) bytes.set(owner, (bytes.get(owner) as number) + (entry.size ?? 0));
  }
  const entries = remaining
    .map((c) => ({ path: c.path, bytes: bytes.get(c.path) as number, plugin: c.plugin, reason: c.reason }))
    .sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return ok({ entries, kept });
};
