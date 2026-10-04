import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { scoreTranscript } from "./scorer.ts";

const recorded = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`transcripts/${name}.json`, import.meta.url), "utf8"));

test("scorer accepts a recorded round trip and counts a repaired refusal", () => {
  const score = scoreTranscript(recorded("pass"));
  expect(score.passed).toBe(true);
  expect(score.reachedShelved).toBe(true);
  expect(score.returnedLocal).toBe(true);
  expect(score.calls).toBe(5);
  expect(score.nonZeroExits).toBe(1);
  expect(score.refusalsMissingFix).toEqual([]);
  expect(score.contractIssues).toEqual([]);
});

test("scorer reports every missing fix, hint and confusing message in a failed run", () => {
  const score = scoreTranscript(recorded("fail"));
  expect(score.passed).toBe(false);
  expect(score.reachedShelved).toBe(false);
  expect(score.returnedLocal).toBe(false);
  expect(score.calls).toBe(2);
  expect(score.nonZeroExits).toBe(2);
  expect(score.refusalsMissingFix).toEqual([1, 2]);
  expect(score.contractIssues.map((issue) => issue.code)).toEqual([
    "refusal.missing-fix",
    "refusal.missing-hint",
    "refusal.missing-fix",
    "refusal.missing-hint",
    "message.confusing",
    "agent.confusing",
    "lifecycle.not-shelved",
    "lifecycle.not-local",
  ]);
});

test("scorer requires ordered observations for the fixture, byte integrity and a completed agent", () => {
  const transcript = recorded("pass") as Record<string, unknown>;
  expect(
    scoreTranscript({
      ...transcript,
      observations: [
        { afterCall: 0, project: "work:fixture", state: "local" },
        { afterCall: 4, project: "other:fixture", state: "shelved" },
      ],
    }).passed,
  ).toBe(false);
  expect(scoreTranscript({ ...transcript, fixtureIntact: false }).passed).toBe(false);
  expect(scoreTranscript({ ...transcript, agentExitCode: 1 }).passed).toBe(false);
});

test("scorer rejects malformed recordings instead of silently counting them", () => {
  expect(() => scoreTranscript({ calls: [] })).toThrow();
});

test("scorer reports calls that bypass JSON and malformed event lines", () => {
  const transcript = recorded("pass") as { calls: Record<string, unknown>[] };
  expect(
    scoreTranscript({
      ...transcript,
      calls: [
        ...transcript.calls,
        { argv: ["status", "work:fixture"], exitCode: 0, stdout: "local\n", stderr: "" },
      ],
    }).contractIssues.map((issue) => issue.code),
  ).toContain("output.json-required");
  expect(
    scoreTranscript({
      ...transcript,
      calls: [
        ...transcript.calls,
        {
          argv: ["status", "work:fixture", "--json"],
          exitCode: 0,
          stdout: 'oops\n{"plainport_json":1,"ok":true,"verb":"status","data":{}}\n',
          stderr: "",
        },
      ],
    }).contractIssues.map((issue) => issue.code),
  ).toContain("output.invalid-event");
});

test("scorer requires the last observed fixture state to stay local", () => {
  const transcript = recorded("pass") as Record<string, unknown>;
  expect(
    scoreTranscript({
      ...transcript,
      observations: [
        { afterCall: 1, project: "work:fixture", state: "shelved" },
        { afterCall: 2, project: "work:fixture", state: "local" },
        { afterCall: 5, project: "work:fixture", state: "shelved" },
      ],
    }).returnedLocal,
  ).toBe(false);
});
