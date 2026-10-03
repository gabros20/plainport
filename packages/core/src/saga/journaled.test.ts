import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fail, finding } from "@plainport/contract";
import { journalFile, type OffloadJournal } from "../journal/index.ts";
import { testHost } from "../testing/host.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { ulid } from "../ulid.ts";
import { openSaga, runSaga, withFix } from "./journaled.ts";

let box: Sandbox;
beforeEach(() => {
  box = makeSandbox("plainport-journaled-");
});
afterEach(() => box.cleanup());

const fresh = (): OffloadJournal => {
  const at = new Date().toISOString();
  return {
    v: 1,
    op: ulid(),
    kind: "offload",
    step: "offload.begin",
    startedAt: at,
    updatedAt: at,
    pid: process.pid,
    host: "test",
    project: {
      id: ulid(),
      address: "work:web",
      root: "work",
      rootId: ulid(),
      path: "web",
      dir: `${box.home}/work/web`,
    },
    store: { name: "ssd", id: ulid() },
    attempts: [],
    history: [],
  };
};
const open = (journal: OffloadJournal) =>
  openSaga(
    { io: testHost(), paths: box.paths, faultAt: () => {}, clock: () => new Date(), log: () => {} },
    journal,
  );

describe("runSaga: what a failure leaves", () => {
  test("a failure before the commit removes the journal", async () => {
    const journal = fresh();
    const saga = open(journal);
    await runSaga(saga, async () => {
      await saga.step("offload.begin");
      return fail(finding("store.unreachable", { message: "unplugged" }));
    });
    expect(existsSync(journalFile(box.paths, journal.op))).toBe(false);
  });

  test("a kept failure keeps its journal, also once it is wrapped (withFix, a spread)", async () => {
    for (const wrap of [
      (f: ReturnType<typeof fail>) => withFix(f, "another fix"),
      (f: ReturnType<typeof fail>) => ({ ...f }),
    ]) {
      const journal = fresh();
      const saga = open(journal);
      await runSaga(saga, async () => {
        await saga.step("offload.begin");
        return wrap(saga.keep(fail(finding("store.unreachable", { message: "unplugged" }))));
      });
      expect(existsSync(journalFile(box.paths, journal.op))).toBe(true);
    }
  });
});
