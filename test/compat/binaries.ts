// The compatibility suite's two binaries (Task 7): the released v0.1.1, compiled from its tag, and the checkout.
//
// v0.1.1 is built once from its tag in a temporary `git worktree` (detached, removed in a finally block, then pruned)
// and cached under `.tools/compat/`, keyed by the tag's commit id and this platform, so a re-run costs nothing and a
// moved tag can never be served from an old build. Both binaries are compiled with the crash matrix's test hook on
// (`--define globalThis.PLAINPORT_TEST_HOOKS=true`, packages/cli/src/test-hooks.ts), which is how a test pauses a
// real v0.1.1 at one of its saga steps (PLAINPORT_TEST_PAUSE_AT) or kills it there (PLAINPORT_TEST_FAULT_AT). The
// released v0.1.1 carries no hook (D67): this build is the test double of the release, from the same source.
//
// Two test processes may ask at once (two runs of `PLAINPORT_TEST_TIER=1 bun test test/compat` at once): a lock folder next to
// the cache serialises the build, and the binary is moved into place only when complete.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildHookedBinary, toolsCopy as sharedToolsCopy } from "../binary-env.ts";

export const checkout = resolve(import.meta.dir, "../..");
/** The tag the matrix's "released reader" is. */
export const RELEASED_TAG = "v0.1.1";

const HOOKS_ON = ["--define", "globalThis.PLAINPORT_TEST_HOOKS=true"];
const LOCK_MS = 300_000;

const run = (command: string[], cwd: string): string => {
  const ran = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0)
    throw new Error(`${command.join(" ")} (in ${cwd}) exited ${ran.exitCode}: ${ran.stderr.toString()}`);
  return ran.stdout.toString().trim();
};

const NO_TAG = "(are tags fetched? CI's checkout needs fetch-depth: 0)";

/** A file as the tag has it; throws, naming the missing tag, when git cannot show it. */
export const released = (path: string): string => {
  const ran = Bun.spawnSync(["git", "show", `${RELEASED_TAG}:${path}`], {
    cwd: checkout,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (ran.exitCode !== 0)
    throw new Error(`git show ${RELEASED_TAG}:${path}: ${ran.stderr.toString().trim()} ${NO_TAG}`);
  return ran.stdout.toString();
};

/** The file names under a folder at the tag. */
export const releasedNames = (dir: string): string[] =>
  run(["git", "ls-tree", "--name-only", RELEASED_TAG, `${dir}/`], checkout)
    .split("\n")
    .filter(Boolean)
    .map((p) => p.slice(dir.length + 1));

/** Whether the tag and its objects are here (a shallow, tagless checkout has neither). */
export const tagAvailable = (): boolean =>
  Bun.spawnSync(["git", "cat-file", "-e", `${RELEASED_TAG}^{commit}`], {
    cwd: checkout,
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;

/** The commit the tag names, so the cache key follows the tag and not its name. */
export const releasedCommit = (): string => {
  if (!tagAvailable()) throw new Error(`${RELEASED_TAG} is not in this checkout ${NO_TAG}`);
  return run(["git", "rev-parse", `${RELEASED_TAG}^{commit}`], checkout);
};

/** `.tools/compat/plainport-<tag>-<commit>-<os>-<arch>-hooks`: where the cached v0.1.1 build lives. */
export const releasedBinaryPath = (commit = releasedCommit()): string =>
  join(
    checkout,
    ".tools/compat",
    `plainport-${RELEASED_TAG}-${commit.slice(0, 12)}-${process.platform}-${process.arch}-hooks`,
  );

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Serialises builds with a lock folder holding its owner's pid. A lock whose owner is gone (a killed build) is taken
 * over; one held by a live process is waited for, and the error names the folder to remove.
 */
const withLock = async <T>(lock: string, work: () => T | Promise<T>): Promise<T> => {
  mkdirSync(resolve(lock, ".."), { recursive: true });
  const deadline = Date.now() + LOCK_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = Number.NaN;
      try {
        owner = Number(readFileSync(join(lock, "pid"), "utf8"));
      } catch {}
      // No pid yet means its owner is between mkdir and write: not stale. Two waiters may both find one stale and the
      // second remove the first's new lock; both then build, and the atomic rename of distinct partial files keeps the
      // result right at the cost of a second build.
      if (Number.isInteger(owner) && owner > 0 && !alive(owner))
        rmSync(lock, { recursive: true, force: true });
      else if (Date.now() > deadline)
        throw new Error(
          `${lock} is held by process ${String(owner)} after ${LOCK_MS / 1000} s; remove that folder if no build is running`,
        );
      else await Bun.sleep(250);
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
};

/** Compiles the tag in a throwaway worktree. The worktree is gone, and pruned, whatever happens. */
const buildReleased = (commit: string, out: string): void => {
  const parent = mkdtempSync(join(tmpdir(), "plainport-compat-build-"));
  const tree = join(parent, "v0.1.1");
  try {
    run(["git", "worktree", "add", "--detach", tree, commit], checkout);
    const partial = `${out}.partial-${process.pid}`;
    try {
      run([process.execPath, "install", "--frozen-lockfile"], tree);
      run(
        [
          process.execPath,
          "build",
          "--compile",
          join(tree, "packages/cli/src/main.ts"),
          "--outfile",
          partial,
          ...HOOKS_ON,
        ],
        tree,
      );
      chmodSync(partial, 0o755);
      renameSync(partial, out);
    } finally {
      rmSync(partial, { force: true });
      // Not run(): a failing removal must not hide the build's own error; the outer finally prunes what is left.
      Bun.spawnSync(["git", "worktree", "remove", "--force", tree], {
        cwd: checkout,
        stdout: "ignore",
        stderr: "ignore",
      });
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
    // A failed `worktree add` or an interrupted build leaves an administrative entry behind.
    Bun.spawnSync(["git", "worktree", "prune"], { cwd: checkout });
  }
};

/** Builds v0.1.1 into the cache when it is not there; returns the binary. Runs in a script of its own (see below). */
const ensureReleased = async (): Promise<string> => {
  const commit = releasedCommit();
  const out = releasedBinaryPath(commit);
  if (existsSync(out)) return out;
  return withLock(`${out}.lock`, () => {
    if (!existsSync(out)) buildReleased(commit, out);
    return out;
  });
};

/**
 * The cached v0.1.1 binary, built first if it is not there. Hooks on.
 *
 * The cache and the worktree live in the checkout, which the home tripwire forbids a test process to write (D7), so the
 * build runs as this file's own script, `bun test/compat/binaries.ts`, in a process the tripwire does not patch.
 */
export const releasedBinary = (): string => {
  const out = releasedBinaryPath();
  if (existsSync(out)) return out;
  const ran = Bun.spawnSync([process.execPath, join(import.meta.dir, "binaries.ts")], {
    cwd: checkout,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (ran.exitCode !== 0) throw new Error(`building ${RELEASED_TAG}: ${ran.stderr.toString()}`);
  return out;
};

/** The checkout's own binary (what v0.2 will ship, plus the hook), into `dir`. Hooks on. */
export const currentBinary = (dir: string): string => buildHookedBinary(join(dir, "plainport-current"));

/** A copy of the pinned restic that both binaries can read (they refuse paths under the real home). */
export const toolsCopy = (dir: string): string => sharedToolsCopy(dir);

if (import.meta.main) {
  console.log(await ensureReleased());
}
