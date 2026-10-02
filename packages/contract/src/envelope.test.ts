import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  EnvelopeSchema,
  envelopeSchema,
  errorEnvelope,
  exitCodeOf,
  PLAINPORT_JSON,
  parseJsonLines,
  successEnvelope,
} from "./index.ts";

const finalOk = { plainport_json: 1, ok: true, verb: "offload", data: { op: "01J9Z6K2", freedBytes: 5 } };

describe("envelope", () => {
  test("the version key is plainport_json: 1", () => {
    expect(PLAINPORT_JSON).toBe(1);
  });

  test("a success envelope validates, with data checked against the verb's schema", () => {
    const schema = envelopeSchema(z.object({ op: z.string(), freedBytes: z.number() }));
    expect(schema.parse(finalOk) as unknown).toEqual(finalOk);
    expect(schema.safeParse({ ...finalOk, data: { op: 1 } }).success).toBe(false);
    expect(successEnvelope("offload", finalOk.data) as unknown).toEqual(finalOk);
  });

  test("an error envelope validates and error.code is the exit code", () => {
    const env = errorEnvelope(
      "offload",
      3,
      "offload is confirm-class",
      "re-run: plainport offload web --yes",
    );
    expect(env).toEqual({
      plainport_json: 1,
      ok: false,
      verb: "offload",
      error: { code: 3, message: "offload is confirm-class", hint: "re-run: plainport offload web --yes" },
    });
    expect(EnvelopeSchema.parse(env)).toEqual(env);
    expect(exitCodeOf(env)).toBe(3);
    expect(exitCodeOf(successEnvelope("ls", []))).toBe(0);
    expect(errorEnvelope("ls", 4, "no project 'x'")).not.toHaveProperty("error.hint");
  });

  test("error.code must be a failure exit code from the table", () => {
    const base = { plainport_json: 1, ok: false, verb: "ls", error: { code: 4, message: "m" } };
    expect(EnvelopeSchema.safeParse(base).success).toBe(true);
    for (const code of [0, 12, 127, "4"]) {
      expect(EnvelopeSchema.safeParse({ ...base, error: { code, message: "m" } }).success).toBe(false);
    }
  });

  test("malformed envelopes are rejected", () => {
    const bad = [
      { ...finalOk, plainport_json: 2 },
      { ...finalOk, ops_json: 1, plainport_json: undefined },
      { ...finalOk, verb: "" },
      { ...finalOk, data: undefined },
      { ...finalOk, ok: false },
      { ...finalOk, error: { code: 1, message: "m" } },
      { plainport_json: 1, ok: false, verb: "ls", error: { code: 1, message: "m" }, data: {} },
      { plainport_json: 1, ok: false, verb: "ls" },
      { ...finalOk, count: 3 },
    ];
    for (const e of bad) expect(EnvelopeSchema.safeParse(e).success).toBe(false);
  });
});

describe("NDJSON stream", () => {
  const lines = [
    { type: "phase", op: "01J9Z6K2", phase: "snapshot", status: "start" },
    { type: "progress", op: "01J9Z6K2", phase: "snapshot", bytesDone: 512, bytesTotal: 1934, etaSeconds: 41 },
    {
      type: "finding",
      op: "01J9Z6K2",
      finding: { code: "git.unpushed", severity: "warn", message: "2 commits", allowable: true },
    },
    finalOk,
  ];
  const text = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;

  test("event lines then exactly one final envelope parse", () => {
    const parsed = parseJsonLines(text);
    expect(parsed as unknown).toEqual({ ok: true, value: { events: lines.slice(0, 3), envelope: finalOk } });
  });

  test("a single envelope line is a whole stream", () => {
    const parsed = parseJsonLines(`${JSON.stringify(finalOk)}\n`);
    expect(parsed.ok).toBe(true);
  });

  test("streams that break the one-final-envelope rule fail without throwing", () => {
    const env = JSON.stringify(finalOk);
    const ev = JSON.stringify(lines[0]);
    const bad = [
      "",
      ev,
      `${env}\n${ev}`,
      `${env}\n${env}`,
      `${ev}\nnot json\n${env}`,
      `${JSON.stringify({ type: "log", op: "x", level: "info", message: "m" })}\n${env}`,
      `${ev}\n\n${env}`,
    ];
    for (const t of bad) {
      const parsed = parseJsonLines(t);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.finding.code).toBe("contract.invalid");
        expect(parsed.exitCode).toBe(1);
      }
    }
  });

  test("data is checked against the verb's schema when one is given", () => {
    expect(parseJsonLines(text, z.object({ op: z.string(), freedBytes: z.number() })).ok).toBe(true);
    expect(parseJsonLines(text, z.object({ op: z.number() })).ok).toBe(false);
  });
});
