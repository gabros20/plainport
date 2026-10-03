// The process-group primitive under the runner (core's runProcess): each child starts as the leader of a new
// session and process group (setsid, Bun's `detached`), and signals go to the whole group, kill(-pgid). POSIX
// only, so it serves Linux as well until host-linux exists.

import { constants } from "node:os";
import { errorCode } from "./io.ts";
import type { Spawner } from "./runner/types.ts";

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
