import { expect, test } from "bun:test";
import * as core from "@plainport/core";
import { packageName } from "./index.ts";

test("@plainport/engine-restic index loads", () => {
  expect(packageName).toBe("@plainport/engine-restic");
});

test("@plainport/engine-restic reaches @plainport/core through the workspace", () => {
  expect(core.packageName).toBe("@plainport/core");
});
