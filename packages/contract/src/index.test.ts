import { expect, test } from "bun:test";
import { packageName } from "./index.ts";

test("@plainport/contract index loads", () => {
  expect(packageName).toBe("@plainport/contract");
});
