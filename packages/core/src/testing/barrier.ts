// A start barrier for tests that run several child processes and need them to really overlap. Each child marks
// itself ready and waits for a "go" file; the parent creates it once every child is ready. Both sides wait on a
// condition with a generous deadline, never on a fixed delay, so a slow CI runner only makes the test slower.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEADLINE_MS = 120_000;

const until = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = performance.now() + DEADLINE_MS;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`barrier: timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
};

/** In a child: say this child is ready, then wait until the parent says go. */
export const awaitGo = async (dir: string, name: string): Promise<void> => {
  writeFileSync(join(dir, `ready-${name}`), "");
  await until(() => existsSync(join(dir, "go")), "go");
};

/** In the parent: wait until every named child is ready, then let them all go at once. */
export const releaseWhenReady = async (dir: string, names: readonly string[]): Promise<void> => {
  await until(
    () => names.every((name) => existsSync(join(dir, `ready-${name}`))),
    `children ${names.join(", ")}`,
  );
  writeFileSync(join(dir, "go"), "");
};
