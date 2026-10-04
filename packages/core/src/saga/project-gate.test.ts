// The project gate's lock under I/O failures (AGENTS.md rule 7): a lock file that cannot be read or removed is a
// value the caller sees, never an exception that ends the command with internal.unexpected.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ok } from "@plainport/contract";
import type { LocalIo } from "../io.ts";
import { writeJournal } from "../journal/index.ts";
import { nodeLocalIo } from "../node-io.ts";
import { canonicalPath } from "../roots/canonical.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { nestedProjects, withProjectLock } from "./project-gate.ts";

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

describe("project gate: nested projects' interrupted operations (N1, D53)", () => {
  const INNER = "01ARYZ6S420000000000000000";
  const OP = "01ARYZ6S430000000000000000";
  const gate = () => ({ io: nodeLocalIo, paths: box.paths, clock: () => new Date(), log: () => {} });
  const innerJournal = async (step: "offload.verified" | "offload.release.delete") => {
    const at = "2026-10-04T12:00:00.000Z";
    const dir = join(box.home, "work/web/inner");
    await writeJournal(nodeLocalIo, box.paths, {
      v: 1,
      op: OP,
      kind: "offload",
      step,
      startedAt: at,
      updatedAt: at,
      pid: 999_999,
      host: "elsewhere",
      project: { id: INNER, address: "work:web/inner", root: "work", rootId: INNER, path: "web/inner", dir },
      store: { name: "ssd", id: INNER },
      attempts: [],
      history: [],
    });
  };
  const related = [{ id: INNER, address: "work:web/inner" }];

  test("an interrupted operation of a nested project holds the outer one back (journal.pending)", async () => {
    await innerJournal("offload.verified");
    let ran = false;
    const result = await withProjectLock(
      gate(),
      { id: ID, address: "work:web" },
      async () => {
        ran = true;
        return ok(undefined);
      },
      { related },
    );
    expect(result.ok ? 0 : [result.exitCode, result.finding.code]).toEqual([6, "journal.pending"]);
    if (!result.ok) expect(result.finding.message).toContain("work:web/inner, which is nested with work:web");
    expect(ran).toBe(false);
  });

  test("a resume that takes only its own project's journals never takes a nested one's", async () => {
    await innerJournal("offload.verified");
    const result = await withProjectLock(gate(), { id: ID, address: "work:web" }, async () => ok(undefined), {
      related,
      resume: (_, own) => own,
    });
    expect(result.ok ? 0 : result.finding.code).toBe("journal.pending");
  });

  test("recover and gc (resume everything) still run, and a nested journal is never handed over as resumed", async () => {
    await innerJournal("offload.verified");
    const result = await withProjectLock(
      gate(),
      { id: ID, address: "work:web" },
      async (_, resumed) => ok(resumed),
      { related, resume: () => true },
    );
    expect(result.ok ? result.value : result.finding.code).toBeUndefined();
  });

  test("a nested project's released trash (release.delete) holds nothing back", async () => {
    await innerJournal("offload.release.delete");
    const result = await withProjectLock(gate(), { id: ID, address: "work:web" }, async () => ok("ran"), {
      related,
    });
    expect(result.ok ? result.value : result.finding.code).toBe("ran");
  });
});

describe("project gate: nested projects by identity (F3, D53)", () => {
  test.skipIf(process.platform !== "darwin")(
    "a registered folder spelled through an alias realpath leaves apart is still nested with the plain spelling",
    async () => {
      const outer = join(box.home, "work/web");
      mkdirSync(join(outer, "inner"), { recursive: true });
      const firm = `/System/Volumes/Data${realpathSync(join(outer, "inner"))}`;
      const unfolded: LocalIo = {
        ...nodeLocalIo,
        fs: {
          ...nodeLocalIo.fs,
          realpath: async (path) => (path === firm ? path : nodeLocalIo.fs.realpath(path)),
        },
      };
      const canon = await canonicalPath(unfolded, firm, box.home);
      if (!canon.ok) throw new Error(canon.finding.message);
      const folders = [
        { id: "01ARYZ6S420000000000000000", address: "work:web/inner", folder: firm, canon: canon.value },
      ];
      const nested = await nestedProjects(unfolded, box.paths, folders, { id: ID, folder: outer });
      expect(nested.ok ? nested.value.map((n) => [n.address, n.inside]) : nested.finding.code).toEqual([
        ["work:web/inner", true],
      ]);
    },
  );
});
