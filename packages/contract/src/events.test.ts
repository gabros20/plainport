import { describe, expect, test } from "bun:test";
import {
  OperationResultSchema,
  PHASES,
  PlainportEventSchema,
  PROJECT_STATES,
  StreamEventSchema,
  StreamLineSchema,
  UnknownEventSchema,
} from "./index.ts";

const f = { code: "git.unpushed", severity: "warn", message: "2 commits", allowable: true };

describe("events", () => {
  test("phases and project states match DESIGN.md Core API", () => {
    expect(PHASES).toEqual([
      "resolve",
      "preflight",
      "scan",
      "plan",
      "snapshot",
      "verify",
      "commit",
      "release",
      "restore",
      "swap",
      "agents",
      "toolchain",
      "hydrate",
      "hooks",
    ]);
    expect(PROJECT_STATES).toEqual([
      "local",
      "offloading",
      "shelved",
      "onloading",
      "restored-unhydrated",
      "conflicted",
      "unavailable",
    ]);
  });

  test("each event type validates", () => {
    const result = {
      ok: true,
      exitCode: 0,
      state: "shelved",
      project: "work:web",
      snapshot: "01J9",
      freedBytes: 5,
    };
    const events: unknown[] = [
      { type: "phase", op: "01J9", phase: "snapshot", status: "start" },
      { type: "progress", op: "01J9", phase: "snapshot", bytesDone: 1, bytesTotal: 2, etaSeconds: 41 },
      { type: "finding", op: "01J9", finding: f },
      { type: "log", op: "01J9", level: "info", message: "hello" },
      { type: "result", op: "01J9", result },
    ];
    for (const e of events) expect(PlainportEventSchema.parse(e) as unknown).toEqual(e);
  });

  test("bad events are rejected", () => {
    const bad = [
      { type: "phase", op: "01J9", phase: "upload", status: "start" },
      { type: "phase", op: "01J9", phase: "snapshot", status: "done" },
      { type: "progress", op: "01J9", phase: "snapshot", bytesDone: -1, bytesTotal: 2 },
      { type: "progress", op: "01J9", phase: "snapshot", bytesDone: 1.5, bytesTotal: 2 },
      { type: "finding", op: "01J9", finding: { ...f, allowable: undefined } },
      { type: "finding", op: "01J9", code: "git.unpushed", severity: "warn", message: "x" },
      { type: "log", op: "01J9", level: "error", message: "x" },
      { type: "nope", op: "01J9" },
      { type: "phase", phase: "snapshot", status: "start" },
    ];
    for (const e of bad) expect(PlainportEventSchema.safeParse(e).success).toBe(false);
  });

  test("the stdout stream carries only phase, progress and finding lines; logs go to stderr", () => {
    expect(
      StreamEventSchema.safeParse({ type: "phase", op: "x", phase: "scan", status: "end" }).success,
    ).toBe(true);
    expect(StreamEventSchema.safeParse({ type: "log", op: "x", level: "info", message: "m" }).success).toBe(
      false,
    );
    expect(
      StreamEventSchema.safeParse({
        type: "result",
        op: "x",
        result: { ok: true, exitCode: 0, state: "local" },
      }).success,
    ).toBe(false);
  });

  test("an operation result's exit code is from the table, and ok agrees with it", () => {
    expect(OperationResultSchema.safeParse({ ok: true, exitCode: 0, state: "local" }).success).toBe(true);
    expect(OperationResultSchema.safeParse({ ok: true, exitCode: 12, state: "local" }).success).toBe(false);
    expect(OperationResultSchema.safeParse({ ok: true, exitCode: 6, state: "local" }).success).toBe(false);
    expect(OperationResultSchema.safeParse({ ok: false, exitCode: 0, state: "local" }).success).toBe(false);
    expect(
      OperationResultSchema.safeParse({
        ok: false,
        exitCode: 10,
        state: "restored-unhydrated",
        error: { code: "hydrate.failed", message: "pnpm install failed" },
      }).success,
    ).toBe(true);
  });

  test("D17: readers accept an unknown event type; known types, phases and states stay closed", () => {
    const future = { type: "future", op: "x", anything: [1] };
    expect(UnknownEventSchema.safeParse(future).success).toBe(true);
    expect(StreamLineSchema.safeParse(future).success).toBe(true);
    for (const type of ["phase", "progress", "finding", "log", "result", ""]) {
      expect(UnknownEventSchema.safeParse({ type, op: "x" }).success).toBe(false);
    }
    expect(
      StreamLineSchema.safeParse({ type: "phase", op: "x", phase: "upload", status: "start" }).success,
    ).toBe(false);
    expect(StreamLineSchema.safeParse({ type: "log", op: "x", level: "info", message: "m" }).success).toBe(
      false,
    );
  });
});
