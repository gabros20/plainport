// `scripts/install`: installs plainport from this checkout the way ADR-0020 lays it out. Flags: --prefix <dir>
// (default ~/.local, from $HOME), --tools <dir> (the restic and rclone to bundle; default .tools/<os>-<arch>/ in the
// checkout), --rollback (make the previous version current again instead of installing).
//
// The layout under the prefix:
//   share/plainport/versions/<version>/   plainport, restic and rclone, read-only
//   share/plainport/current               symlink to versions/<version>: the active version
//   share/plainport/previous              symlink to the version current pointed at before: the rollback target
//   bin/plainport                         symlink to share/plainport/current/plainport
// A release installs under its version, only from a clean git checkout; a dev build under <version>+<UTC build
// time>.<commit>[.dirty], so every dev install is its own rollback point. Each version folder holds build.json naming
// its commit: a version already installed from the same commit is activated again, not rebuilt, and one installed
// from another commit is refused. Each switch of current or previous is one atomic symlink replace. After an install,
// every version it made but current and previous is pruned; an install first sweeps what an interrupted one left (its
// own .staging-* folders and .tmp-* links, by name). Both judge every entry by lstat and never follow a link; anything
// they did not make is left alone with a notice. An mkdir lock keeps installs and rollbacks one at a time. The
// bundled restic and rclone must be the ones tools.lock.json pins (their pin files from `bun scripts/fetch-tools.ts`);
// --tools skips that check and says so.
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
  unlinkSync,
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
  /** The short commit, or undefined outside a git checkout. */
  commit: string | undefined;
  dirty: boolean;
  now?: Date;
}): Outcome<{ name: string }> => {
  const { version, dirty, now } = options;
  const release = !version.endsWith("-dev");
  if (release && options.commit === undefined)
    return {
      ok: false,
      message: `this is not a git checkout, so release ${version} can't be tied to its commit; install from a clone`,
    };
  const commit = options.commit ?? "unknown";
  if (dirty && release)
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

/** A release (`0.1.0`) or a dev build (`0.1.0-dev+20261004123456.abc1234[.dirty]`), as versionName names them. */
const VERSION_NAME = /^\d+\.\d+\.\d+(-dev\+\d{14}\.[0-9a-z]+(\.dirty)?)?$/;

/** Whether versions/<name> is a version this installer made: a real folder (never a link), named as it names them,
 * holding the build.json it writes. Nothing else under versions/ is ever pruned or listed as installed. */
const isOwnVersion = (versions: string, name: string): boolean => {
  if (!VERSION_NAME.test(name)) return false;
  try {
    const dir = lstatSync(join(versions, name));
    return dir.isDirectory() && lstatSync(join(versions, name, "build.json")).isFile();
  } catch {
    return false;
  }
};

export const readState = (prefix: string): InstallState => {
  const paths = layout(prefix);
  let versions: string[] = [];
  try {
    versions = readdirSync(paths.versions)
      .filter((name) => isOwnVersion(paths.versions, name))
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

/**
 * Removes what an interrupted install left, matched by the names it gives them and checked with lstat: real
 * .staging-XXXXXX folders, and .tmp-<pid>-<ms> symlinks, unlinked as links. A link is never followed. Anything else
 * with such a name, or that can't be removed, is left alone with a notice.
 */
const sweep = (paths: Layout, notices: string[]): void => {
  const names = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  for (const name of names(paths.versions).filter((n) => STAGING.test(n))) {
    const path = join(paths.versions, name);
    if (!lstatSync(path).isDirectory()) {
      notices.push(`left alone: ${path} (not a staging folder scripts/install made)`);
      continue;
    }
    try {
      removeInstall(path);
    } catch (error) {
      notices.push(`sweep of ${path} failed: ${(error as Error).message}`);
    }
  }
  const links: [string, RegExp[]][] = [
    [paths.share, [TEMP_LINK("current"), TEMP_LINK("previous")]],
    [join(paths.prefix, "bin"), [TEMP_LINK("plainport")]],
  ];
  for (const [dir, patterns] of links)
    for (const name of names(dir).filter((n) => patterns.some((p) => p.test(n)))) {
      const path = join(dir, name);
      if (!lstatSync(path).isSymbolicLink()) {
        notices.push(`left alone: ${path} (not a link scripts/install made)`);
        continue;
      }
      try {
        unlinkSync(path);
      } catch (error) {
        notices.push(`sweep of ${path} failed: ${(error as Error).message}`);
      }
    }
};

/**
 * Removes every version this installer made except `keep`, as notices for what it leaves: anything else under
 * versions/ (a link, a file, a folder it didn't make) and any removal that fails. A version still running from a
 * pruned folder loses the restic beside it; that takes two installs during one plainport run, and recover settles
 * the operation it stops (CONTRIBUTING.md).
 */
const prune = (paths: Layout, keep: ReadonlySet<string>, notices: string[]): string[] => {
  const pruned: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(paths.versions);
  } catch {}
  for (const name of names.filter((n) => !n.startsWith(".") && !keep.has(n)).sort()) {
    const path = join(paths.versions, name);
    if (!isOwnVersion(paths.versions, name)) {
      notices.push(`left alone: ${path} (not a version scripts/install made)`);
      continue;
    }
    try {
      removeInstall(path);
      pruned.push(name);
    } catch (error) {
      notices.push(`prune of ${name} failed: ${(error as Error).message}`);
    }
  }
  return pruned;
};

/** One install or rollback at a time: an mkdir lock in share/plainport, released when the call ends. */
const withLock = <T>(paths: Layout, run: () => Outcome<T>): Outcome<T> => {
  const lock = join(paths.share, ".install.lock");
  try {
    mkdirSync(paths.share, { recursive: true });
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return {
        ok: false,
        message: `another scripts/install is running (${lock} exists); if none is, remove that folder and run again`,
      };
    return { ok: false, message: `taking ${lock} failed: ${(error as Error).message}` };
  }
  try {
    writeFileSync(join(lock, "pid"), `${process.pid}\n`);
    return run();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
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
export type Installed = {
  version: string;
  previous: string | undefined;
  reused: boolean;
  pruned: string[];
  /** What the install left alone or could not clean up after it succeeded; printed as notices, exit 0. */
  notices: string[];
};

export const installVersion = (
  prefix: string,
  version: string,
  stage: (dir: string) => void,
  build?: { commit: string },
): Outcome<Installed> => {
  const paths = layout(prefix);
  const problem = linkProblem(paths);
  if (problem !== undefined) return { ok: false, message: problem };
  return withLock(paths, (): Outcome<Installed> => {
    const notices: string[] = [];
    try {
      mkdirSync(paths.versions, { recursive: true });
      mkdirSync(join(paths.prefix, "bin"), { recursive: true });
    } catch (error) {
      return { ok: false, message: `preparing ${paths.share} failed: ${(error as Error).message}` };
    }
    sweep(paths, notices);
    const dir = join(paths.versions, version);
    const reused = existsSync(dir);
    if (reused && !isOwnVersion(paths.versions, version))
      return { ok: false, message: `${dir} exists and is not a version scripts/install made; move it away` };
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
        writeFileSync(
          join(staging, "build.json"),
          `${JSON.stringify({ version, commit: build?.commit ?? null })}\n`,
        );
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
    // The install has succeeded; from here on a failure is a notice. What current and previous name is never pruned.
    const keep = new Set([version, previous, linkedVersion(paths.current), linkedVersion(paths.previous)]);
    const pruned = prune(paths, new Set([...keep].filter((v): v is string => v !== undefined)), notices);
    return { ok: true, version, previous, reused, pruned, notices };
  });
};

/** Makes previous current again, and records the version it replaces as the new previous. */
export const rollback = (prefix: string): Outcome<{ from: string; to: string }> => {
  const paths = layout(prefix);
  if (!existsSync(paths.share)) return { ok: false, message: `nothing is installed under ${paths.share}` };
  return withLock(paths, () => rollbackLocked(prefix));
};

const rollbackLocked = (prefix: string): Outcome<{ from: string; to: string }> => {
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

/**
 * Removes an install tree or staging folder, read-only folders included. Every entry is judged by lstat: a link is
 * unlinked, never followed, chmodded or read through, so nothing outside the tree changes.
 */
export const removeInstall = (path: string): void => {
  let top: ReturnType<typeof lstatSync>;
  try {
    top = lstatSync(path);
  } catch {
    return;
  }
  if (!top.isDirectory()) {
    unlinkSync(path);
    return;
  }
  const writable = (dir: string): void => {
    chmodSync(dir, 0o755);
    // Dirent types come from the folder itself: a link is never a directory here.
    for (const entry of readdirSync(dir, { withFileTypes: true }))
      if (entry.isDirectory()) writable(join(dir, entry.name));
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
  const full = git(root, "rev-parse", "HEAD");
  const commit = full === "" ? undefined : full.slice(0, 7);
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
    { commit: full || "unknown" },
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
  for (const notice of installed.notices) console.error(`scripts/install: notice: ${notice}`);
};

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    stop(`unexpected failure: ${(error as Error).message}`);
  }
}
