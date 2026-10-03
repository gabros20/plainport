// A real HostPorts for core's tests: node:fs behind the path guard, children through the runner on the POSIX
// spawner. It refuses the real home, taken from the account database (os.userInfo), which no HOME or tripwire
// changes, plus any real home the tripwire names, and makes this checkout read-only (run decision D7). Only tests
// import it; the composition root builds its host from @plainport/host-macos.

import { userInfo } from "node:os";
import { resolve } from "node:path";
import { type GuardPolicy, guardedFs, PathGuard } from "../guard.ts";
import { nodeLocalIo } from "../node-io.ts";
import { faultSeam, type HostPorts } from "../ports/host.ts";
import { runProcess } from "../runner/runner.ts";
import { posixSpawner } from "../spawner.ts";

const checkout = resolve(import.meta.dir, "../../../..");

export const testGuard = (): GuardPolicy => {
  const homes = new Set([resolve(userInfo().homedir)]);
  const named = process.env.PLAINPORT_TRIPWIRE_REAL_HOME;
  if (named) homes.add(resolve(named));
  return { refuse: [...homes], readOnly: [checkout] };
};

export const testHost = (): HostPorts => {
  const guard = new PathGuard(testGuard());
  const { proc } = nodeLocalIo;
  return {
    fs: guardedFs(nodeLocalIo.fs, guard),
    proc,
    clock: { now: () => new Date(), monotonicMs: () => proc.monotonicMs(), sleep: (ms) => proc.sleep(ms) },
    run: async (spec) => {
      await guard.checkRun(spec);
      return runProcess(posixSpawner, spec);
    },
    faultAt: faultSeam(undefined, () => process.kill(process.pid, "SIGKILL")),
  };
};
