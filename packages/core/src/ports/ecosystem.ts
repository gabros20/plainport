// The ecosystem plugin port (DESIGN.md "Plugin interfaces → EcosystemPlugin"). A plugin knows one language's
// dependencies: it detects a project, proposes what is regenerable, and says how to install it again. Plugins
// propose; the core decides (plan/strip.ts drops anything git tracks, then applies strip.keep and strip.never), and
// only the core ever deletes.
//
// Plugins read, never write: they look at the scan's manifest and read small files (package.json) through the file
// system port. hydrate() only names the commands; the onload saga runs them through the one runner (Task 13), and
// the plan shows them as arrival items.

import type { Finding } from "@plainport/contract";
import type { LocalFs } from "../io.ts";
import type { Manifest } from "../scan/manifest.ts";

/** The project as the scan found it. */
export interface ProjectDir {
  /** The project folder, absolute. */
  dir: string;
  /** Every entry below the folder, from the scan. */
  manifest: Manifest;
  fs: LocalFs;
}

export interface Detection {
  plugin: string;
  /** One line for people, e.g. "pnpm workspace (pnpm-lock.yaml)". */
  summary: string;
}

export interface PluginContext extends ProjectDir {
  detection: Detection;
}

export interface StripCandidate {
  /** Relative to the project folder, "/"-separated. */
  path: string;
  /** Why it is regenerable, e.g. "installed by npm ci from package-lock.json". */
  reason: string;
  /** deps: installed dependencies, kept when deps.mode is keep; output: build output and caches. */
  kind: "deps" | "output";
  /**
   * Set when the plugin saw the path but cannot claim it, with why (a node_modules no install puts back). The core
   * keeps it and says why in the plan (strip.kept).
   */
  declined?: string;
}

export interface HydrateStep {
  /** The folder to run in, relative to the project; "" is the project folder. */
  path: string;
  /** The command as a person would type it. */
  command: string;
  argv: string[];
}

export interface HydrateResult {
  steps: HydrateStep[];
}

/**
 * A tool version the project asks for (DESIGN.md "Onload process" step 7): read from .nvmrc, .node-version,
 * .tool-versions, mise.toml, package.json's engines or packageManager. The core decides how to meet it: through a
 * version manager that is installed (mise, fnm, Volta), else by comparing the active version and warning.
 */
export interface ToolRequirement {
  /** The tool, as its version manager and its own --version name it: node, pnpm, yarn, bun, npm. */
  tool: string;
  /** As the file writes it: an exact version (20.11.0), a partial one (20), a semver range (>=18), or an alias. */
  version: string;
  /** Where it was read, for messages: ".nvmrc", "package.json engines.node". */
  source: string;
  /** Pinned by a version file a manager reads (.nvmrc, .node-version, .tool-versions, mise.toml): one to activate. */
  pinned: boolean;
}

export interface EcosystemPlugin {
  id: string;
  detect(dir: ProjectDir): Promise<Detection | null>;
  /** Proposals only: the path and why it is regenerable. */
  strip(ctx: PluginContext): Promise<StripCandidate[]>;
  preflight?(ctx: PluginContext): Promise<Finding[]>;
  /** The tool versions the project asks for, read from its files; runs nothing. */
  toolchain?(ctx: PluginContext): Promise<ToolRequirement[]>;
  /** The install commands that bring the stripped dependencies back, in order. Names them; runs nothing. */
  hydrate(ctx: PluginContext): Promise<HydrateResult>;
}
