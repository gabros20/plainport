import { expect, test } from "bun:test";
import * as contract from "@plainport/contract";
import * as core from "@plainport/core";
import { packageName } from "./index.ts";

test("@plainport/cli index loads", () => {
  expect(packageName).toBe("@plainport/cli");
});

test("@plainport/cli reaches core and contract through the workspace", () => {
  expect(core.packageName).toBe("@plainport/core");
  expect(contract.packageName).toBe("@plainport/contract");
});
