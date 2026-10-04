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
// they did not make is left alone with a notice; prune removes build.json last, so a failed prune is retried. An
// mkdir lock holding its pid keeps installs and rollbacks one at a time, and a stale one is taken over. The
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
  rmdirSync,
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
  if (!SEMVER.test(version))
    return {
      ok: false,
      message: `VERSION holds ${JSON.stringify(version)}, which is not SemVer; write X.Y.Z or X.Y.Z-<pre-release> (such as 0.2.0-rc.1) into VERSION`,
    };
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

/** A SemVer version as VERSION holds it: `X.Y.Z`, or `X.Y.Z-<pre-release>` such as `0.2.0-rc.1` or `0.1.0-dev`. */
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
/** What versionName appends to a -dev version: `+<UTC build time>.<commit>[.dirty]`. */
const DEV_BUILD = /^\d{14}\.[0-9a-z]+(\.dirty)?$/;

/** Whether a folder name is one versionName gives: any SemVer version, or a -dev one with its build suffix. */
export const isVersionName = (name: string): boolean => {
  const plus = name.indexOf("+");
  if (plus === -1) return SEMVER.test(name);
  const version = name.slice(0, plus);
  return SEMVER.test(version) && version.endsWith("-dev") && DEV_BUILD.test(name.slice(plus + 1));
};

/** Whether versions/<name> is a version this installer made: a real folder (never a link), named as it names them,
 * holding the build.json it writes. Nothing else under versions/ is ever pruned or listed as installed. */
const isOwnVersion = (versions: string, name: string): boolean => {
  if (!isVersionName(name)) return false;
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
  // An entry may vanish between readdir and lstat; it is then nothing to sweep.
  const stat = (path: string) => {
    try {
      return lstatSync(path);
    } catch {
      return undefined;
    }
  };
  const names = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  for (const name of names(paths.versions).filter((n) => STAGING.test(n))) {
    const path = join(paths.versions, name);
    const entry = stat(path);
    if (entry === undefined) continue;
    if (!entry.isDirectory()) {
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
      const entry = stat(path);
      if (entry === undefined) continue;
      if (!entry.isSymbolicLink()) {
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
const prune = (
  paths: Layout,
  keep: ReadonlySet<string>,
  notices: string[],
  remove: (path: string) => void,
): string[] => {
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
      remove(path);
      pruned.push(name);
    } catch (error) {
      notices.push(`prune of ${name} failed: ${(error as Error).message}`);
    }
  }
  return pruned;
};

/** What a Ctrl-C must clean up: the lock this process holds and the staging folder it fills (main's handlers). */
export const active: { lock?: string; staging?: string } = {};

/** Whether the process a lock names is gone (ESRCH); a pid we may not signal (EPERM) is alive. */
const pidGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
};

/** A lock with no pid file is stale once it is this old: mkdir and the pid write are microseconds apart. */
const NO_PID_STALE_MS = 60_000;

/**
 * One install or rollback at a time: an mkdir lock in share/plainport holding the owner's pid, released when the call
 * ends. A lock whose pid is gone, or that has no pid file and is a minute old, is taken over with a notice; a live
 * one is refused with the exact command that removes it.
 */
const withLock = <T>(paths: Layout, notices: string[], run: () => Outcome<T>): Outcome<T> => {
  const lock = join(paths.share, ".install.lock");
  const take = (): "taken" | "held" => {
    try {
      mkdirSync(lock);
      return "taken";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "held";
      throw error;
    }
  };
  try {
    mkdirSync(paths.share, { recursive: true });
    if (take() === "held") {
      let pid: number | undefined;
      try {
        pid = Number.parseInt(readFileSync(join(lock, "pid"), "utf8").trim(), 10);
      } catch {}
      let age = 0;
      try {
        age = Date.now() - lstatSync(lock).mtimeMs;
      } catch {}
      const stale =
        pid !== undefined && Number.isInteger(pid) && pid > 0
          ? pidGone(pid) && `pid ${pid} is gone`
          : age >= NO_PID_STALE_MS && "it names no pid and is over a minute old";
      if (!stale)
        return {
          ok: false,
          message: `another scripts/install is running${pid === undefined ? "" : ` (pid ${pid})`}; if none is, run: rm -r '${lock}'`,
        };
      rmSync(lock, { recursive: true, force: true });
      if (take() === "held")
        return { ok: false, message: `another scripts/install took ${lock} just now; run again` };
      notices.push(`took over a stale lock: ${stale} (${lock})`);
    }
  } catch (error) {
    return { ok: false, message: `taking ${lock} failed: ${(error as Error).message}` };
  }
  active.lock = lock;
  try {
    writeFileSync(join(lock, "pid"), `${process.pid}\n`);
    return run();
  } finally {
    rmSync(lock, { recursive: true, force: true });
    active.lock = undefined;
  }
};

/**
 * Removes one installed version so that a failure partway leaves it recognisably the installer's: everything else
 * first, build.json last, then the folder. A retry (the next install's prune) finishes it. `rm` is a test seam.
 */
export const removeVersion = (
  path: string,
  rm: (path: string) => void = (p) => rmSync(p, { recursive: true, force: true }),
): void => {
  if (!lstatSync(path).isDirectory()) throw new Error(`${path} is not a folder`);
  makeWritable(path);
  for (const name of readdirSync(path)) if (name !== "build.json") rm(join(path, name));
  rm(join(path, "build.json"));
  rmdirSync(path);
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
  /** Test seam: how a pruned version or a failed staging folder is removed, so a failed removal can be injected. */
  seams: { remove?: (path: string) => void } = {},
): Outcome<Installed> => {
  const paths = layout(prefix);
  const problem = linkProblem(paths);
  if (problem !== undefined) return { ok: false, message: problem };
  const notices: string[] = [];
  return withLock(paths, notices, (): Outcome<Installed> => {
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
        active.staging = staging;
        stage(staging);
        writeFileSync(
          join(staging, "build.json"),
          `${JSON.stringify({ version, commit: build?.commit ?? null })}\n`,
        );
        for (const name of readdirSync(staging)) chmodSync(join(staging, name), 0o555);
        // A folder moves only while writable (its .. changes), so it turns read-only once in place.
        renameSync(staging, dir);
        active.staging = undefined;
        chmodSync(dir, 0o555);
      } catch (error) {
        let cleanup = "";
        try {
          if (staging !== undefined) (seams.remove ?? removeInstall)(staging);
        } catch (removal) {
          cleanup = `; removing its staging folder failed: ${(removal as Error).message} (the next install sweeps it)`;
        }
        active.staging = undefined;
        return { ok: false, message: `staging ${version} failed: ${(error as Error).message}${cleanup}` };
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
    const pruned = prune(
      paths,
      new Set([...keep].filter((v): v is string => v !== undefined)),
      notices,
      seams.remove ?? ((path) => removeVersion(path)),
    );
    return { ok: true, version, previous, reused, pruned, notices };
  });
};

/** Makes previous current again, and records the version it replaces as the new previous. */
export const rollback = (prefix: string): Outcome<{ from: string; to: string }> => {
  const paths = layout(prefix);
  if (!existsSync(paths.share)) return { ok: false, message: `nothing is installed under ${paths.share}` };
  return withLock(paths, [], () => rollbackLocked(prefix));
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

/** Makes a real folder and every real folder under it writable. Dirent types come from the folder itself, so a link
 * is never a directory here and is never followed. */
const makeWritable = (dir: string): void => {
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true }))
    if (entry.isDirectory()) makeWritable(join(dir, entry.name));
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
  makeWritable(path);
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

/** Set when the build was stopped by Ctrl-C or SIGTERM: the install then exits 130. */
let interrupted = false;

const main = (): void => {
  // Ctrl-C reaches the whole foreground group: the build dies, the staging failure path cleans up and main exits
  // 130. A signal that lands while no child runs removes the lock and the staging folder here.
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      if (active.staging !== undefined) removeInstall(active.staging);
      if (active.lock !== undefined) rmSync(active.lock, { recursive: true, force: true });
      console.error(`scripts/install: interrupted by ${signal}; nothing was installed`);
      process.exit(130);
    });
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
      if (built.signalCode === "SIGINT" || built.signalCode === "SIGTERM") {
        interrupted = true;
        throw new Error(`interrupted by ${built.signalCode} during the build`);
      }
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
  if (!installed.ok) stop(installed.message, interrupted ? 130 : 1);
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
