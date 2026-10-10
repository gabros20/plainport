// Run only by test/home-tripwire.test.ts in a child `bun test`: makes a plainport-* temp folder and removes it unless
// PLAINPORT_FIXTURE_LEAK asks to leave it, so the parent can check the run fails exactly when a folder is left.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// "shared": the parent made plainport-shared-owner and plainport-shared.lock in this TMPDIR before the run; this run
// only tries to make them again and works inside the first, so it made none of them and must not be blamed.
test("makes a temp folder", () => {
  if (process.env.PLAINPORT_FIXTURE_LEAK === "shared") {
    expect(() => mkdirSync(join(tmpdir(), "plainport-shared-owner"))).toThrow();
    expect(() => mkdirSync(join(tmpdir(), "plainport-shared.lock"))).toThrow();
    mkdirSync(join(tmpdir(), "plainport-shared-owner", "deep", "er"), { recursive: true });
    mkdirSync(join(tmpdir(), "plainport-shared-owner", "deep"), { recursive: true });
    return;
  }
  const mkdir = process.env.PLAINPORT_FIXTURE_LEAK === "mkdir";
  const dir = mkdir ? join(tmpdir(), "plainport-leak-plain") : mkdtempSync(join(tmpdir(), "plainport-leak-"));
  if (mkdir) mkdirSync(dir);
  if (process.env.PLAINPORT_FIXTURE_LEAK === "0") rmSync(dir, { recursive: true, force: true });
  expect(true).toBe(true);
});
