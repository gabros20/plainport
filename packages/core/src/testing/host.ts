// A real HostPorts for core's tests: node:fs behind the path guard, children through the runner on the POSIX
// spawner. It refuses the real home, taken from the account database (os.userInfo), which no HOME or tripwire
// changes, plus any real home the tripwire names, and makes this checkout read-only (run decision D7). Only tests
// import it; the composition root builds its host from @plainport/host-macos.

import { userInfo } from "node:os";
import { resolve } from "node:path";
import { type GuardPolicy, guardedFs, PathGuard } from "../guard.ts";
import { nodeLocalIo } from "../node-io.ts";
import { type FaultPlan, faultSeam, type HostPorts } from "../ports/host.ts";
import { runProcess } from "../runner/runner.ts";
import { posixDeleteTrash, posixSpawner } from "../spawner.ts";

const checkout = resolve(import.meta.dir, "../../../..");

export const testGuard = (): GuardPolicy => {
  const homes = new Set([resolve(userInfo().homedir)]);
  const named = process.env.PLAINPORT_TRIPWIRE_REAL_HOME;
  if (named) homes.add(resolve(named));
  return { refuse: [...homes], readOnly: [checkout] };
};

/** How tests run plainport itself, for the detached delete's guarded child (D87): bun and this checkout's CLI entry. */
export const SELF: readonly string[] = [process.execPath, resolve(checkout, "packages/cli/src/main.ts")];

/** The detached child refuses the real home too: the CLI's composition root guards what the tripwire names. */
export const childGuardEnv = (): Record<string, string> => ({
  PLAINPORT_TRIPWIRE_REAL_HOME: process.env.PLAINPORT_TRIPWIRE_REAL_HOME || resolve(userInfo().homedir),
});

/** `faults` plans a crash at one journal step (ADR-0017), as the crash matrix does. */
export const testHost = (options: { faults?: FaultPlan } = {}): HostPorts => {
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
    faultAt: faultSeam(options.faults, () => process.kill(process.pid, "SIGKILL")),
    deleteTrashDetached: async (trash, journal, device, context) => {
      await guard.checkRun({ command: SELF[0] as string, args: [trash, journal], cwd: "/", env: {} });
      return posixDeleteTrash({ fs: guardedFs(nodeLocalIo.fs, guard), proc }, trash, journal, device, {
        self: SELF,
        ...context,
        passEnv: childGuardEnv(),
      });
    },
  };
};
