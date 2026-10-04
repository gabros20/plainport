// The process-group primitive under the runner (core's runProcess): each child starts as the leader of a new
// session and process group (setsid, Bun's `detached`), and signals go to the whole group, kill(-pgid). POSIX
// only, so it serves Linux as well until host-linux exists.

import { constants } from "node:os";
import { isAbsolute } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";
import { errorCode, type LocalIo, systemErrorCode } from "./io.ts";
import type { Env, PlainportPaths } from "./paths.ts";
import type { Spawner } from "./runner/types.ts";
import { trashClaimFile } from "./trash-claim.ts";
import { TRASH_DELETE_EXIT, TRASH_DELETE_WORD, trashDeletePayload } from "./trash-delete.ts";

// Bun 1.3.14 names a child's terminating signal from the Linux signal table on every platform, so on macOS a
// SIGUSR1 (30) comes back as "SIGPWR" and a SIGBUS (10) as "SIGUSR1". Map the name back to its Linux number, then to
// this platform's name. The runner test pins this: when Bun fixes it, that test fails and this map goes.
const LINUX_SIGNALS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGSTKFLT: 16,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 29,
  SIGPWR: 30,
  SIGSYS: 31,
};
const localNames = new Map<number, string>();
for (const [name, number] of Object.entries(constants.signals)) {
  if (!localNames.has(number)) localNames.set(number, name);
}
const signalName = (reported: string | null): string | null => {
  if (reported === null || process.platform === "linux") return reported;
  const number = LINUX_SIGNALS[reported];
  return number === undefined ? reported : (localNames.get(number) ?? reported);
};

export const posixSpawner: Spawner = {
  spawn: (request) => {
    const child = Bun.spawn([request.command, ...request.args], {
      cwd: request.cwd,
      // Always explicit: the child never inherits this process's environment.
      env: { ...request.env },
      stdin: request.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    return {
      pid: child.pid,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: child.exited.then(() => ({ code: child.exitCode, signal: signalName(child.signalCode) })),
    };
  },
  signalGroup: (pgid, signal) => {
    // kill(-1) would signal every process this user owns, kill(0) this process's own group.
    if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`signalGroup: refusing process group ${pgid}`);
    try {
      process.kill(-pgid, signal);
      return true;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ESRCH") return false;
      // EPERM: a member exists but runs as someone else (a setuid program); it still counts.
      if (code === "EPERM") return true;
      throw error;
    }
  },
};

/** `<anything>/.plainport-trash/<op>` and `<anything>/journal/<op>.json` for the same ULID op. */
const TRASH = /\/\.plainport-trash\/([0-9A-HJKMNP-TV-Z]{26})$/;
const JOURNAL = /\/journal\/([0-9A-HJKMNP-TV-Z]{26})\.json$/;

/** How long the detached delete has to write its claim before it is stopped. */
const CLAIM_WAIT_MS = 10_000;

/**
 * Waits for the child's claim: written; the child already done (exit 0, or a later step failed once the trash was
 * gone, which it deletes only under its claim); failed (exited without having claimed); or timeout.
 */
const awaitClaim = async (
  io: LocalIo,
  trash: string,
  claim: string,
  exitCode: () => number | null,
): Promise<"claimed" | "finished" | "refused" | "failed" | "timeout"> => {
  const deadline = io.proc.monotonicMs() + CLAIM_WAIT_MS;
  for (;;) {
    try {
      await io.fs.lstat(claim);
      return "claimed";
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const code = exitCode();
    if (code !== null) {
      if (code === TRASH_DELETE_EXIT.done) return "finished";
      // The guard refused before it deleted anything; it removed its claim (D87).
      if (code === TRASH_DELETE_EXIT.refused) return "refused";
      // Done before this poll looked: the trash is removed only after the claim was written (and the claim only after
      // the trash), so a trash that is gone means it claimed and deleted, and failed later (on the journal, D67).
      try {
        await io.fs.lstat(trash);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return "finished";
        throw error;
      }
      return "failed";
    }
    if (io.proc.monotonicMs() > deadline) return "timeout";
    await io.proc.sleep(5);
  }
};

/**
 * HostPorts.deleteTrashDetached on POSIX (D47, D87): plainport itself (`launch.self`) in a new session (setsid), every
 * stream on /dev/null, never waited for, running the internal word `__delete-trash` (trash-delete.ts). It first claims
 * the trash as its own (trash-claim.ts, D64: its pid, written by itself), runs the delete guard right before it deletes,
 * then deletes the trash, the claim and the journal (D67: a crash between them leaves a journal whose trash is gone,
 * which housekeeping and gc close; never a claim no journal leads to), then the trash holder if that left it empty. This
 * resolves ok only once the claim is there (or the child already finished), polled through `io`, so a caller holding
 * the project's lock releases it only after any other deleter can see the claim. A child that exits without its claim
 * is fs.write-failed; one whose guard refused before the first poll is delete.guard-refused; one that has not claimed
 * within CLAIM_WAIT_MS (a disk that hangs) is killed first, so no deleter runs unclaimed, and is fs.write-failed too; gc
 * and recover delete that trash later.
 */
export const posixDeleteTrash = async (
  io: LocalIo,
  trash: string,
  journal: string,
  device: string,
  /** How to run plainport itself (its binary, or bun and the CLI's entry), and what the child is told (D87). */
  launch: {
    self: readonly string[];
    paths: PlainportPaths;
    env: Env;
    keepUntil?: string;
    passEnv?: Readonly<Record<string, string>>;
  },
): Promise<Result<{ pid: number }>> => {
  const op = TRASH.exec(trash)?.[1];
  if (op === undefined || JOURNAL.exec(journal)?.[1] !== op || !isAbsolute(trash) || !isAbsolute(journal))
    throw new Error(`deleteTrashDetached: ${trash} and ${journal} are not an offload's trash and journal`);
  if (launch.self.length === 0) throw new Error("deleteTrashDetached: no command runs plainport itself");
  let child: ReturnType<typeof Bun.spawn>;
  try {
    // plainport itself, in its own process: it claims the trash, runs the delete guard right before it deletes, and
    // deletes only what the guard lets go (trash-delete.ts, D87). Never a plain rm -rf on a tree nobody checked.
    child = Bun.spawn(
      [
        ...launch.self,
        TRASH_DELETE_WORD,
        trashDeletePayload(trash, journal, device, launch.paths, launch.env, launch.keepUntil),
      ],
      {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", HOME: launch.paths.home, ...launch.passEnv },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      },
    );
  } catch (error) {
    const code = systemErrorCode(error);
    return fail(
      finding("process.spawn-failed", {
        message: `the detached delete of ${trash} could not be started (${code})`,
        fix: "plainport recover deletes the trash",
        paths: [launch.self[0] as string, trash],
      }),
    );
  }
  child.unref();
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      systemErrorCode(error);
    }
  };
  // Until the claim is there, nothing tells another deleter that this one runs (D64).
  let claimed: Awaited<ReturnType<typeof awaitClaim>>;
  try {
    claimed = await awaitClaim(io, trash, trashClaimFile(trash), () => child.exitCode);
  } catch (error) {
    // The claim cannot be looked at (a failing disk): the child is running and may be unclaimed, so it is stopped (N4).
    const code = systemErrorCode(error);
    stop();
    return fail(
      finding("fs.write-failed", {
        message: `the detached delete of ${trash} was started (process ${child.pid}), but its claim could not be checked (${code}), so it was stopped`,
        fix: "check the volume, then run plainport gc",
        paths: [trashClaimFile(trash)],
      }),
    );
  }
  if (claimed === "claimed" || claimed === "finished") return ok({ pid: child.pid });
  if (claimed === "refused")
    return fail(
      finding("delete.guard-refused", {
        message: `the detached delete of ${trash} checked it and refused to delete it (a mount point, a store, a registered project's folder, or a configuration that does not read cleanly); the trash and its journal stay`,
        fix: "plainport gc names the reason; fix it, then run plainport gc",
        paths: [trash],
      }),
    );
  if (claimed === "timeout") stop();
  return fail(
    finding("fs.write-failed", {
      message: `the detached delete of ${trash} could not claim it (${claimed === "timeout" ? `no claim within ${CLAIM_WAIT_MS / 1000} s` : "its claim could not be written"}), so it was stopped before deleting anything`,
      fix: "check that the volume is writable, then run plainport gc",
      paths: [trashClaimFile(trash)],
    }),
  );
};
