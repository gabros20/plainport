// The trash claim (D64 revised): live only when it is this device's, from this boot, and its pid is alive; anything
// else is gone and taken over. The detached delete writes its own claim before it deletes, and fails, deleting
// nothing, when it cannot.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { posixDeleteTrash } from "./spawner.ts";
import { testHost } from "./testing/host.ts";
import { makeSandbox, type Sandbox } from "./testing/sandbox.ts";
import { trashClaim, trashClaimFile } from "./trash-claim.ts";
import { ulid } from "./ulid.ts";

let box: Sandbox;
let trash: string;
let journal: string;
const DEVICE = ulid();

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
    const started = await posixDeleteTrash(testHost(), trash, journal, DEVICE);
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
      const started = await posixDeleteTrash(testHost(), trash, journal, DEVICE);
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

  test("a claim it cannot write fails the start, and nothing is deleted", async () => {
    mkdirSync(join(box.home, "work/.plainport-trash"), { recursive: true });
    chmodSync(join(box.home, "work/.plainport-trash"), 0o555);
    const started = await posixDeleteTrash(testHost(), trash, journal, DEVICE);
    expect(started.ok ? "ok" : started.finding.code).toBe("fs.write-failed");
    expect([existsSync(join(trash, "web/a.txt")), existsSync(journal)]).toEqual([true, true]);
  });
});
