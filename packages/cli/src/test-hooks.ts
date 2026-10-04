// The crash matrix's hook in the binary (ADR-0017, D25, D67): a test hook, not configuration. The subprocess variant
// of the crash matrix runs the compiled binary and needs it to die by a real SIGKILL at one saga step, or to stop at
// one while the test changes the world (a file edited or made unreadable, another copy's event), as the in-process
// variant does through its fake engine's hooks.
//
// The one lock is the build (D67). The composition root calls testFaultPlan only behind
// `globalThis.PLAINPORT_TEST_HOOKS === true`, which `bun build --define globalThis.PLAINPORT_TEST_HOOKS=<bool>` folds to
// a constant. scripts/build.ts (`bun run build`, every release) defines it false, so the call and this whole module are
// dead code the bundler drops: a release binary holds none of it, which scripts/build.test.ts checks. Only the crash
// matrix's own build defines it true. A run from source, or a bare `bun build`, leaves the global undefined: off.
//
// In a matrix build two rails keep a hooked run inside a test sandbox. They are environment values, so they are rails,
// not proof of a test run: PLAINPORT_TRIPWIRE_REAL_HOME must name the real home, which the composition root then
// refuses (guardFromEnv), and HOME must lie outside it. The pause file must lie under HOME and pass that same guard.
//
// The variables:
//   PLAINPORT_TEST_FAULT_AT=<step>         SIGKILL this process at the step (a saga step or after-effect seam),
//   PLAINPORT_TEST_FAULT_OCCURRENCE=<n>    the nth time it is reached (default 1);
//   PLAINPORT_TEST_PAUSE_AT=<step>         the first time the step is reached, create PLAINPORT_TEST_PAUSE_FILE and
//   PLAINPORT_TEST_PAUSE_FILE=<path>       block until it is removed (two minutes at most), then go on.
// They are documented here and in CONTRIBUTING.md, never in DESIGN.md's configuration.

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FAULT_STEP, type FaultPlan, type GuardPolicy, PathGuard } from "@plainport/core";

declare global {
  /** Folded by `--define globalThis.PLAINPORT_TEST_HOOKS=…`: true only in the crash matrix's build. */
  var PLAINPORT_TEST_HOOKS: boolean | undefined;
}

const PAUSE_MS = 120_000;

const inside = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);

/**
 * The fault plan the environment asks for, when the rails allow it; otherwise none. `guard` is the composition root's
 * policy (guardFromEnv): the pause file, the one path the hook writes, is checked against it before anything runs.
 */
export const testFaultPlan = async (
  env: Readonly<Record<string, string | undefined>>,
  guard: GuardPolicy | undefined,
): Promise<FaultPlan | undefined> => {
  const real = env.PLAINPORT_TRIPWIRE_REAL_HOME;
  if (!real || guard === undefined || !env.HOME) return undefined;
  const home = resolve(env.HOME);
  if (inside(home, resolve(real))) return undefined;
  const at = env.PLAINPORT_TEST_FAULT_AT;
  const pauseAt = env.PLAINPORT_TEST_PAUSE_AT;
  const pauseFile = env.PLAINPORT_TEST_PAUSE_FILE;
  if (at === undefined && pauseAt === undefined) return undefined;
  if (at !== undefined && !FAULT_STEP.test(at)) return undefined;
  const occurrence = Number(env.PLAINPORT_TEST_FAULT_OCCURRENCE ?? "1");
  if (!Number.isInteger(occurrence) || occurrence < 1) return undefined;
  if (pauseAt !== undefined) {
    if (!FAULT_STEP.test(pauseAt) || !pauseFile || !inside(resolve(pauseFile), home)) return undefined;
    try {
      await new PathGuard(guard).check("write the pause file", pauseFile, true);
    } catch {
      return undefined;
    }
  }
  let paused = false;
  return {
    ...(at === undefined ? {} : { at, action: "kill" as const, occurrence }),
    onStep: (step) => {
      if (step !== pauseAt || paused || pauseFile === undefined) return;
      paused = true;
      // faultAt is synchronous, so the pause is too: the saga stands still at its step, children included.
      writeFileSync(pauseFile, `${process.pid} ${step}\n`);
      const deadline = Date.now() + PAUSE_MS;
      while (existsSync(pauseFile) && Date.now() < deadline) Bun.sleepSync(10);
    },
  };
};
