// A test file's own temp folder, made the first time a test asks for it and removed after the file's tests. A folder
// made at module or describe scope leaks when a name filter (`bun test -t …`) skips every test of its file: the file's
// afterAll then never runs, and the home tripwire (test/home-tripwire.ts) fails the run. Made lazily, a file whose
// tests are all filtered out makes none.

import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Returns the folder's getter; `remove` (default: rm -rf) runs after the file's tests if the folder was made. */
export const lazyTempDir = (
  prefix: string,
  remove: (dir: string) => unknown = (dir) => rmSync(dir, { recursive: true, force: true }),
): (() => string) => {
  let dir: string | undefined;
  afterAll(async () => {
    if (dir !== undefined) await remove(dir);
  });
  return () => {
    dir ??= mkdtempSync(join(tmpdir(), prefix));
    return dir;
  };
};
