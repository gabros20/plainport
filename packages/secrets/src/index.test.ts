import { expect, test } from "bun:test";
import * as core from "@plainport/core";
import { packageName, secretProviders } from "./index.ts";

test("@plainport/secrets index loads", () => {
  expect(packageName).toBe("@plainport/secrets");
});

test("@plainport/secrets reaches @plainport/core through the workspace", () => {
  expect(core.packageName).toBe("@plainport/core");
});

test("secretProviders gives a store opener both providers that run a child", () => {
  const providers = secretProviders({ run: async () => core.RUN_DEFAULTS as never, env: {} });
  expect(Object.keys(providers).sort()).toEqual(["keychain", "op"]);
  expect(typeof providers.keychain?.set).toBe("function");
});
