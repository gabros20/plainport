import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { UNKNOWN_SEMANTICS } from "./ports/blob-store.ts";
import {
  pinSeal,
  readStoreSeal,
  readStoreState,
  recordMeasured,
  type StoreFacts,
  storeStateFile,
  updateStoreState,
} from "./stores-state.ts";
import { testHost } from "./testing/host.ts";
import { makeSandbox, type Sandbox } from "./testing/sandbox.ts";
import { ulid } from "./ulid.ts";

let box: Sandbox;
const io = testHost();
const STORE = ulid();
const facts: StoreFacts = { endpoint: "/Volumes/ssd/plainport", access: "local", restic: "0.18.0" };
const measured = { ...UNKNOWN_SEMANTICS, readAfterWrite: { value: true, evidence: "measured" as const } };
const AT = "2026-10-12T12:00:00.000Z";

const value = <T>(result: { ok: true; value: T } | { ok: false; finding: { message: string } }): T => {
  if (!result.ok) throw new Error(result.finding.message);
  return result.value;
};

beforeEach(() => {
  box = makeSandbox("plainport-stores-state-");
});
afterEach(() => box.cleanup());

describe("stores-state: this device's record of a store (Q4)", () => {
  test("[stores-state] lives at stores/<store id>.json under the state folder, empty until written", async () => {
    expect(storeStateFile(box.paths, STORE)).toBe(`${box.paths.stateDir}/stores/${STORE}.json`);
    expect(() => storeStateFile(box.paths, "archive")).toThrow(RangeError);
    expect(value(await readStoreState(io, box.paths, STORE, facts))).toEqual({ v: 1, store: STORE });
    expect(value(await readStoreSeal(io, box.paths, STORE))).toBeUndefined();
    expect(existsSync(storeStateFile(box.paths, STORE))).toBe(false);
  });

  test("[stores-state] a measurement holds for its facts; any change of endpoint, access or version invalidates it", async () => {
    value(await recordMeasured(io, box.paths, STORE, facts, { semantics: measured }));
    value(
      await recordMeasured(io, box.paths, STORE, facts, { test: { at: AT, ok: true, delete: "denied" } }),
    );
    const same = value(await readStoreState(io, box.paths, STORE, facts));
    expect(same.measured).toEqual({
      facts,
      semantics: measured,
      test: { at: AT, ok: true, delete: "denied" },
    });
    for (const changed of [
      { ...facts, endpoint: "/Volumes/other" },
      { ...facts, access: "sftp" },
      { ...facts, restic: "0.18.1" },
      { ...facts, rclone: "1.70.0" },
    ])
      expect(value(await readStoreState(io, box.paths, STORE, changed)).measured).toBeUndefined();
    // A new measurement under other facts replaces the old one whole: nothing measured before carries over.
    const moved = { ...facts, restic: "0.18.1" };
    value(await recordMeasured(io, box.paths, STORE, moved, { test: { at: AT, ok: false } }));
    expect(value(await readStoreState(io, box.paths, STORE, moved)).measured).toEqual({
      facts: moved,
      test: { at: AT, ok: false },
    });
  });

  test("[stores-state] the seal pin is taken once and survives any change of facts", async () => {
    expect(value(await pinSeal(io, box.paths, STORE, "v1", AT))).toEqual({ policy: "v1", at: AT });
    expect(value(await pinSeal(io, box.paths, STORE, "none", "2026-10-13T00:00:00.000Z"))).toEqual({
      policy: "v1",
      at: AT,
    });
    value(await recordMeasured(io, box.paths, STORE, facts, { semantics: measured }));
    const changed = value(await readStoreState(io, box.paths, STORE, { ...facts, access: "s3" }));
    expect(changed.seal).toEqual({ policy: "v1", at: AT });
    expect(changed.measured).toBeUndefined();
    expect(value(await readStoreSeal(io, box.paths, STORE))).toEqual({ policy: "v1", at: AT });
  });

  test("[stores-state] writes are atomic under a lock: a held lock refuses (store.locked) and nothing is written", async () => {
    value(await pinSeal(io, box.paths, STORE, "none", AT));
    const file = storeStateFile(box.paths, STORE);
    const before = readFileSync(file, "utf8");
    writeFileSync(
      `${file}.lock`,
      `${JSON.stringify({ pid: process.ppid, host: hostname(), startedAt: new Date().toISOString(), token: "held" })}\n`,
    );
    const refused = await updateStoreState(
      io,
      box.paths,
      STORE,
      () => ({ ok: true, value: { v: 1, store: STORE } }),
      {
        timeoutMs: 50,
      },
    );
    expect(refused.ok ? "ok" : refused.finding.code).toBe("store.locked");
    expect(readFileSync(file, "utf8")).toBe(before);
    // No temporary file is left beside it: the replace is a rename of a whole file.
    expect(readdirSync(dirname(file)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("[stores-state] concurrent changes all land: each is a locked read-change-write", async () => {
    await Promise.all([
      pinSeal(io, box.paths, STORE, "none", AT),
      recordMeasured(io, box.paths, STORE, facts, { semantics: measured }),
      recordMeasured(io, box.paths, STORE, facts, { test: { at: AT, ok: true } }),
    ]);
    const state = value(await readStoreState(io, box.paths, STORE, facts));
    expect(state.seal?.policy).toBe("none");
    expect(state.measured).toEqual({ facts, semantics: measured, test: { at: AT, ok: true } });
  });

  test("[stores-state] a damaged record is store.state-invalid and never overwritten", async () => {
    const file = storeStateFile(box.paths, STORE);
    value(await pinSeal(io, box.paths, STORE, "v1", AT));
    for (const text of [
      "{broken",
      JSON.stringify({ v: 1, store: ulid() }),
      JSON.stringify({ v: 2, store: STORE }),
    ]) {
      writeFileSync(file, text);
      const read = await readStoreSeal(io, box.paths, STORE);
      expect(read.ok ? "ok" : read.finding.code).toBe("store.state-invalid");
      // Moving it aside re-pins whatever the store shows: the fix says so.
      expect(read.ok ? "" : read.finding.fix).toContain("re-pins");
      const written = await updateStoreState(io, box.paths, STORE, (current) => ({
        ok: true,
        value: current,
      }));
      expect(written.ok ? "ok" : written.finding.code).toBe("store.state-invalid");
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  });
});
