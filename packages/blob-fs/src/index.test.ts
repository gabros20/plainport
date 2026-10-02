import { expect, test } from "bun:test";
import * as core from "@plainport/core";
import { packageName } from "./index.ts";

test("@plainport/blob-fs index loads", () => {
  expect(packageName).toBe("@plainport/blob-fs");
});

test("@plainport/blob-fs reaches @plainport/core through the workspace", () => {
  expect(core.packageName).toBe("@plainport/core");
});
