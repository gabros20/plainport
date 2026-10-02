import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  EnvelopeSchema,
  envelopeSchema,
  errorEnvelope,
  exitCodeOf,
  type FailureExitCode,
  finding,
  type PartialExitCode,
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
    const env = errorEnvelope("offload", 3, "offload is confirm-class", {
      hint: "re-run: plainport offload web --yes",
    });
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
    expect(errorEnvelope("ls", 4, "no project 'x'")).not.toHaveProperty("data");
  });

  test("a refusal names its finding: error.finding is the finding object (AGENTS.md: a refusal names its code)", () => {
    const f = finding("risk.needs-yes", {
      message: "offload is confirm-class",
      fix: "plainport offload web --yes",
    });
    const env = errorEnvelope("offload", 3, f.message, { hint: `re-run: ${f.fix}`, finding: f });
    expect(env).toEqual({
      plainport_json: 1,
      ok: false,
      verb: "offload",
      error: {
        code: 3,
        message: "offload is confirm-class",
        hint: "re-run: plainport offload web --yes",
        finding: f,
      },
    });
    expect(EnvelopeSchema.parse(env)).toEqual(env);
    const broken = { ...env, error: { code: 3, message: "m", finding: { code: "x" } } };
    expect(EnvelopeSchema.safeParse(broken).success).toBe(false);
  });

  test("a partial success (D14) carries data next to error, checked against the verb's schema", () => {
    const data = { project: "work:web", snapshot: "01J9Z6K2" };
    const env = errorEnvelope("onload", 10, "restored but not hydrated", {
      hint: "plainport hydrate web",
      data,
    });
    expect(env as unknown).toEqual({
      plainport_json: 1,
      ok: false,
      verb: "onload",
      error: { code: 10, message: "restored but not hydrated", hint: "plainport hydrate web" },
      data,
    });
    expect(EnvelopeSchema.parse(env) as unknown).toEqual(env);
    expect(exitCodeOf(env)).toBe(10);
    const schema = envelopeSchema(z.object({ project: z.string(), snapshot: z.string() }));
    expect(schema.safeParse(env).success).toBe(true);
    expect(schema.safeParse({ ...env, data: { project: 1 } }).success).toBe(false);
    expect(EnvelopeSchema.safeParse({ ...env, data: undefined }).success).toBe(true);
  });

  test("D14: only exit 8 and exit 10 may carry data", () => {
    for (const code of [1, 2, 3, 4, 5, 6, 7, 9, 11, 130]) {
      const env = { plainport_json: 1, ok: false, verb: "onload", error: { code, message: "m" }, data: {} };
      expect(EnvelopeSchema.safeParse(env).success).toBe(false);
    }
    for (const code of [8, 10]) {
      const env = { plainport_json: 1, ok: false, verb: "onload", error: { code, message: "m" }, data: {} };
      expect(EnvelopeSchema.safeParse(env).success).toBe(true);
    }
    // @ts-expect-error data is only for exit 8 and 10
    expect(() => errorEnvelope("ls", 4, "no project", { data: { project: "x" } })).toThrow(TypeError);
  });

  test("D14 holds at runtime when the code is not a literal", () => {
    const codeFrom = (n: number): FailureExitCode => n as FailureExitCode;
    const code = codeFrom(4);
    // @ts-expect-error a FailureExitCode variable may not carry data
    expect(() => errorEnvelope("ls", code, "no project", { data: { project: "x" } })).toThrow(TypeError);
    const partial: PartialExitCode = 10;
    expect(
      EnvelopeSchema.parse(errorEnvelope("onload", partial, "not hydrated", { data: { project: "x" } })),
    ).toBeTruthy();
  });

  test("D16: an envelope from a newer plainport, with a field this version does not know, still validates", () => {
    expect(EnvelopeSchema.safeParse({ ...finalOk, warnings: 2 }).success).toBe(true);
    expect(
      EnvelopeSchema.safeParse({
        plainport_json: 1,
        ok: false,
        verb: "ls",
        error: { code: 4, message: "m", docs: "u" },
      }).success,
    ).toBe(true);
    // but the reserved keys still decide the branch: a success never carries error
    expect(EnvelopeSchema.safeParse({ ...finalOk, error: { code: 1, message: "m" } }).success).toBe(false);
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
      { plainport_json: 1, ok: false, verb: "ls" },
      { plainport_json: 1, ok: false, verb: "ls", error: { code: 1, message: "m" }, data: {} },
      { plainport_json: 1, ok: false, verb: "ls", error: { code: 4, message: "m" }, data: { project: "x" } },
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
    expect(parsed as unknown).toEqual({
      ok: true,
      value: { events: lines.slice(0, 3), unknownEvents: [], envelope: finalOk },
    });
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

  test("D17: an event line of a type this version does not know is passed through, not a failure", () => {
    const future = { type: "future", op: "01J9Z6K2", detail: 1 };
    const parsed = parseJsonLines(
      [lines[0], future, lines[1], finalOk].map((l) => JSON.stringify(l)).join("\n"),
    );
    expect(parsed as unknown).toEqual({
      ok: true,
      value: { events: [lines[0], lines[1]], unknownEvents: [{ line: 2, event: future }], envelope: finalOk },
    });
    // a known type that is malformed still fails, and so do log and result lines on stdout
    const badPhase = JSON.stringify({ type: "phase", op: "x", phase: "upload", status: "start" });
    expect(parseJsonLines(`${badPhase}\n${JSON.stringify(finalOk)}`).ok).toBe(false);
    const noType = JSON.stringify({ op: "x" });
    expect(parseJsonLines(`${noType}\n${JSON.stringify(finalOk)}`).ok).toBe(false);
  });

  test("parseJsonLines never throws, even when the caller's data schema throws", () => {
    const throwing = z.json().refine(() => {
      throw new Error("boom");
    });
    let parsed: ReturnType<typeof parseJsonLines> | undefined;
    expect(() => {
      parsed = parseJsonLines(`${JSON.stringify(finalOk)}\n`, throwing);
    }).not.toThrow();
    expect(parsed?.ok).toBe(false);
  });

  test("an empty stream says so", () => {
    const parsed = parseJsonLines("");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.finding.message).toContain("empty");
  });

  test("data is checked against the verb's schema when one is given", () => {
    expect(parseJsonLines(text, z.object({ op: z.string(), freedBytes: z.number() })).ok).toBe(true);
    expect(parseJsonLines(text, z.object({ op: z.number() })).ok).toBe(false);
  });
});
