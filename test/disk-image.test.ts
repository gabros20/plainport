// The hdiutil lock every disk-image suite shares (disk-image.ts): one holder at a time, and a lock left by a dead
// process is taken over rather than waited on.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withImageLock } from "./disk-image.ts";

let dir: string;
let lock: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainport-image-lock-"));
  lock = join(dir, "lock");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("two holders never overlap, and the lock is gone afterwards", async () => {
  let inside = 0;
  let most = 0;
  const hold = () =>
    withImageLock(async () => {
      most = Math.max(most, ++inside);
      await Bun.sleep(30);
      inside--;
    }, lock);
  await Promise.all([hold(), hold(), hold()]);
  expect(most).toBe(1);
  expect(existsSync(lock)).toBe(false);
});

test("a lock whose holder is dead is taken over", async () => {
  const dead = Bun.spawnSync(["/usr/bin/true"]).pid;
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(dead));
  expect(await withImageLock(() => "ran", lock)).toBe("ran");
});

test("the lock is released when the work throws", async () => {
  await expect(
    withImageLock(() => {
      throw new Error("boom");
    }, lock),
  ).rejects.toThrow("boom");
  expect(existsSync(lock)).toBe(false);
});
