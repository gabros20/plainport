import { describe, expect, test } from "bun:test";
import { fail, finding } from "@plainport/contract";
import { capturedOutput } from "./runner.ts";
import type { RunOutcome } from "./types.ts";

const outcome = (over: Partial<RunOutcome>): RunOutcome => ({
  exitCode: 0,
  signal: null,
  stdout: { text: "", droppedBytes: 0 },
  stderr: { text: "", droppedBytes: 0 },
  leftoversStopped: false,
  durationMs: 1,
  ...over,
});

const failed = (o: RunOutcome) =>
  fail(finding("process.spawn-failed", { message: `exit ${o.exitCode} signal ${o.signal}` }));

describe("runner: capturedOutput, the exit-code check a capture caller cannot skip", () => {
  test("exit 0 with a capture gives its bytes", () => {
    const bytes = new TextEncoder().encode("[]\n");
    expect(capturedOutput(outcome({ captured: bytes }), failed)).toEqual({ ok: true, value: bytes });
  });

  test("a non-zero exit is the caller's failure, even though the run itself was ok", () => {
    const result = capturedOutput(outcome({ exitCode: 12, captured: new Uint8Array() }), failed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.finding.message).toBe("exit 12 signal null");
  });

  test("a child ended by a signal is the caller's failure", () => {
    const result = capturedOutput(
      outcome({ exitCode: null, signal: "SIGKILL", captured: new Uint8Array() }),
      failed,
    );
    expect(result.ok).toBe(false);
  });

  test("a run started without capture is a bug", () => {
    expect(() => capturedOutput(outcome({}), failed)).toThrow(/capture/);
  });
});
