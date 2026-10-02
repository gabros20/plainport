// Run only by test/home-tripwire.test.ts in a child `bun test` whose "real home" is an unrelated temp directory.
// The write must still fail: writes into the checkout are violations wherever the checkout lives (D7).
import { test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

test("writes into the checkout", () => {
  // VERSION is a regular file, so nothing can be created under it even if the tripwire let this through.
  writeFileSync(join(import.meta.dir, "../../VERSION", `probe-${randomUUID()}`), "x");
});
