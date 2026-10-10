// Run only by test/home-tripwire.test.ts in a child `bun test`: makes a plainport-* temp folder and removes it unless
// PLAINPORT_FIXTURE_LEAK asks to leave it, so the parent can check the run fails exactly when a folder is left.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("makes a temp folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "plainport-leak-"));
  if (process.env.PLAINPORT_FIXTURE_LEAK !== "1") rmSync(dir, { recursive: true, force: true });
  expect(true).toBe(true);
});
