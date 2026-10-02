import { expect, test } from "bun:test";
import { packageName } from "./index.ts";

test("@plainport/core index loads", () => {
  expect(packageName).toBe("@plainport/core");
});
