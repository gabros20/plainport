import { expect, test } from "bun:test";
import * as core from "@plainport/core";
import { packageName } from "./index.ts";

test("@plainport/host-macos index loads", () => {
  expect(packageName).toBe("@plainport/host-macos");
});

test("@plainport/host-macos reaches @plainport/core through the workspace", () => {
  expect(core.packageName).toBe("@plainport/core");
});
