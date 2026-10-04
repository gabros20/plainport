// `scripts/install`: installs plainport from this checkout the way ADR-0020 lays it out. Flags: --prefix <dir>
// (default ~/.local, from $HOME), --tools <dir> (the restic and rclone to bundle; default .tools/<os>-<arch>/ in the
// checkout), --rollback (make the previous version current again instead of installing).
//
// The layout under the prefix:
//   share/plainport/versions/<version>/   plainport, restic and rclone, read-only
//   share/plainport/current               symlink to versions/<version>: the active version
//   share/plainport/previous              symlink to the version current pointed at before: the rollback target
//   bin/plainport                         symlink to share/plainport/current/plainport
// A release installs under its version; a dev build under <version>+<UTC build time>.<commit>, so every dev install
// is its own rollback point. A version already installed is activated again, not rebuilt. Each switch of current or
// previous is one atomic symlink replace, and nothing is ever deleted: every installed version stays.
//
// The binary is built by scripts/build.ts with --installed, so it is an installed build: it finds restic and rclone
// only beside itself and never walks up into a checkout, and its missing-tool fix says to reinstall (Task 2's N1).
// Scripts may spawn directly and report failures as a message plus a non-zero exit (run decisions D8 and D10).

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { hostTarget, TOOL_NAMES } from "../packages/core/src/tools.ts";
import { buildCommand } from "./build.ts";

export type Layout = {
  prefix: string;
  share: string;
  versions: string;
  current: string;
  previous: string;
  bin: string;
};

export const layout = (prefix: string): Layout => {
  const share = join(resolve(prefix), "share", "plainport");
  return {
    prefix: resolve(prefix),
    share,
    versions: join(share, "versions"),
    current: join(share, "current"),
    previous: join(share, "previous"),
    bin: join(resolve(prefix), "bin", "plainport"),
  };
};

/** The folder name a build installs under: a release's version, or a dev build's version, build time and commit. */
export const versionName = (version: string, commit: string, now: Date = new Date()): string => {
  if (!version.endsWith("-dev")) return version;
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${version}+${stamp}.${commit}`;
};

const linkTarget = (path: string): string | undefined => {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
};

/** The version a link under share/plainport names, if it is one of ours. */
const linkedVersion = (path: string): string | undefined => {
  const target = linkTarget(path);
  return target?.startsWith("versions/") ? target.slice("versions/".length) : undefined;
};

export type InstallState = { current: string | undefined; previous: string | undefined; versions: string[] };

export const readState = (prefix: string): InstallState => {
  const paths = layout(prefix);
  let versions: string[] = [];
  try {
    versions = readdirSync(paths.versions)
      .filter((name) => !name.startsWith("."))
      .sort();
  } catch {}
  return { current: linkedVersion(paths.current), previous: linkedVersion(paths.previous), versions };
};

/** Points `link` at `target` in one rename, so a reader sees the old link or the new one, never none. */
const replaceLink = (link: string, target: string): void => {
  const temp = `${link}.tmp-${process.pid}-${Date.now()}`;
  symlinkSync(target, temp);
  try {
    renameSync(temp, link);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
};

export type Outcome<T> = ({ ok: true } & T) | { ok: false; message: string };

/** bin/plainport is ours when it is missing or already a symlink through current; anything else is refused. */
const binProblem = (paths: Layout): string | undefined => {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(paths.bin);
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink() && linkTarget(paths.bin) === join(paths.current, "plainport")) return undefined;
  return `${paths.bin} exists and is not plainport's link to ${join(paths.current, "plainport")}; move it away and run again`;
};

/**
 * Installs one version: `stage` fills a fresh folder, which becomes versions/<version>, read-only. The version current
 * pointed at is recorded as previous, then current is switched. A version that is already there is only activated.
 */
export const installVersion = (
  prefix: string,
  version: string,
  stage: (dir: string) => void,
): Outcome<{ version: string; previous: string | undefined; reused: boolean }> => {
  const paths = layout(prefix);
  const problem = binProblem(paths);
  if (problem !== undefined) return { ok: false, message: problem };
  mkdirSync(paths.versions, { recursive: true });
  mkdirSync(join(paths.prefix, "bin"), { recursive: true });
  const dir = join(paths.versions, version);
  const reused = existsSync(dir);
  if (!reused) {
    const staging = mkdtempSync(join(paths.versions, ".staging-"));
    try {
      stage(staging);
      for (const name of readdirSync(staging)) chmodSync(join(staging, name), 0o555);
      // A folder moves only while writable (its .. changes), so it turns read-only once in place.
      renameSync(staging, dir);
      chmodSync(dir, 0o555);
    } catch (error) {
      removeInstall(staging);
      return { ok: false, message: `staging ${version} failed: ${(error as Error).message}` };
    }
  }
  const current = linkedVersion(paths.current);
  const previous = current === version ? linkedVersion(paths.previous) : current;
  if (previous !== undefined && current !== version) replaceLink(paths.previous, `versions/${previous}`);
  replaceLink(paths.current, `versions/${version}`);
  if (linkTarget(paths.bin) === undefined) replaceLink(paths.bin, join(paths.current, "plainport"));
  return { ok: true, version, previous, reused };
};

/** Makes previous current again, and records the version it replaces as the new previous. */
export const rollback = (prefix: string): Outcome<{ from: string; to: string }> => {
  const paths = layout(prefix);
  const { current, previous } = readState(prefix);
  if (current === undefined) return { ok: false, message: `nothing is installed under ${paths.share}` };
  if (previous === undefined || previous === current)
    return { ok: false, message: `there is no previous version to roll back to (current is ${current})` };
  if (!existsSync(join(paths.versions, previous, "plainport")))
    return { ok: false, message: `the previous version ${previous} is missing from ${paths.versions}` };
  replaceLink(paths.current, `versions/${previous}`);
  replaceLink(paths.previous, `versions/${current}`);
  return { ok: true, from: current, to: previous };
};

/** Removes an install tree or staging folder, read-only folders included (tests and failed stages). */
export const removeInstall = (path: string): void => {
  const writable = (dir: string): void => {
    try {
      chmodSync(dir, 0o755);
      for (const entry of readdirSync(dir, { withFileTypes: true }))
        if (entry.isDirectory()) writable(join(dir, entry.name));
    } catch {}
  };
  writable(path);
  rmSync(path, { recursive: true, force: true });
};

const git = (root: string, ...args: string[]): string => {
  const ran = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  return ran.exitCode === 0 ? ran.stdout.toString().trim() : "";
};

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      prefix: { type: "string" },
      tools: { type: "string" },
      rollback: { type: "boolean", default: false },
    },
  });
  const home = process.env.HOME;
  if (values.prefix === undefined && !home) {
    console.error("scripts/install: HOME is not set; pass --prefix <dir>");
    process.exit(2);
  }
  const prefix = resolve(values.prefix ?? join(home ?? "", ".local"));

  if (values.rollback) {
    const back = rollback(prefix);
    if (!back.ok) {
      console.error(`scripts/install: ${back.message}`);
      process.exit(1);
    }
    console.log(
      `plainport ${back.to} is current again (was ${back.from}); --rollback again returns to ${back.from}`,
    );
    process.exit(0);
  }

  const target = hostTarget();
  const tools = resolve(values.tools ?? join(root, ".tools", target ?? "unsupported"));
  const missing = TOOL_NAMES.filter((name) => !existsSync(join(tools, name)));
  if (missing.length > 0) {
    console.error(
      `scripts/install: ${missing.join(" and ")} not found in ${tools}; run \`bun scripts/fetch-tools.ts\` first`,
    );
    process.exit(1);
  }
  const version = readFileSync(join(root, "VERSION"), "utf8").trim();
  const commit = git(root, "rev-parse", "--short", "HEAD") || "unknown";
  const dirty = git(root, "status", "--porcelain", "--untracked-files=no") !== "";
  const name = versionName(version, dirty ? `${commit}.dirty` : commit);

  const installed = installVersion(prefix, name, (dir) => {
    const outfile = join(dir, "plainport");
    const built = Bun.spawnSync(buildCommand(process.execPath, root, { outfile, installed: true }), {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (built.exitCode !== 0) throw new Error(`bun build failed: ${built.stderr.toString().trim()}`);
    for (const tool of TOOL_NAMES) copyFileSync(join(tools, tool), join(dir, tool));
    const ran = Bun.spawnSync([outfile, "--version"], { stdout: "pipe", stderr: "pipe" });
    if (ran.exitCode !== 0 || !ran.stdout.toString().includes(version))
      throw new Error(`the built binary does not report ${version}: ${ran.stdout.toString().trim()}`);
  });
  if (!installed.ok) {
    console.error(`scripts/install: ${installed.message}`);
    process.exit(1);
  }
  const paths = layout(prefix);
  console.log(
    `plainport ${installed.version} ${installed.reused ? "was already installed and is current again" : "installed"} in ${join(paths.versions, basename(installed.version))}`,
  );
  console.log(`${paths.bin} → ${paths.current}/plainport`);
  if (installed.previous !== undefined)
    console.log(`previous: ${installed.previous} (scripts/install --rollback returns to it)`);
}
