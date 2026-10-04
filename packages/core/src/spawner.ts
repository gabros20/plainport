// The process-group primitive under the runner (core's runProcess): each child starts as the leader of a new
// session and process group (setsid, Bun's `detached`), and signals go to the whole group, kill(-pgid). POSIX
// only, so it serves Linux as well until host-linux exists.

import { constants, uptime } from "node:os";
import { isAbsolute } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";
import { errorCode, type LocalIo, systemErrorCode } from "./io.ts";
import type { Spawner } from "./runner/types.ts";
import { trashClaimFile } from "./trash-claim.ts";

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
): Promise<"claimed" | "finished" | "failed" | "timeout"> => {
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
      if (code === 0) return "finished";
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
 * HostPorts.deleteTrashDetached on POSIX (D47): /bin/sh in a new session (setsid), every stream on /dev/null, never
 * waited for. It first claims the trash as its own (trash-claim.ts, D64: its pid, written by itself), makes the trash
 * writable (a read-only folder cannot be emptied), deletes it, then the claim, then the journal (D67: a crash between them leaves a journal whose trash is gone, which
 * housekeeping and gc close; never a claim no journal leads to), then the trash holder if that left it empty. This resolves ok only
 * once the claim is there (or the child already finished), polled through `io`, so a caller holding the project's
 * lock releases it only after any other deleter can see the claim. A child that exits without its claim is
 * fs.write-failed; one that has not claimed within CLAIM_WAIT_MS (a disk that hangs) is killed first, so no deleter
 * runs unclaimed, and is fs.write-failed too; gc and recover delete that trash later.
 */
export const posixDeleteTrash = async (
  io: LocalIo,
  trash: string,
  journal: string,
  device: string,
): Promise<Result<{ pid: number }>> => {
  const op = TRASH.exec(trash)?.[1];
  if (op === undefined || JOURNAL.exec(journal)?.[1] !== op || !isAbsolute(trash) || !isAbsolute(journal))
    throw new Error(`deleteTrashDetached: ${trash} and ${journal} are not an offload's trash and journal`);
  try {
    const child = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        [
          'c="$1.claim"',
          `printf '{"v":1,"device":"%s","pid":%s,"bootedAt":%s,"startedAt":"%s"}\\n' "$3" "$$" "$4" "$5" > "$c.tmp" && mv -f -- "$c.tmp" "$c" || exit 1`,
          'chmod -R u+w -- "$1" 2>/dev/null; rm -rf -- "$1" && rm -f -- "$c" && rm -f -- "$2" || exit 1',
          // The trash holder, only when that left it empty (removeEmptyTrashHolder).
          'rmdir -- "$(dirname -- "$1")" 2>/dev/null; exit 0',
        ].join("\n"),
        "plainport-trash",
        trash,
        journal,
        device,
        String(Date.now() - uptime() * 1000),
        new Date().toISOString(),
      ],
      {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      },
    );
    child.unref();
    // Until the claim is there, nothing tells another deleter that this one runs (D64).
    const claimed = await awaitClaim(io, trash, trashClaimFile(trash), () => child.exitCode);
    if (claimed === "claimed" || claimed === "finished") return ok({ pid: child.pid });
    if (claimed === "timeout") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        systemErrorCode(error);
      }
    }
    return fail(
      finding("fs.write-failed", {
        message: `the detached delete of ${trash} could not claim it (${claimed === "timeout" ? `no claim within ${CLAIM_WAIT_MS / 1000} s` : "its claim could not be written"}), so it was stopped before deleting anything`,
        fix: "check that the volume is writable, then run plainport gc",
        paths: [trashClaimFile(trash)],
      }),
    );
  } catch (error) {
    const code = systemErrorCode(error);
    return fail(
      finding("process.spawn-failed", {
        message: `the detached delete of ${trash} could not be started (${code})`,
        fix: "plainport recover deletes the trash",
        paths: ["/bin/sh", trash],
      }),
    );
  }
};
