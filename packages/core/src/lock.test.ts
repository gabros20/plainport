import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { finding } from "@plainport/contract";
import type { LocalIo } from "./io.ts";
import { acquireLock, type LockOptions } from "./lock.ts";
import { nodeLocalIo } from "./node-io.ts";

let dir: string;
let lockPath: string;
const children: Bun.Subprocess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainport-lock-"));
  lockPath = join(dir, "thing.lock");
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  rmSync(dir, { recursive: true, force: true });
});

const options = (timeoutMs: number): LockOptions => ({
  timeoutMs,
  held: (holder, path) =>
    finding("config.locked", {
      message: `thing is locked by ${holder === undefined ? "an unreadable lock" : `process ${holder.pid}`}`,
      fix: `delete ${path}`,
      paths: [path],
    }),
});

const holderFile = (pid: number, host = hostname()): void =>
  writeFileSync(lockPath, JSON.stringify({ pid, host, startedAt: "2026-10-03T00:00:00.000Z" }));

/** The pid of a process that has exited, so nothing holds it. */
const deadPid = async (): Promise<number> => {
  const child = Bun.spawn([process.execPath, "-e", "0"]);
  await child.exited;
  return child.pid;
};

/** A live process other than this one. */
const livePid = (): number => {
  const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60_000)"]);
  children.push(child);
  return child.pid;
};

describe("lock: a lock file shared by processes on one machine", () => {
  test("acquire writes pid, host and start time; release removes it", async () => {
    const lock = await acquireLock(nodeLocalIo, lockPath, options(1000));
    if (!lock.ok) throw new Error(lock.finding.message);
    const holder = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(holder).toEqual({ pid: process.pid, host: hostname(), startedAt: expect.any(String) });
    expect(await lock.value.stillHeld()).toBe(true);
    await lock.value.release();
    expect(existsSync(lockPath)).toBe(false);
    await lock.value.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a lock this process holds is waited for like any other, then taken once released", async () => {
    const first = await acquireLock(nodeLocalIo, lockPath, options(1000));
    if (!first.ok) throw new Error(first.finding.message);
    const busy = await acquireLock(nodeLocalIo, lockPath, options(100));
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.finding.message).toContain(String(process.pid));
    const second = acquireLock(nodeLocalIo, lockPath, options(10_000));
    await Bun.sleep(50);
    await first.value.release();
    const taken = await second;
    if (!taken.ok) throw new Error(taken.finding.message);
    await taken.value.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a lock file naming this process's pid that this process does not hold is stale (pid reuse)", async () => {
    holderFile(process.pid);
    const lock = await acquireLock(nodeLocalIo, lockPath, options(1000));
    if (!lock.ok) throw new Error(lock.finding.message);
    await lock.value.release();
  });

  test("a lock left by a dead process on this host is broken", async () => {
    holderFile(await deadPid());
    const lock = await acquireLock(nodeLocalIo, lockPath, options(1000));
    if (!lock.ok) throw new Error(lock.finding.message);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    await lock.value.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a lock held by another live process times out with the caller's finding", async () => {
    const pid = livePid();
    holderFile(pid);
    const result = await acquireLock(nodeLocalIo, lockPath, options(150));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.finding.code).toBe("config.locked");
    expect(result.exitCode).toBe(11);
    expect(result.finding.message).toContain(String(pid));
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(pid);
  });

  test("a lock held on another host, or unreadable, is never broken", async () => {
    holderFile(1, "some-other-host");
    expect((await acquireLock(nodeLocalIo, lockPath, options(100))).ok).toBe(false);
    writeFileSync(lockPath, "garbage");
    const result = await acquireLock(nodeLocalIo, lockPath, options(100));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.finding.message).toContain("unreadable");
    expect(readFileSync(lockPath, "utf8")).toBe("garbage");
  });

  test("waiting uses the io's clock and sleep, and writes nothing while the holder is alive", async () => {
    holderFile(4242);
    let now = 0;
    let writes = 0;
    let sleeps = 0;
    const io: LocalIo = {
      fs: {
        ...nodeLocalIo.fs,
        writeTextDurable: async (path, text) => {
          writes++;
          await nodeLocalIo.fs.writeTextDurable(path, text);
        },
      },
      proc: {
        ...nodeLocalIo.proc,
        isAlive: async () => true,
        monotonicMs: () => now,
        sleep: async (ms) => {
          sleeps++;
          now += ms;
        },
      },
    };
    const started = performance.now();
    const result = await acquireLock(io, lockPath, { ...options(60_000), pollMs: 1000 });
    expect(result.ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(sleeps).toBe(60);
    expect(writes).toBe(0);
  });
});
