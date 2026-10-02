import { expect, test } from "bun:test";
import * as core from "@plainport/core";
import { packageName } from "./index.ts";

test("@plainport/eco-node index loads", () => {
  expect(packageName).toBe("@plainport/eco-node");
});

test("@plainport/eco-node reaches @plainport/core through the workspace", () => {
  expect(core.packageName).toBe("@plainport/core");
});
