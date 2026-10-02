import { describe, expect, test } from "bun:test";
import { isUlid, UlidSchema, ulid } from "./ulid.ts";

const zeros = (bytes: Uint8Array): Uint8Array => bytes.fill(0);
const ones = (bytes: Uint8Array): Uint8Array => bytes.fill(0xff);

describe("config: device ids are ULIDs", () => {
  test("encodes the time in the first ten characters (the spec's example)", () => {
    expect(ulid(1469918176385, zeros)).toBe("01ARYZ6S410000000000000000");
    expect(ulid(1469918176385, ones)).toBe("01ARYZ6S41ZZZZZZZZZZZZZZZZ");
    expect(ulid(0, zeros)).toBe("00000000000000000000000000");
    expect(ulid(2 ** 48 - 1, ones)).toBe("7ZZZZZZZZZZZZZZZZZZZZZZZZZ");
  });

  test("is 26 Crockford base32 characters and sorts by time", () => {
    const a = ulid(1_000);
    const b = ulid(2_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => ulid())).size).toBe(1000);
  });

  test("refuses a time outside 48 bits", () => {
    expect(() => ulid(-1)).toThrow();
    expect(() => ulid(2 ** 48)).toThrow();
    expect(() => ulid(1.5)).toThrow();
  });

  test("UlidSchema and isUlid accept canonical upper-case ULIDs only", () => {
    expect(isUlid("01ARYZ6S410000000000000000")).toBe(true);
    expect(isUlid("01aryz6s410000000000000000")).toBe(false);
    expect(isUlid("01ARYZ6S41000000000000000I")).toBe(false);
    expect(isUlid("81ARYZ6S410000000000000000")).toBe(false);
    expect(isUlid("01ARYZ6S41")).toBe(false);
    expect(UlidSchema.safeParse("01ARYZ6S410000000000000000").success).toBe(true);
  });
});
