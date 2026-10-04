// The project gate's lock under I/O failures (AGENTS.md rule 7): a lock file that cannot be read or removed is a
// value the caller sees, never an exception that ends the command with internal.unexpected.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ok } from "@plainport/contract";
import type { LocalIo } from "../io.ts";
import { nodeLocalIo } from "../node-io.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { withProjectLock } from "./project-gate.ts";

const ID = "01ARYZ6S410000000000000000";
let box: Sandbox;
beforeEach(() => {
  box = makeSandbox("plainport-gate-");
});
afterEach(() => box.cleanup());

const eio = () => Object.assign(new Error("EIO: injected"), { code: "EIO" });

describe("project gate: a lock file that fails I/O (I9)", () => {
  test("stillHeld reads an unreadable lock file as lost, with a warning, and never throws", async () => {
    const lockFile = join(box.paths.locksDir, `${ID}.lock`);
    let broken = false;
    const io: LocalIo = {
      ...nodeLocalIo,
      fs: {
        ...nodeLocalIo.fs,
        readText: async (path) => {
          if (broken && path === lockFile) throw eio();
          return nodeLocalIo.fs.readText(path);
        },
      },
    };
    const warnings: string[] = [];
    const gate = {
      io,
      paths: box.paths,
      clock: () => new Date(),
      log: (_: "warn", m: string) => warnings.push(m),
    };
    const result = await withProjectLock(gate, { id: ID, address: "work:web" }, async (lock) => {
      const before = await lock.stillHeld();
      broken = true;
      return ok([before, await lock.stillHeld()]);
    });
    expect(result.ok ? result.value : result.finding.code).toEqual([true, false]);
    expect(warnings.join("\n")).toContain(`the lock ${lockFile} could not be read (EIO)`);
    // The release could not read it either, which is a warning too; the lock left behind is broken as stale later.
    broken = false;
    const again = await withProjectLock(gate, { id: ID, address: "work:web" }, async () => ok("again"));
    expect(again.ok ? again.value : again.finding.code).toBe("again");
    expect(existsSync(lockFile)).toBe(false);
  });
});
