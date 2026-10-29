import { expect, test } from "bun:test";
import * as core from "@plainport/core";
import { packageName, rcloneBlobStore } from "./index.ts";

test("@plainport/blob-rclone index loads", () => {
  expect(packageName).toBe("@plainport/blob-rclone");
  expect(typeof rcloneBlobStore).toBe("function");
});

test("@plainport/blob-rclone reaches @plainport/core through the workspace", () => {
  expect(core.packageName).toBe("@plainport/core");
});
