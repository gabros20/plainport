// The trash claim (D64 revised): live only when it is this device's, from this boot, and its pid is alive; anything
// else is gone and taken over. The detached delete writes its own claim before it deletes, and fails, deleting
// nothing, when it cannot.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import V011_TRASH_CLAIM from "../../../test/fixtures/v0.1.1/trash-claim.json";
import type { HostPorts } from "./ports/host.ts";
import { posixDeleteTrash } from "./spawner.ts";
import { childGuardEnv, SELF, testHost } from "./testing/host.ts";
import { makeSandbox, type Sandbox } from "./testing/sandbox.ts";
import { TrashClaimSchema, trashClaim, trashClaimBootFile, trashClaimFile } from "./trash-claim.ts";
import { runTrashDelete, trashDeletePayload } from "./trash-delete.ts";
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

describe("a claim read that fails with a bug (AGENTS.md rule 7)", () => {
  test("is thrown, never read as a claim that is gone (which another deleter would take over)", async () => {
    claim();
    const real = testHost();
    const buggy: HostPorts = {
      ...real,
      fs: {
        ...real.fs,
        readText: async () => {
          throw new TypeError("a bug");
        },
      },
    };
    await expect(trashClaim(buggy, trash, DEVICE)).rejects.toThrow("a bug");
  });
});

describe("the boot session beside the claim (Q5 i)", () => {
  /** `<op>.claim.boot` for the claim on disk: its pid and startedAt, and the boot session it was written in. */
  const bootMark = (session: string, over: Record<string, unknown> = {}) => {
    const written = JSON.parse(readFileSync(trashClaimFile(trash), "utf8"));
    writeFileSync(
      trashClaimBootFile(trash),
      JSON.stringify({ v: 1, pid: written.pid, startedAt: written.startedAt, session, ...over }),
    );
  };
  const inSession = (session: string | undefined): HostPorts => ({
    ...testHost(),
    bootSession: async () => session,
  });
  const dayAway = () => testHost().proc.bootedAtMs() - 86_400_000;

  test("a stepped clock with the same boot session reads as live", async () => {
    // The clock stepped a day after the claim was written: M1's boot-time rule alone would read an earlier boot.
    claim({ bootedAt: dayAway() });
    bootMark("S");
    expect((await trashClaim(inSession("S"), trash, DEVICE)).state).toBe("live");
  });

  test("another boot session reads as gone, even when the boot times agree", async () => {
    claim();
    bootMark("S");
    expect((await trashClaim(inSession("T"), trash, DEVICE)).state).toBe("gone");
  });

  test("without both sessions, M1's rule decides: no .claim.boot, one that does not read, one for another claim, none now", async () => {
    claim({ bootedAt: dayAway() });
    expect((await trashClaim(inSession("S"), trash, DEVICE)).state).toBe("gone");
    writeFileSync(trashClaimBootFile(trash), "{ torn");
    expect((await trashClaim(inSession("S"), trash, DEVICE)).state).toBe("gone");
    bootMark("S", { startedAt: "2001-01-01T00:00:00.000Z" });
    expect((await trashClaim(inSession("S"), trash, DEVICE)).state).toBe("gone");
    bootMark("S", { pid: 99_999_999 });
    expect((await trashClaim(inSession("S"), trash, DEVICE)).state).toBe("gone");
    bootMark("S");
    expect((await trashClaim(inSession(undefined), trash, DEVICE)).state).toBe("gone");
    claim();
    bootMark("S");
    expect((await trashClaim(inSession(undefined), trash, DEVICE)).state).toBe("live");
  });

  test("the detached delete writes .claim.boot before its claim, keeps the claim in M1's shape, and removes both", async () => {
    const real = testHost();
    const order: string[] = [];
    const texts = new Map<string, string>();
    const host: HostPorts = {
      ...real,
      bootSession: async () => "S",
      fs: {
        ...real.fs,
        writeTextDurable: async (path, text) => {
          order.push(`write ${path}`);
          texts.set(path, text);
          return real.fs.writeTextDurable(path, text);
        },
        rename: async (from, to) => {
          order.push(`rename ${from} ${to}`);
          return real.fs.rename(from, to);
        },
      },
    };
    const payload = trashDeletePayload(trash, journal, DEVICE, box.paths, { HOME: box.home });
    expect(await runTrashDelete(host, payload)).toBe(0);
    const claimFile = trashClaimFile(trash);
    expect(order.slice(0, 3)).toEqual([
      `write ${trashClaimBootFile(trash)}`,
      `write ${claimFile}.tmp`,
      `rename ${claimFile}.tmp ${claimFile}`,
    ]);
    const written = JSON.parse(texts.get(`${claimFile}.tmp`) as string);
    expect(Object.keys(written).sort()).toEqual(["bootedAt", "device", "pid", "startedAt", "v"]);
    expect(JSON.parse(texts.get(trashClaimBootFile(trash)) as string)).toEqual({
      v: 1,
      pid: written.pid,
      startedAt: written.startedAt,
      session: "S",
    });
    expect([existsSync(trash), existsSync(claimFile), existsSync(trashClaimBootFile(trash))]).toEqual([
      false,
      false,
      false,
    ]);
  });

  test("the compatibility row: v0.1.1's claim reader parses a claim this version writes", async () => {
    const real = testHost();
    let text: string | undefined;
    const host: HostPorts = {
      ...real,
      bootSession: async () => "S",
      fs: {
        ...real.fs,
        writeTextDurable: async (path, written) => {
          if (path === `${trashClaimFile(trash)}.tmp`) text = written;
          return real.fs.writeTextDurable(path, written);
        },
      },
    };
    const payload = trashDeletePayload(trash, journal, DEVICE, box.paths, { HOME: box.home });
    expect(await runTrashDelete(host, payload)).toBe(0);
    const claimed = JSON.parse(text as string);
    // v0.1.1's published schema (schemas/trash-claim.json at the tag) and its strict parser, which this one still is.
    const v011 = new Ajv2020({ strict: false, allErrors: true, formats: { "date-time": true } }).compile(
      V011_TRASH_CLAIM,
    );
    expect([v011(claimed), v011.errors ?? []]).toEqual([true, []]);
    expect(TrashClaimSchema.safeParse(claimed).success).toBe(true);
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
