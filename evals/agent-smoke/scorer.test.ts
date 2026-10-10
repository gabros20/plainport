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
    "agent.confusing",
    "lifecycle.not-shelved",
    "lifecycle.not-local",
    "lifecycle.not-restored",
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
  expect(scoreTranscript({ ...transcript, agentExitCode: 1 }).clean).toBe(false);
});

test("scorer rejects malformed recordings instead of silently counting them", () => {
  expect(() => scoreTranscript({ calls: [] })).toThrow();
  const transcript = recorded("pass") as Record<string, unknown>;
  expect(() =>
    scoreTranscript({
      ...transcript,
      observations: [{ afterCall: 1, project: "work:fixture", state: "not-a-state" }],
    }),
  ).toThrow();
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

test("scorer requires the final independent fixture state to stay local", () => {
  const transcript = recorded("pass") as Record<string, unknown>;
  expect(
    scoreTranscript({
      ...transcript,
      finalObservation: { project: "work:fixture", state: "shelved" },
      observations: [
        { afterCall: 1, project: "work:fixture", state: "shelved" },
        { afterCall: 2, project: "work:fixture", state: "local" },
        { afterCall: 5, project: "work:fixture", state: "shelved" },
      ],
    }).returnedLocal,
  ).toBe(false);
});

test("scorer recognizes a human help finding and fix, but never substitutes stderr for JSON", () => {
  const transcript = recorded("pass") as { calls: Record<string, unknown>[] };
  const refusal = {
    argv: ["help", "nonexistent"],
    exitCode: 4,
    stdout: "",
    stderr: "plainport: command.unknown: unknown command: nonexistent\nfix: plainport help\n",
  };
  expect(
    scoreTranscript({ ...transcript, calls: [...transcript.calls, refusal] }).refusalsMissingFix,
  ).toEqual([]);
  expect(scoreTranscript({ ...transcript, calls: [...transcript.calls, refusal] }).contractIssues).toEqual(
    [],
  );
  expect(
    scoreTranscript({
      ...transcript,
      calls: [...transcript.calls, { ...refusal, stderr: "fix: plainport help\n" }],
    }).refusalsMissingFix,
  ).toEqual([6]);
  expect(
    scoreTranscript({
      ...transcript,
      calls: [...transcript.calls, { ...refusal, argv: ["help", "nonexistent", "--json"] }],
    }).refusalsMissingFix,
  ).toEqual([6]);
});

test("scorer uses the public envelope schema", () => {
  const transcript = recorded("pass") as { calls: Record<string, unknown>[] };
  for (const envelope of [
    { plainport_json: 1, ok: true, verb: "onload" },
    { plainport_json: 1, ok: true, verb: "onload", data: {}, error: { code: 6, message: "oops" } },
  ]) {
    expect(
      scoreTranscript({
        ...transcript,
        calls: [
          ...transcript.calls,
          { argv: ["onload", "--json"], exitCode: 0, stdout: JSON.stringify(envelope), stderr: "" },
        ],
      }).contractIssues.map((issue) => issue.code),
    ).toContain("output.invalid-json");
  }
});

test("scorer judges final local only from independent final status", () => {
  const transcript = recorded("pass") as Record<string, unknown>;
  expect(scoreTranscript({ ...transcript, finalObservation: undefined }).returnedLocal).toBe(false);
  expect(
    scoreTranscript({ ...transcript, finalObservation: { project: "work:fixture", state: "shelved" } })
      .returnedLocal,
  ).toBe(false);
});

test("scorer accepts final independent local evidence after shelving without earlier local evidence", () => {
  const transcript = recorded("pass") as Record<string, unknown>;
  expect(
    scoreTranscript({
      ...transcript,
      observations: [{ afterCall: 5, project: "work:fixture", state: "shelved" }],
    }).returnedLocal,
  ).toBe(true);
});

test("scorer requires a successful fixture onload reporting restore from the store", () => {
  expect(scoreTranscript(recorded("pass")).passed).toBe(true);
  const reused = recorded("reuse") as { calls: { stdout: string }[] };
  const score = scoreTranscript(reused);
  expect(score.passed).toBe(false);
  expect(score.contractIssues.map((issue) => issue.code)).toContain("lifecycle.not-restored");
  for (const data of [{}, { project: "other:fixture", restored: "restore" }]) {
    const candidate = structuredClone(reused);
    const call = candidate.calls.at(-1);
    if (!call) throw new Error("Missing fixture onload");
    call.stdout = JSON.stringify({ plainport_json: 1, ok: true, verb: "onload", data });
    expect(scoreTranscript(candidate).passed).toBe(false);
  }
});

test("scorer accepts onload after leading global flags", () => {
  const transcript = recorded("leading-globals") as { calls: { argv: string[] }[] };
  expect(scoreTranscript(transcript).passed).toBe(true);
  const call = transcript.calls.at(-1);
  if (!call) throw new Error("Missing fixture onload");
  call.argv = ["--config", "onload", "--store=offload", "--json", "onload", "work:fixture"];
  expect(scoreTranscript(transcript).contractIssues).toEqual([]);
  call.argv = ["--json", "--", "onload", "work:fixture"];
  expect(scoreTranscript(transcript).passed).toBe(false);
});

test("scorer splits passed (the four objective checks) from clean (no contract issues)", () => {
  const pass = scoreTranscript(recorded("pass"));
  expect([pass.passed, pass.clean]).toEqual([true, true]);
  // Shelved, back local, restored from the store and byte-identical, but the agent was confused on the way.
  const confused = scoreTranscript({
    ...(recorded("pass") as Record<string, unknown>),
    agentIssues: ["lost"],
  });
  expect(confused.contractIssues.map((issue) => issue.code)).toEqual(["agent.confusing"]);
  expect([confused.passed, confused.clean]).toEqual([true, false]);
  // Evidence the harness could not collect leaves nothing to trust: neither verdict holds.
  const blind = scoreTranscript(recorded("unregistered"));
  expect([blind.passed, blind.clean]).toEqual([false, false]);
  const failed = scoreTranscript(recorded("fail"));
  expect([failed.passed, failed.clean]).toEqual([false, false]);
  // Each objective check alone fails `passed`; an agent that exits badly after a good round trip only loses `clean`.
  const transcript = recorded("pass") as Record<string, unknown>;
  expect(scoreTranscript({ ...transcript, fixtureIntact: false }).passed).toBe(false);
  const badExit = scoreTranscript({ ...transcript, agentExitCode: 1 });
  expect([badExit.passed, badExit.clean]).toEqual([true, false]);
});
