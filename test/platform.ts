// Tests that need the real macOS tools (lsof's macOS output, BSD find -flags, the docker CLI as installed on a Mac,
// APFS behaviour) run only on darwin; on Linux they are skipped. So that a skip can never pass for a run on a Mac,
// each file's macOS-only tests are counted: on darwin under CI, every one declared must have run, or the file fails.
// bun gives a test no way to see a -t filter, so a filtered run under CI must say so with PLAINPORT_TEST_FILTERED=1.

import { afterAll, expect, test } from "bun:test";

export const onMac = process.platform === "darwin";

type Body = () => unknown;

/**
 * A `test` for this file's macOS-only tests: skipped off darwin, counted on darwin. Call it once at the top of the
 * file; it registers the afterAll that checks the count.
 */
export const macOnlyTests = (env: Record<string, string | undefined> = process.env) => {
  let declared = 0;
  let ran = 0;
  afterAll(() => {
    if (onMac && env.CI && !env.PLAINPORT_TEST_FILTERED)
      expect({ ran, declared }).toEqual({ ran: declared, declared });
  });
  return (name: string, body: Body, timeout?: number): void => {
    declared++;
    test.skipIf(!onMac)(
      `[macOS] ${name}`,
      async () => {
        ran++;
        await body();
      },
      timeout,
    );
  };
};
