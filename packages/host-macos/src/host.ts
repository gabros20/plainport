// The macOS host port: core's HostPorts on this machine. The file system is node:fs (nodeLocalIo's, optionally
// behind the path guard), the one ProcessInfo of this process is shared by every host and by nodeLocalIo (lock state
// is per process), children run through core's runner on the POSIX process-group spawner, and faultAt is the crash
// seam from ADR-0017.

import {
  type FaultPlan,
  faultSeam,
  type HostPorts,
  nodeLocalIo,
  runProcess,
  type Spawner,
} from "@plainport/core";
import { type GuardPolicy, guardedFs, PathGuard } from "./guard.ts";
import { posixSpawner } from "./spawner.ts";

export type MacosHost = HostPorts;

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
  return {
    fs: guard === undefined ? nodeLocalIo.fs : guardedFs(nodeLocalIo.fs, guard),
    proc,
    clock: { now: () => new Date(), monotonicMs: () => proc.monotonicMs(), sleep: (ms) => proc.sleep(ms) },
    run: async (spec) => {
      await guard?.checkRun(spec);
      return runProcess(spawner, spec);
    },
    faultAt: faultSeam(options.faults, () => process.kill(process.pid, "SIGKILL")),
  };
};

/** The guard for the composition root: the real home a test run names, so a binary a test starts is guarded. */
export const guardFromEnv = (env: Readonly<Record<string, string | undefined>>): GuardPolicy | undefined => {
  const home = env.PLAINPORT_TRIPWIRE_REAL_HOME;
  return home ? { refuse: [home], readOnly: [] } : undefined;
};
