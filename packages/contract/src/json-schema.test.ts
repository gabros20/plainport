import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { contractJsonSchemas, inputObject, outputObject } from "./index.ts";

describe("JSON Schema export", () => {
  const schemas = contractJsonSchemas();

  test("exports every public contract schema", () => {
    expect(Object.keys(schemas).sort()).toEqual(
      [
        "envelope",
        "event",
        "exit-code",
        "finding",
        "operation-result",
        "phase",
        "project-state",
        "risk-class",
        "stream-event",
      ].sort(),
    );
  });

  test("each is a draft 2020-12 document", () => {
    for (const schema of Object.values(schemas)) {
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    }
  });

  test("the export is deterministic and JSON-serialisable", () => {
    expect(JSON.stringify(contractJsonSchemas())).toBe(JSON.stringify(schemas));
  });

  test("D16: output schemas never close additionalProperties; input objects stay strict", () => {
    const closed = (node: unknown): boolean => {
      if (Array.isArray(node)) return node.some(closed);
      if (node === null || typeof node !== "object") return false;
      const record = node as Record<string, unknown>;
      if (record.additionalProperties === false) return true;
      return Object.values(record).some(closed);
    };
    for (const [name, schema] of Object.entries(schemas)) {
      expect({ name, closed: closed(schema) }).toEqual({ name, closed: false });
    }
    const output = z.toJSONSchema(outputObject({ a: z.string() }));
    const input = z.toJSONSchema(inputObject({ a: z.string() }));
    expect(closed(output)).toBe(false);
    expect(input.additionalProperties).toBe(false);
    expect(outputObject({ a: z.string() }).safeParse({ a: "x", b: 1 }).success).toBe(true);
    expect(inputObject({ a: z.string() }).safeParse({ a: "x", b: 1 }).success).toBe(false);
  });

  test("D17: the published event schemas accept an unknown event type", () => {
    expect(JSON.stringify(schemas["stream-event"])).toContain('"title":"UnknownEvent"');
    expect(JSON.stringify(schemas.event)).toContain('"title":"UnknownEvent"');
  });

  test("key facts survive the export", () => {
    const text = JSON.stringify(schemas.envelope);
    expect(text).toContain("plainport_json");
    expect(JSON.stringify(schemas["exit-code"])).toContain("130");
    expect(JSON.stringify(schemas.finding)).toContain("allowable");
  });
});
