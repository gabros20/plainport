// The crash matrix, subprocess variant on a local store (T1; ADR-0017): every row the matrix enumerates (matrix.ts),
// run by the compiled binary with the real restic on a local folder store, killed by a real SIGKILL at the row's step or
// seam, then `plainport recover`, then the row's checks (checks.ts). The harness (harness.ts) says how a row is run and
// why the binary is hooked; remote.t2.test.ts runs the same rows on SFTP and S3 stores.
//
// macOS only in M2 (see harness.ts). Rows are independent, so they run a few at a time (PLAINPORT_CRASH_PARALLEL; 6
// locally, 3 on CI, never more than the cores): restic derives its key on every call, and one row makes some fifteen.

import { afterAll, beforeAll, describe, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseStoreIdentity } from "../../packages/core/src/catalog/identity.ts";
import { macOnlyTests, onMac } from "../platform.ts";
import { describeT1, tierEnabled } from "../tiers.ts";
import { DAMAGE_MODE, damage, laterHeadProblems, settleJournals } from "./checks.ts";
import {
  alive,
  childrenOf,
  crashAt,
  type Harness,
  inRow,
  killed,
  LOCAL_KIND,
  makeHarness,
  offloadArgs,
  type RowOptions,
  RowRun,
  removeHarness,
  rowWork,
  signal,
  slots,
  testMs,
} from "./harness.ts";
import { ALL_ROWS, MATRIX_POINTS, OFFLOAD_ROWS, ONLOAD_ROWS, plainRowAt, type Row } from "./matrix.ts";

const checkout = resolve(import.meta.dir, "../..");
const KIND = LOCAL_KIND;
/** Rows at once. */
const PARALLEL = (() => {
  const asked = Number(process.env.PLAINPORT_CRASH_PARALLEL);
  return Number.isInteger(asked) && asked > 0 ? asked : KIND.parallel;
})();
const slot = slots(PARALLEL);
/** A row's test timeout: its own time plus the longest wait for a slot. */
const TEST_MS = testMs(ALL_ROWS.length, PARALLEL);

let harness: Harness;

beforeAll(async () => {
  if (!tierEnabled(1) || !onMac) return;
  harness = await makeHarness();
}, 180_000);

afterAll(async () => {
  if (!tierEnabled(1) || !onMac) return;
  await removeHarness(harness);
}, 180_000);

/** Files below a folder (restic's packs under repo/data). */
const countFiles = (dir: string): number => {
  let n = 0;
  const walk = (d: string) => {
    for (const e of existsSync(d) ? readdirSync(d, { withFileTypes: true }) : [])
      if (e.isDirectory()) walk(join(d, e.name));
      else n++;
  };
  walk(dir);
  return n;
};

const runRow = (row: Row, options: RowOptions = {}) =>
  inRow(harness, KIND, slot, (r) => rowWork(r, row, options));

/** A row's test: green when its checks find nothing, or, in the damage mode, when they find the harm done. */
const rowTest = (row: Row) => async () => {
  const problems = await runRow(row, DAMAGE_MODE ? { damage } : {});
  if (DAMAGE_MODE) expect(problems.length).toBeGreaterThan(0);
  else expect(problems).toEqual([]);
};

describeT1("crash matrix, SIGKILL subprocess", () => {
  // Every test here is macOS-only in M1 (see the file comment), counted so a skip never passes for a run on a Mac.
  const macTest = macOnlyTests();
  const macRow = macOnlyTests(process.env, { concurrent: true });

  macTest(
    "a binary built by scripts/build.ts ignores the fault variables: the offload runs to its end",
    async () => {
      const release = join(harness.scratch, "plainport-release");
      const build = Bun.spawnSync(
        [process.execPath, join(checkout, "scripts/build.ts"), "--outfile", release],
        { cwd: checkout, stdout: "pipe", stderr: "pipe" },
      );
      expect(build.exitCode).toBe(0);
      const r = new RowRun(harness, KIND);
      try {
        await r.init();
        const ran = await r.run(offloadArgs, crashAt("offload.committed"), undefined, release);
        expect({ code: ran.code, signal: ran.signal }).toEqual({ code: 0, signal: null });
      } finally {
        await r.cleanup();
        rmSync(release, { force: true });
      }
    },
    120_000,
  );

  for (const [saga, rows] of [
    ["offload", OFFLOAD_ROWS],
    ["onload", ONLOAD_ROWS],
  ] as const)
    describe(`${saga} (${rows.length} rows)`, () => {
      for (const row of rows) macRow(row.name, rowTest(row), TEST_MS);
    });

  // Two crashes while restic runs, not at a step; the journal stays at the upload's step either way, so each row is
  // that step's, with more demands (uploadCrashRow):
  //
  // 1. Mid-upload: once restic has written a pack of this upload, the test freezes plainport and restic's whole process
  //    group (SIGSTOP), then checks that no snapshot exists yet, and only then SIGKILLs them, as a power cut or an OOM
  //    kill would. If restic had already written its snapshot when it was frozen (a slow machine: the upload finished
  //    between the pack and the freeze), the attempt is the second case, not this one: it is run again, at most three
  //    times, and never passes as this case.
  // 2. Committed: plainport is frozen as soon as its restic backup starts, restic runs alone until its snapshot file
  //    is in the repository's snapshots/ (polled, with a deadline), then plainport is killed before it could journal
  //    offload.snapshot.done. DESIGN's rule for the step (roll back) and D28 (d) keep that snapshot in the repository,
  //    named by no event, never a head. An attempt in which restic wrote no snapshot misses this case's precondition:
  //    it is run again, at most three times, and never passes.
  //
  // Both demand: recover rolled back (the rule allows nothing else but pending, which the row refuses), the folder is
  // untouched, and a later offload succeeds over what the dead restic left (a lock, packs) and becomes the head. An
  // attempt that missed its precondition is a setup misfire, reported as one, never as a product failure.
  macRow(
    `${MATRIX_POINTS.upload} · mid-upload SIGKILL of plainport and restic's process group`,
    async () => {
      const { problems, leftover } = await uploadCrashRowRetried("mid-upload");
      expect(problems).toEqual([]);
      // The kill really landed mid-upload: packs written, the dead restic's lock left, no snapshot yet.
      expect(leftover.packs).toBeGreaterThan(0);
      expect(leftover.locks).toBeGreaterThan(0);
      expect(leftover.snapshots).toBe(0);
    },
    TEST_MS,
  );

  macRow(
    `${MATRIX_POINTS.upload} · restic committed its snapshot, plainport killed before journaling it`,
    async () => {
      const { problems, leftover } = await uploadCrashRowRetried("committed");
      expect(problems).toEqual([]);
      expect(leftover.snapshots).toBe(1);
    },
    TEST_MS,
  );
});

/** An attempt whose scenario's precondition did not happen: a setup misfire, not a product failure. */
class PreconditionMissed extends Error {}

/** An upload-crash row, run again when its precondition was missed, at most three times. */
const uploadCrashRowRetried = async (mode: "mid-upload" | "committed") => {
  const missed: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await uploadCrashRow(mode);
    } catch (error) {
      if (!(error instanceof PreconditionMissed)) throw error;
      missed.push(`attempt ${attempt}: ${error.message}`);
      console.warn(
        `crash matrix: the ${mode} row's precondition missed (${error.message}); running it again`,
      );
    }
  }
  throw new Error(
    `setup misfire, not a product failure: the ${mode} precondition never held (${missed.join("; ")})`,
  );
};

/** The restic backups a process is running: its restic children whose arguments say backup. */
const backups = (parent: number): number[] =>
  childrenOf(parent, "restic").filter((pid) =>
    Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)], {
      env: { PATH: "/usr/bin:/bin" },
      stdout: "pipe",
    })
      .stdout.toString()
      .includes(" backup "),
  );

/** Whether a process has ended: gone, or a zombie its frozen parent has not reaped (only a ps that answered says so). */
const ended = (pid: number): boolean => {
  if (!alive(pid)) return true;
  const ps = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], {
    env: { PATH: "/usr/bin:/bin" },
    stdout: "pipe",
  });
  return ps.exitCode === 0 && ps.stdout.toString().trim().startsWith("Z");
};

/** The repository folder the store at ~/ssd publishes in its store.json. */
const repositoryOf = (home: string): string => {
  const identity = parseStoreIdentity(readFileSync(join(home, "ssd/meta/v1/store.json")));
  if (identity === undefined) throw new Error("the store's store.json is not a store identity");
  return identity.repo;
};

const uploadCrashRow = async (mode: "mid-upload" | "committed") => {
  let leftover = { packs: 0, locks: 0, snapshots: -1 };
  const problems = await runRow(plainRowAt(MATRIX_POINTS.upload), {
    crash: async (r) => {
      // Mid-upload: incompressible bytes, several 16 MiB packs, so restic writes packs while the upload still runs.
      if (mode === "mid-upload") {
        writeFileSync(join(r.dir, "data/blob.bin"), randomBytes(40 * 1024 * 1024));
        r.noteEdit("data/blob.bin");
      }
      // The repository the store publishes: repo/ on an M1 store, repos/<attempt> on one bootstrap set up (Task 19).
      const repo = join(r.box.home, "ssd", repositoryOf(r.box.home));
      const count = () => ({
        packs: countFiles(join(repo, "data")),
        locks: countFiles(join(repo, "locks")),
        snapshots: countFiles(join(repo, "snapshots")),
      });
      const child = r.spawn(offloadArgs);
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      // Generous: a loaded CI runner derives restic's key slowly.
      const deadline = Date.now() + 180_000;
      let restic: number[] = [];
      const waitFor = async (what: string, done: () => boolean) => {
        while (!done()) {
          if (child.exitCode !== null || Date.now() > deadline) {
            r.stop();
            const [out, err] = await output;
            // The run outran the test (it ended, or the deadline passed, before the moment it needed): a misfire.
            throw new PreconditionMissed(`${what} never came (exit ${child.exitCode}): ${err}${out}`);
          }
          await Bun.sleep(2);
        }
      };
      await waitFor("restic's backup", () => {
        restic = backups(child.pid);
        return restic.length > 0;
      });
      for (const pid of restic) r.groups.add(pid);
      if (mode === "committed") {
        // plainport stands still; restic runs alone until its snapshot is in the repository, and plainport never sees
        // it finish. Then restic is given a moment to end (it unlocks after the snapshot); if it is still running,
        // it is killed with its snapshot already written, which is the state this case needs.
        signal(child.pid, "SIGSTOP");
        const snapshotted = () => countFiles(join(repo, "snapshots")) > 0;
        while (!snapshotted() && !restic.every(ended) && Date.now() < deadline) await Bun.sleep(5);
        if (!snapshotted()) {
          r.stop();
          throw new PreconditionMissed(
            restic.every(ended)
              ? "restic ended without writing a snapshot"
              : "no snapshot within the deadline",
          );
        }
        const settle = Date.now() + 30_000;
        while (!restic.every(ended) && Date.now() < settle) await Bun.sleep(10);
      } else {
        await waitFor("a pack of the upload", () => countFiles(join(repo, "data")) > 0);
        signal(child.pid, "SIGSTOP");
        for (const pid of restic) signal(-pid, "SIGSTOP");
      }
      leftover = count();
      // The runner gives each child its own process group (pgid = its pid): kill the group, as a crash would.
      for (const pid of restic) signal(-pid, "SIGKILL");
      signal(child.pid, "SIGKILL");
      await child.exited;
      const [out, err] = await output;
      killed({ code: child.exitCode, signal: child.signalCode, out, err }, "offload");
      const gone = Date.now() + 10_000;
      while (restic.some(alive) && Date.now() < gone) await Bun.sleep(10);
      if (restic.some(alive)) throw new Error(`restic ${restic.join(", ")} outlived its SIGKILL`);
      if (mode === "mid-upload" && leftover.snapshots > 0)
        throw new PreconditionMissed("restic had written its snapshot before it was frozen");
    },
    after: async (r, crashedOp) => {
      const later = await r.run(offloadArgs);
      if (later.code !== 0) return [`a later offload exited ${later.code}: ${later.err}${later.out}`];
      await settleJournals(r.box.paths);
      return laterHeadProblems(
        await r.world(),
        r.projectId(),
        crashedOp,
        r.reference,
        mode === "mid-upload" ? "none" : "kept",
      );
    },
  });
  return { problems, leftover };
};
