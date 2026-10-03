import { describe, expect, test } from "bun:test";
import { systemErrorCode } from "./io.ts";

describe("io: systemErrorCode", () => {
  test("gives the errno code of a system error", () => {
    expect(systemErrorCode(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }))).toBe(
      "ENOENT",
    );
    expect(systemErrorCode(Object.assign(new Error("EACCES"), { code: "EACCES", errno: -13 }))).toBe(
      "EACCES",
    );
  });

  test("rethrows anything that is not one: a bug stays an exception", () => {
    expect(() => systemErrorCode(new TypeError("undefined is not a function"))).toThrow(TypeError);
    const refused = Object.assign(new Error("refused"), { code: "ERR_PLAINPORT_PATH_REFUSED" });
    expect(() => systemErrorCode(refused)).toThrow(refused);
    expect(() => systemErrorCode("a string")).toThrow();
    expect(() => systemErrorCode(undefined)).toThrow();
  });
});
