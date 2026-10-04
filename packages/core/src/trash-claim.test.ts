// The trash claim (D64 revised): live only when it is this device's, from this boot, and its pid is alive; anything
// else is gone and taken over. The detached delete writes its own claim before it deletes, and fails, deleting
// nothing, when it cannot.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { posixDeleteTrash } from "./spawner.ts";
import { childGuardEnv, SELF, testHost } from "./testing/host.ts";
import { makeSandbox, type Sandbox } from "./testing/sandbox.ts";
import { trashClaim, trashClaimFile } from "./trash-claim.ts";
import { ulid } from "./ulid.ts";

let box: Sandbox;
let trash: string;
let journal: string;
const DEVICE = ulid();
/** The detached child: plainport from this checkout, told the sandbox's paths (D87). */
const launch = () => ({ self: SELF, paths: box.paths, env: { HOME: box.home }, passEnv: childGuardEnv() });

beforeEach(() => {
  box = makeSandbox("plainport-claim-");
  const op = ulid();
  trash = box.dir(`work/.plainport-trash/${op}`);
  box.file(`work/.plainport-trash/${op}/web/a.txt`, "a");
  journal = box.file(`state/journal/${op}.json`, "{}");
});
afterEach(() => {
  try {
    chmodSync(join(box.home, "work/.plainport-trash"), 0o755);
  } catch {}
  box.cleanup();
});

const claim = (over: Record<string, unknown> = {}) =>
  writeFileSync(
    trashClaimFile(trash),
    JSON.stringify({
      v: 1,
      device: DEVICE,
      pid: process.pid,
      bootedAt: testHost().proc.bootedAtMs(),
      startedAt: new Date().toISOString(),
      ...over,
    }),
  );

describe("which claims are live (D64 revised)", () => {
  test("this device, this boot, a live pid: live", async () => {
    claim();
    expect((await trashClaim(testHost(), trash, DEVICE)).state).toBe("live");
  });

  test("no claim: none", async () => {
    expect((await trashClaim(testHost(), trash, DEVICE)).state).toBe("none");
  });

  test("a dead pid, an earlier boot, another device id, or a claim that does not read: gone", async () => {
    for (const over of [
      { pid: 99_999_999 },
      { bootedAt: testHost().proc.bootedAtMs() - 86_400_000 },
      { device: ulid() },
      { host: "another-name" },
    ]) {
      claim(over);
      expect([over, (await trashClaim(testHost(), trash, DEVICE)).state]).toEqual([over, "gone"]);
    }
    writeFileSync(trashClaimFile(trash), "{ torn");
    expect((await trashClaim(testHost(), trash, DEVICE)).state).toBe("gone");
  });
});

describe("the detached delete claims before it deletes (D64 revised)", () => {
  test("it returns once its claim, naming this device and its own pid, is there; then trash, claim and journal go", async () => {
    const started = await posixDeleteTrash(testHost(), trash, journal, DEVICE, launch());
    if (!started.ok) throw new Error(started.finding.message);
    // Its claim is there, or it already finished (claim and journal gone with the trash).
    if (existsSync(trashClaimFile(trash))) {
      const written = JSON.parse(readFileSync(trashClaimFile(trash), "utf8"));
      expect([written.device, written.pid]).toEqual([DEVICE, started.value.pid]);
    } else expect(existsSync(trash)).toBe(false);
    for (let i = 0; i < 400 && existsSync(journal); i++) await Bun.sleep(10);
    expect([existsSync(trash), existsSync(trashClaimFile(trash)), existsSync(journal)]).toEqual([
      false,
      false,
      false,
    ]);
  });

  test("it removes the trash, then its claim, then the journal (D67): a journal it cannot remove is left alone, no claim", async () => {
    // A journal it cannot remove stops it after the claim: what is left is a released journal whose trash and claim
    // are gone, which housekeeping and gc settle; never a claim no journal leads to (invariant 3).
    const journalDir = join(box.home, "state/journal");
    chmodSync(journalDir, 0o555);
    try {
      const started = await posixDeleteTrash(testHost(), trash, journal, DEVICE, launch());
      if (!started.ok) throw new Error(started.finding.message);
      for (let i = 0; i < 500 && (await testHost().proc.isAlive(started.value.pid)); i++) await Bun.sleep(10);
      expect([existsSync(trash), existsSync(trashClaimFile(trash)), existsSync(journal)]).toEqual([
        false,
        false,
        true,
      ]);
    } finally {
      chmodSync(journalDir, 0o755);
    }
  });

  test("a delete that claimed, deleted and then failed on the journal before the first poll still started (Linux CI)", async () => {
    // The poller looks only once the child is done: its claim came and went with the trash, and it exited 1 on the
    // journal it could not remove. That delete ran; it is no failure to claim.
    const journalDir = join(box.home, "state/journal");
    chmodSync(journalDir, 0o555);
    const real = testHost();
    let first = true;
    const slow = {
      ...real,
      fs: {
        ...real.fs,
        lstat: async (path: string) => {
          if (first && path === trashClaimFile(trash)) {
            first = false;
            for (let i = 0; i < 500 && existsSync(trash); i++) await Bun.sleep(10);
            await Bun.sleep(200);
          }
          return real.fs.lstat(path);
        },
      },
    };
    try {
      const started = await posixDeleteTrash(slow, trash, journal, DEVICE, launch());
      expect(started.ok ? "ok" : started.finding.message).toBe("ok");
      expect([existsSync(trash), existsSync(trashClaimFile(trash)), existsSync(journal)]).toEqual([
        false,
        false,
        true,
      ]);
    } finally {
      chmodSync(journalDir, 0o755);
    }
  });

  test("a claim it cannot write fails the start, and nothing is deleted", async () => {
    mkdirSync(join(box.home, "work/.plainport-trash"), { recursive: true });
    chmodSync(join(box.home, "work/.plainport-trash"), 0o555);
    const started = await posixDeleteTrash(testHost(), trash, journal, DEVICE, launch());
    expect(started.ok ? "ok" : started.finding.code).toBe("fs.write-failed");
    expect([existsSync(join(trash, "web/a.txt")), existsSync(journal)]).toEqual([true, true]);
  });
});

describe("the detached delete when its claim cannot be looked at (N4)", () => {
  test("a claim lstat that fails with EIO is fs.write-failed, not process.spawn-failed, and the child is stopped", async () => {
    const real = testHost();
    let pid: number | undefined;
    const io = {
      ...real,
      fs: {
        ...real.fs,
        lstat: async (path: string) => {
          if (path === trashClaimFile(trash))
            throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
          return real.fs.lstat(path);
        },
      },
    };
    const started = await posixDeleteTrash(io, trash, journal, DEVICE, launch());
    expect(started.ok ? "started" : started.finding.code).toBe("fs.write-failed");
    if (!started.ok) {
      expect(started.finding.message).toContain("but its claim could not be checked (EIO)");
      pid = Number(/process (\d+)/.exec(started.finding.message)?.[1] ?? Number.NaN);
    }
    // Whatever the child got to, it is not left running: no unclaimed deleter outlives the call for long.
    await Bun.sleep(50);
    expect(Number.isInteger(pid)).toBe(true);
    expect(await real.proc.isAlive(pid as number)).toBe(false);
  });
});
