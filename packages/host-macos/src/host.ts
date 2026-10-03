// The macOS host port: core's HostPorts on this machine. The file system is node:fs (nodeLocalIo's, optionally
// behind the path guard), the one ProcessInfo of this process is shared by every host and by nodeLocalIo (lock state
// is per process), children run through core's runner on the POSIX process-group spawner, and faultAt is the crash
// seam from ADR-0017.

import {
  type FaultPlan,
  faultSeam,
  type HostPorts,
  nodeLocalIo,
  posixDeleteTrash,
  runProcess,
  type Spawner,
} from "@plainport/core";
import { type GuardPolicy, guardedFs, PathGuard } from "./guard.ts";
import { posixSpawner } from "./spawner.ts";

export interface MacosHost extends HostPorts {
  /**
   * Stops every child this host is running (TERM, then KILL after each run's grace period, whole groups) and
   * resolves once all of their runs have settled, each as process.cancelled. Every later run is cancelled before it
   * starts. The composition root calls it on SIGINT and SIGTERM: children run in their own session, so a terminal's
   * Ctrl-C never reaches them by itself.
   */
  stopAll(): Promise<void>;
  /** The process groups of the children running now. */
  liveGroups(): readonly number[];
}

export interface MacosHostOptions {
  /** Paths to refuse (tests); none by default. See guard.ts for who passes one. */
  guard?: GuardPolicy;
  /** A planned crash for the crash matrix; none by default. */
  faults?: FaultPlan;
  /** Tests wrap the real spawner to record the groups they start. */
  spawner?: Spawner;
}

export const createMacosHost = (options: MacosHostOptions = {}): MacosHost => {
  const guard = options.guard === undefined ? undefined : new PathGuard(options.guard);
  const spawner = options.spawner ?? posixSpawner;
  const { proc } = nodeLocalIo;
  const stopping = new AbortController();
  const runs = new Set<Promise<unknown>>();
  const groups = new Set<number>();
  return {
    fs: guard === undefined ? nodeLocalIo.fs : guardedFs(nodeLocalIo.fs, guard),
    proc,
    clock: { now: () => new Date(), monotonicMs: () => proc.monotonicMs(), sleep: (ms) => proc.sleep(ms) },
    run: async (spec) => {
      await guard?.checkRun(spec);
      let pgid: number | undefined;
      const tracked: Spawner = {
        spawn: (request) => {
          const child = spawner.spawn(request);
          pgid = child.pid;
          groups.add(pgid);
          return child;
        },
        signalGroup: (group, signal) => spawner.signalGroup(group, signal),
      };
      const signal =
        spec.signal === undefined ? stopping.signal : AbortSignal.any([spec.signal, stopping.signal]);
      const running = runProcess(tracked, { ...spec, signal });
      runs.add(running);
      try {
        return await running;
      } finally {
        runs.delete(running);
        if (pgid !== undefined) groups.delete(pgid);
      }
    },
    stopAll: async () => {
      stopping.abort();
      await Promise.allSettled([...runs]);
    },
    liveGroups: () => [...groups],
    faultAt: faultSeam(options.faults, () => process.kill(process.pid, "SIGKILL")),
    deleteTrashDetached: async (trash, journal, device) => {
      await guard?.checkRun({ command: "/bin/sh", args: [trash, journal], cwd: "/", env: {} });
      return posixDeleteTrash(
        { fs: guard === undefined ? nodeLocalIo.fs : guardedFs(nodeLocalIo.fs, guard), proc },
        trash,
        journal,
        device,
      );
    },
  };
};

/** The guard for the composition root: the real home a test run names, so a binary a test starts is guarded. */
export const guardFromEnv = (env: Readonly<Record<string, string | undefined>>): GuardPolicy | undefined => {
  const home = env.PLAINPORT_TRIPWIRE_REAL_HOME;
  return home ? { refuse: [home], readOnly: [] } : undefined;
};
