import { expect, test } from "bun:test";
import { fail, finding, ok } from "../../packages/contract/src/index.ts";
import { statusEvidence } from "./observation.ts";

const result = (text: string, exitCode = 0) =>
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
