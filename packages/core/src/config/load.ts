// Loading the configuration (DESIGN.md "Configuration"). Precedence, highest first: flags, environment variables,
// the project's .plainport.toml, config.toml, managed.toml, built-in defaults.
//
// A loader remembers the last good contents of each file it has read. When a file that loaded before fails to
// parse or check on a later load, its last good contents stay in effect and the load reports a
// config.kept-last-good warning; a file with no last good copy fails the load with config.invalid. The memory lives
// as long as the loader: the app and `serve` keep one, a CLI run builds a fresh one.

import { join } from "node:path";
import { type Finding, fail, finding, ok, type Result } from "@plainport/contract";
import type { Env, PlainportPaths } from "../paths.ts";
import { type ConfigIo, nodeConfigIo } from "./io.ts";
import { mergeLayers } from "./merge.ts";
import {
  type ConfigLayer,
  ConfigLayerSchema,
  DEFAULTS,
  ProjectConfigSchema,
  type ResolvedConfig,
  ResolvedConfigSchema,
} from "./schema.ts";
import { describeIssues, readTomlFile } from "./toml.ts";

export const PROJECT_FILE = ".plainport.toml";

export interface LoadOptions {
  /** Read for PLAINPORT_STORE. (PLAINPORT_CONFIG is read by resolvePaths; PLAINPORT_JSON by the CLI.) */
  env: Env;
  /** Settings from command-line flags, e.g. { defaultStore } from --store. */
  flags?: ConfigLayer;
  /** The project folder whose .plainport.toml applies, if any. */
  projectDir?: string;
}

export interface LoadedConfig {
  config: ResolvedConfig;
  /** Warnings, such as config.kept-last-good. */
  findings: Finding[];
  /** The files that were read, so a message can say where to edit. */
  files: { config: string; managed: string; project?: string };
}

/** The settings environment variables carry. */
export const envLayer = (env: Env): ConfigLayer =>
  env.PLAINPORT_STORE !== undefined && env.PLAINPORT_STORE !== ""
    ? { defaultStore: env.PLAINPORT_STORE }
    : {};

export class ConfigLoader {
  readonly #lastGood = new Map<string, unknown>();

  constructor(
    readonly paths: PlainportPaths,
    readonly io: ConfigIo = nodeConfigIo,
  ) {}

  /** One file's layer: its contents, nothing if it is absent, or its last good contents if it broke. */
  #layer(
    path: string,
    schema: typeof ConfigLayerSchema | typeof ProjectConfigSchema,
    required: boolean,
    findings: Finding[],
  ): Result<unknown> {
    const read = readTomlFile(this.io, path, schema);
    if (read.kind === "ok") {
      this.#lastGood.set(path, read.value);
      return ok(read.value);
    }
    if (read.kind === "missing") {
      this.#lastGood.delete(path);
      if (!required) return ok({});
      return fail(
        finding("config.not-found", {
          message: `the config file ${path} does not exist`,
          fix:
            this.paths.configFileSource === "flag"
              ? "pass --config the path of an existing file, or leave it out"
              : "point PLAINPORT_CONFIG at an existing file, or unset it",
          paths: [path],
        }),
      );
    }
    const where = read.line === undefined ? path : `${path} at line ${read.line}`;
    if (this.#lastGood.has(path)) {
      findings.push(
        finding("config.kept-last-good", {
          message: `${path} is not valid (${read.message}); its last good contents stay in effect`,
          fix: `fix ${where}; plainport picks it up on the next load`,
          paths: [path],
        }),
      );
      return ok(this.#lastGood.get(path));
    }
    return fail(
      finding("config.invalid", {
        message: `${path} is not valid: ${read.message}`,
        fix: `fix ${where}, then re-run`,
        paths: [path],
      }),
    );
  }

  load(options: LoadOptions): Result<LoadedConfig> {
    const { paths } = this;
    const findings: Finding[] = [];
    const flags = ConfigLayerSchema.safeParse(options.flags ?? {});
    if (!flags.success) {
      return fail(
        finding("usage.invalid", {
          message: `the command-line settings are not valid: ${describeIssues(flags.error)}`,
          fix: "plainport help",
        }),
      );
    }

    const managed = this.#layer(paths.managedFile, ConfigLayerSchema, false, findings);
    if (!managed.ok) return managed;
    const user = this.#layer(
      paths.configFile,
      ConfigLayerSchema,
      paths.configFileSource !== "default",
      findings,
    );
    if (!user.ok) return user;
    const projectFile = options.projectDir === undefined ? undefined : join(options.projectDir, PROJECT_FILE);
    const project =
      projectFile === undefined ? ok({}) : this.#layer(projectFile, ProjectConfigSchema, false, findings);
    if (!project.ok) return project;

    const merged = mergeLayers([
      DEFAULTS,
      managed.value,
      user.value,
      project.value,
      envLayer(options.env),
      flags.data,
    ]);
    const checked = ResolvedConfigSchema.safeParse(merged);
    const files = {
      config: paths.configFile,
      managed: paths.managedFile,
      ...(projectFile && { project: projectFile }),
    };
    if (!checked.success) {
      return fail(
        finding("config.invalid", {
          message: `the configuration merged from ${Object.values(files).join(", ")} is not valid: ${describeIssues(checked.error)}`,
          fix: `fix the setting named above in ${paths.configFile} or ${paths.managedFile}, then re-run`,
          paths: Object.values(files),
        }),
      );
    }
    return ok({ config: checked.data, findings, files });
  }
}
