import { describe, expect, test } from "bun:test";
import { contractJsonSchemas } from "./index.ts";

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

  test("key facts survive the export", () => {
    const text = JSON.stringify(schemas.envelope);
    expect(text).toContain("plainport_json");
    expect(JSON.stringify(schemas["exit-code"])).toContain("130");
    expect(JSON.stringify(schemas.finding)).toContain("allowable");
  });
});
