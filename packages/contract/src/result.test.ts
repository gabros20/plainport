import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { decode, fail, finding, ok, type Result } from "./index.ts";

describe("Result", () => {
  test("ok wraps a value", () => {
    expect(ok(3)).toEqual({ ok: true, value: 3 });
  });

  test("fail carries an exit code and a finding, and exitCode comes from the catalogue by default", () => {
    const f = finding("tool.missing", { message: "restic not found" });
    expect(fail(f)).toEqual({ ok: false, exitCode: 6, finding: f });
    expect(fail(f, 9)).toEqual({ ok: false, exitCode: 9, finding: f });
  });

  test("decode never throws for bad input: it returns a contract.invalid failure", () => {
    const schema = z.object({ n: z.number() });
    const inputs: unknown[] = [
      undefined,
      null,
      "x",
      1,
      [],
      { n: "1" },
      {
        get n() {
          return "1";
        },
      },
    ];
    for (const input of inputs) {
      let result: Result<{ n: number }> | undefined;
      expect(() => {
        result = decode(schema, input);
      }).not.toThrow();
      expect(result?.ok).toBe(false);
      if (result?.ok !== false) continue;
      expect(result.exitCode).toBe(1);
      expect(result.finding.code).toBe("contract.invalid");
      expect(result.finding.message.length).toBeGreaterThan(0);
    }
  });

  test("decode names the thing being decoded, and passes a valid value through", () => {
    const schema = z.object({ n: z.number() });
    const bad = decode(schema, { n: "1" }, "device.json");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.finding.message).toContain("device.json");
    expect(decode(schema, { n: 1 })).toEqual({ ok: true, value: { n: 1 } });
  });

  test("decode turns a throwing refinement into a failure too", () => {
    const schema = z.string().refine(() => {
      throw new Error("boom");
    });
    const result = decode(schema, "x");
    expect(result.ok).toBe(false);
  });
});
