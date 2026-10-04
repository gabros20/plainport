// `scripts/install`: installs plainport from this checkout the way ADR-0020 lays it out. Flags: --prefix <dir>
// (default ~/.local, from $HOME), --tools <dir> (the restic and rclone to bundle; default .tools/<os>-<arch>/ in the
// checkout), --rollback (make the previous version current again instead of installing).
//
// The layout under the prefix:
//   share/plainport/versions/<version>/   plainport, restic and rclone, read-only
//   share/plainport/current               symlink to versions/<version>: the active version
//   share/plainport/previous              symlink to the version current pointed at before: the rollback target
//   bin/plainport                         symlink to share/plainport/current/plainport
// A release installs under its version and only from a clean tree; a dev build under <version>+<UTC build
// time>.<commit>[.dirty], so every dev install is its own rollback point. Each version folder holds build.json naming
// its commit: a version already installed from the same commit is activated again, not rebuilt, and one installed
// from another commit is refused. Each switch of current or previous is one atomic symlink replace. After an install,
// every version but current and previous is pruned; an install first sweeps what an interrupted one left (its own
// .staging-* folders and .tmp-* links, by name). The bundled restic and rclone must be the ones tools.lock.json pins
// (their pin files from `bun scripts/fetch-tools.ts`); --tools skips that check and says so.
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
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { hostTarget, TOOL_NAMES } from "../packages/core/src/tools.ts";
import { buildCommand } from "./build.ts";
import { parseLock, pinnedProblems } from "./fetch-tools.ts";

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

export type Outcome<T> = ({ ok: true } & T) | { ok: false; message: string };

/** The folder name a build installs under: a release's version, or a dev build's version, build time and commit. */
export const versionName = (version: string, commit: string, now: Date = new Date()): string => {
  if (!version.endsWith("-dev")) return version;
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${version}+${stamp}.${commit}`;
};

/** The name a build installs under, or why it can't be installed: a release needs a clean tree. */
export const planName = (options: {
  version: string;
  commit: string;
  dirty: boolean;
  now?: Date;
}): Outcome<{ name: string }> => {
  const { version, commit, dirty, now } = options;
  if (dirty && !version.endsWith("-dev"))
    return {
      ok: false,
      message: `the tree has uncommitted changes, so it is not release ${version}; commit or stash them first`,
    };
  return { ok: true, name: versionName(version, dirty ? `${commit}.dirty` : commit, now) };
};

/** Whether `git status --porcelain` output means the build would not be the commit: a tracked change anywhere, or an
 * untracked file under packages/, which the build compiles in. */
export const dirtyFromStatus = (porcelain: string): boolean =>
  porcelain
    .split("\n")
    .filter((line) => line.trim() !== "")
    .some((line) => !line.startsWith("?? ") || line.slice(3).startsWith("packages/"));

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

/** bin/plainport is ours when it is missing or already a symlink through current; current and previous when missing or
 * symlinks. Anything else is refused before anything is written. */
const linkProblem = (paths: Layout): string | undefined => {
  const kind = (path: string) => {
    try {
      return lstatSync(path).isSymbolicLink() ? "link" : "other";
    } catch {
      return "none";
    }
  };
  for (const link of [paths.current, paths.previous])
    if (kind(link) === "other")
      return `${link} is not a link scripts/install made; move it away and run again`;
  if (kind(paths.bin) === "none") return undefined;
  if (kind(paths.bin) === "link" && linkTarget(paths.bin) === join(paths.current, "plainport"))
    return undefined;
  return `${paths.bin} exists and is not plainport's link to ${join(paths.current, "plainport")}; move it away and run again`;
};

const STAGING = /^\.staging-[A-Za-z0-9]{6}$/;
const TEMP_LINK = (name: string) => new RegExp(`^${name.replace(".", "\\.")}\\.tmp-\\d+-\\d+$`);

/** Removes what an interrupted install left: its staging folders and temp links, matched by the names it gives them. */
const sweep = (paths: Layout): void => {
  const each = (dir: string, match: (name: string) => boolean, remove: (path: string) => void) => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {}
    for (const name of names) if (match(name)) remove(join(dir, name));
  };
  const unlinkIfLink = (path: string) => {
    if (lstatSync(path).isSymbolicLink()) rmSync(path);
  };
  each(paths.versions, (n) => STAGING.test(n), removeInstall);
  each(paths.share, (n) => TEMP_LINK("current").test(n) || TEMP_LINK("previous").test(n), unlinkIfLink);
  each(join(paths.prefix, "bin"), (n) => TEMP_LINK("plainport").test(n), unlinkIfLink);
};

/** The commit a version folder was built from (its build.json), if it says. */
const builtFrom = (dir: string): string | undefined => {
  try {
    return JSON.parse(readFileSync(join(dir, "build.json"), "utf8")).commit;
  } catch {
    return undefined;
  }
};

/**
 * Installs one version: `stage` fills a fresh folder, which becomes versions/<version>, read-only, with build.json when
 * the build's commit is given. The version current pointed at is recorded as previous, then current is switched, then
 * every other version is pruned. A version that is already there is only activated, and only if built from the same
 * commit.
 */
export const installVersion = (
  prefix: string,
  version: string,
  stage: (dir: string) => void,
  build?: { commit: string },
): Outcome<{ version: string; previous: string | undefined; reused: boolean; pruned: string[] }> => {
  const paths = layout(prefix);
  const problem = linkProblem(paths);
  if (problem !== undefined) return { ok: false, message: problem };
  try {
    mkdirSync(paths.versions, { recursive: true });
    mkdirSync(join(paths.prefix, "bin"), { recursive: true });
    sweep(paths);
  } catch (error) {
    return { ok: false, message: `preparing ${paths.share} failed: ${(error as Error).message}` };
  }
  const dir = join(paths.versions, version);
  const reused = existsSync(dir);
  if (reused && build !== undefined && builtFrom(dir) !== build.commit)
    return {
      ok: false,
      message: `${version} is already installed from commit ${builtFrom(dir) ?? "unknown"}, not ${build.commit}; bump VERSION, or remove ${dir} and run again`,
    };
  if (!reused) {
    let staging: string | undefined;
    try {
      staging = mkdtempSync(join(paths.versions, ".staging-"));
      stage(staging);
      if (build !== undefined)
        writeFileSync(join(staging, "build.json"), `${JSON.stringify({ version, commit: build.commit })}\n`);
      for (const name of readdirSync(staging)) chmodSync(join(staging, name), 0o555);
      // A folder moves only while writable (its .. changes), so it turns read-only once in place.
      renameSync(staging, dir);
      chmodSync(dir, 0o555);
    } catch (error) {
      if (staging !== undefined) removeInstall(staging);
      return { ok: false, message: `staging ${version} failed: ${(error as Error).message}` };
    }
  }
  const current = linkedVersion(paths.current);
  const previous = current === version ? linkedVersion(paths.previous) : current;
  try {
    if (previous !== undefined && current !== version) replaceLink(paths.previous, `versions/${previous}`);
    replaceLink(paths.current, `versions/${version}`);
    if (linkTarget(paths.bin) === undefined) replaceLink(paths.bin, join(paths.current, "plainport"));
  } catch (error) {
    return { ok: false, message: `activating ${version} failed: ${(error as Error).message}` };
  }
  const pruned = readState(prefix).versions.filter((name) => name !== version && name !== previous);
  for (const name of pruned) removeInstall(join(paths.versions, name));
  return { ok: true, version, previous, reused, pruned };
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
  try {
    replaceLink(paths.current, `versions/${previous}`);
    replaceLink(paths.previous, `versions/${current}`);
  } catch (error) {
    return { ok: false, message: `rolling back to ${previous} failed: ${(error as Error).message}` };
  }
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

const USAGE = "usage: scripts/install [--prefix <dir>] [--tools <dir>] [--rollback]";

/** Stops with a message and the exit code (D10). */
function stop(message: string, code = 1): never {
  console.error(`scripts/install: ${message}`);
  process.exit(code);
}

const main = (): void => {
  const root = resolve(import.meta.dir, "..");
  let values: { prefix?: string; tools?: string; rollback?: boolean };
  try {
    values = parseArgs({
      args: Bun.argv.slice(2),
      options: {
        prefix: { type: "string" },
        tools: { type: "string" },
        rollback: { type: "boolean", default: false },
      },
    }).values;
  } catch (error) {
    stop(`${(error as Error).message}\n${USAGE}`, 2);
  }
  const home = process.env.HOME;
  if (values.prefix === undefined && !home) stop("HOME is not set; pass --prefix <dir>", 2);
  const prefix = resolve(values.prefix ?? join(home ?? "", ".local"));

  if (values.rollback) {
    const back = rollback(prefix);
    if (!back.ok) stop(back.message);
    console.log(
      `plainport ${back.to} is current again (was ${back.from}); --rollback again returns to ${back.from}`,
    );
    return;
  }

  const target = hostTarget();
  if (target === undefined && values.tools === undefined)
    stop(`plainport ships no restic or rclone for ${process.platform}-${process.arch}; pass --tools <dir>`);
  const tools = resolve(values.tools ?? join(root, ".tools", target ?? ""));
  const missing = TOOL_NAMES.filter((name) => !existsSync(join(tools, name)));
  if (missing.length > 0)
    stop(`${missing.join(" and ")} not found in ${tools}; run \`bun scripts/fetch-tools.ts\` first`);
  if (values.tools !== undefined) {
    console.log(`--tools: restic and rclone are not checked against tools.lock.json (${tools})`);
  } else if (target !== undefined) {
    const lock = parseLock(JSON.parse(readFileSync(join(root, "tools.lock.json"), "utf8")));
    if (!lock.ok) stop(`tools.lock.json: ${lock.message}`);
    const stale = pinnedProblems(tools, lock.lock, target);
    if (stale.length > 0) stop(`${stale.join("; ")}; run \`bun scripts/fetch-tools.ts\` first`);
  }
  const version = readFileSync(join(root, "VERSION"), "utf8").trim();
  const commit = git(root, "rev-parse", "--short", "HEAD") || "unknown";
  const named = planName({ version, commit, dirty: dirtyFromStatus(git(root, "status", "--porcelain")) });
  if (!named.ok) stop(named.message);

  const installed = installVersion(
    prefix,
    named.name,
    (dir) => {
      const outfile = join(dir, "plainport");
      const built = Bun.spawnSync(buildCommand(process.execPath, root, { outfile, installed: true }), {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (built.exitCode !== 0) throw new Error(`bun build failed: ${built.stderr.toString().trim()}`);
      for (const tool of TOOL_NAMES) copyFileSync(join(tools, tool), join(dir, tool));
      const ran = Bun.spawnSync([outfile, "--version"], { stdout: "pipe", stderr: "pipe" });
      if (ran.exitCode !== 0 || ran.stdout.toString().trim() !== `plainport ${version}`)
        throw new Error(
          `the built binary does not report plainport ${version}: ${ran.stdout.toString().trim()}`,
        );
    },
    { commit },
  );
  if (!installed.ok) stop(installed.message);
  const paths = layout(prefix);
  console.log(
    `plainport ${installed.version} ${installed.reused ? "was already installed and is current again" : "installed"} in ${join(paths.versions, basename(installed.version))}`,
  );
  console.log(`${paths.bin} → ${paths.current}/plainport`);
  if (installed.previous !== undefined)
    console.log(`previous: ${installed.previous} (scripts/install --rollback returns to it)`);
  if (installed.pruned.length > 0) console.log(`pruned: ${installed.pruned.join(", ")}`);
};

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    stop(`unexpected failure: ${(error as Error).message}`);
  }
}
