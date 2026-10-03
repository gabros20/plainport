// The crash matrix's hook in the binary (ADR-0017, D25): a test hook, not configuration. The subprocess variant of
// the crash matrix runs the compiled binary and needs it to die by a real SIGKILL at one saga step, or to stop at one
// while the test changes the world (a file edited or made unreadable, another copy's event), as the in-process
// variant does through its fake engine's hooks. Crashing on demand is dangerous, so three locks must all be open:
//
// 1. The build. Only a binary compiled with `--define PLAINPORT_TEST_HOOKS=true` reads these variables; the crash
//    matrix builds its own that way. `bun run build`, every release and every run from source leave it undefined, so
//    the hook is dead code there and no environment can wake it.
// 2. A test run. PLAINPORT_TRIPWIRE_REAL_HOME must name the real home (the test preload sets it); the composition
//    root then also refuses every path under it (guardFromEnv), so a hooked run can never touch the real home.
// 3. A sandboxed home. HOME must lie outside that real home.
//
// The variables:
//   PLAINPORT_TEST_FAULT_AT=<step>         SIGKILL this process at the step (a saga step or after-effect seam),
//   PLAINPORT_TEST_FAULT_OCCURRENCE=<n>    the nth time it is reached (default 1);
//   PLAINPORT_TEST_PAUSE_AT=<step>         the first time the step is reached, create PLAINPORT_TEST_PAUSE_FILE and
//   PLAINPORT_TEST_PAUSE_FILE=<path>       block until it is removed (two minutes at most), then go on.
// They are documented here and in CONTRIBUTING.md, never in DESIGN.md's configuration.

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FaultPlan } from "@plainport/core";

/** Set to true by `bun build --define PLAINPORT_TEST_HOOKS=true`; undeclared otherwise. */
declare const PLAINPORT_TEST_HOOKS: boolean | undefined;

/** Whether this binary was built for the crash matrix. */
export const BUILT_FOR_CRASH_MATRIX =
  typeof PLAINPORT_TEST_HOOKS !== "undefined" && PLAINPORT_TEST_HOOKS === true;

const STEP = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/;
const PAUSE_MS = 120_000;

const inside = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);

/** The fault plan the environment asks for, when all three locks are open; otherwise none. */
export const testFaultPlan = (
  env: Readonly<Record<string, string | undefined>>,
  built: boolean = BUILT_FOR_CRASH_MATRIX,
): FaultPlan | undefined => {
  if (!built) return undefined;
  const real = env.PLAINPORT_TRIPWIRE_REAL_HOME;
  if (!real || !env.HOME || inside(resolve(env.HOME), resolve(real))) return undefined;
  const at = env.PLAINPORT_TEST_FAULT_AT;
  const pauseAt = env.PLAINPORT_TEST_PAUSE_AT;
  const pauseFile = env.PLAINPORT_TEST_PAUSE_FILE;
  if (at === undefined && pauseAt === undefined) return undefined;
  if (at !== undefined && !STEP.test(at)) return undefined;
  const occurrence = Number(env.PLAINPORT_TEST_FAULT_OCCURRENCE ?? "1");
  if (!Number.isInteger(occurrence) || occurrence < 1) return undefined;
  if (pauseAt !== undefined && (!STEP.test(pauseAt) || !pauseFile)) return undefined;
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
