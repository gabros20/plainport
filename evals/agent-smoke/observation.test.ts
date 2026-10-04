import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fail, finding, ok } from "../../packages/contract/src/index.ts";
import { statusEvidence } from "./observation.ts";
import { scoreTranscript, type Transcript } from "./scorer.ts";

const result = (text: string, exitCode: number | null = 0) =>
  ok({
    exitCode,
    signal: null,
    stdout: { text, droppedBytes: 0 },
    stderr: { text: "", droppedBytes: 0 },
    captured: new TextEncoder().encode(text),
    leftoversStopped: false,
    durationMs: 1,
  });
test("status evidence records failed, malformed and wrong-project observations as issues", () => {
  for (const observation of [
    result("", 1),
    result("oops"),
    result('{"plainport_json":1,"ok":true,"verb":"status","data":{}}'),
    result(
      '{"plainport_json":1,"ok":true,"verb":"status","data":{"address":"other:fixture","state":"local"}}',
    ),
    fail(finding("command.cancelled", { message: "cancelled" })),
  ]) {
    const evidence = statusEvidence(observation);
    expect(evidence.observation).toBeUndefined();
    expect(evidence.issues.length).toBeGreaterThan(0);
  }
  expect(
    statusEvidence(
      result(
        '{"plainport_json":1,"ok":true,"verb":"status","data":{"address":"work:fixture","state":"local"}}',
      ),
    ).observation,
  ).toEqual({ project: "work:fixture", state: "local" });
});

const unregistered = JSON.parse(
  readFileSync(new URL("transcripts/unregistered.json", import.meta.url), "utf8"),
) as Transcript & { observerResults: { stdout: string; exitCode: number }[] };

test("four pre-offload calls record unregistered evidence and score a later round trip", () => {
  const transcript = structuredClone(unregistered);
  for (const [index, response] of transcript.observerResults.entries()) {
    const evidence = statusEvidence(result(response.stdout, response.exitCode));
    expect(evidence).toEqual({
      observation: { project: "work:fixture", state: "unregistered" },
      issues: [],
    });
    const call = transcript.calls[index];
    if (!call) throw new Error("Fixture is missing a pre-offload call");
    call.issues = evidence.issues;
    if (evidence.observation) transcript.observations.push({ ...evidence.observation, afterCall: index + 1 });
  }
  expect(scoreTranscript(transcript).contractIssues).toEqual([]);
  expect(scoreTranscript(transcript).passed).toBe(true);
  expect(scoreTranscript({ ...transcript, observations: transcript.observations.slice(2) }).passed).toBe(
    false,
  );
  expect(
    scoreTranscript({ ...transcript, finalObservation: { project: "work:fixture", state: "unregistered" } })
      .returnedLocal,
  ).toBe(false);
});

test("not-found evidence still rejects malformed envelopes, wrong verbs and exit mismatches", () => {
  const response = unregistered.observerResults[0];
  if (!response) throw new Error("Fixture is missing its status response");
  const envelope = JSON.parse(response.stdout);
  for (const candidate of [
    result("oops", 4),
    result(JSON.stringify({ ...envelope, error: { code: 4 } }), 4),
    result(JSON.stringify({ ...envelope, verb: "offload" }), 4),
    result(JSON.stringify({ ...envelope, error: { ...envelope.error, code: 6 } }), 4),
    result(JSON.stringify({ ...envelope, error: { ...envelope.error, finding: undefined } }), 4),
    result(
      JSON.stringify({
        ...envelope,
        error: { ...envelope.error, finding: { ...envelope.error.finding, code: "command.unknown" } },
      }),
      4,
    ),
    result(response.stdout, 0),
    result(response.stdout, 6),
    result(response.stdout, null),
  ]) {
    const evidence = statusEvidence(candidate);
    expect(evidence.observation).toBeUndefined();
    expect(evidence.issues.length).toBeGreaterThan(0);
    const transcript = structuredClone(unregistered);
    const call = transcript.calls[0];
    const message = evidence.issues[0];
    if (!call || !message) throw new Error("Expected a call and an evidence issue");
    call.issues = evidence.issues;
    expect(scoreTranscript(transcript).contractIssues).toContainEqual({
      code: "call.evidence-incomplete",
      message,
      call: 1,
    });
  }
});
