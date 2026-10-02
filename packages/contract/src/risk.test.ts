import { describe, expect, test } from "bun:test";
import { DEFAULT_RISK, RISK_CLASSES, RiskClassSchema } from "./index.ts";

describe("risk classes", () => {
  test("exactly read, safe_write and confirm, in rising order", () => {
    expect(RISK_CLASSES).toEqual(["read", "safe_write", "confirm"]);
    expect(RiskClassSchema.options).toEqual(["read", "safe_write", "confirm"]);
    expect(RiskClassSchema.safeParse("deny").success).toBe(false);
  });

  test("a command that declares nothing is confirm", () => {
    expect(DEFAULT_RISK).toBe("confirm");
  });
});
