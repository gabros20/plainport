// The binary's store opener carries the secret providers (Task 15): a store whose secret is an op: reference reads it
// through the 1Password CLI on the user's PATH, here a fake one in a sandbox.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testHost } from "../../core/src/testing/host.ts";
import { localStores } from "./stores.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-cli-stores-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("the opener reads keychain: and op: references through its providers", async () => {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "op"), '#!/bin/sh\n[ "$1" = read ] && printf "from-op"\n');
  chmodSync(join(bin, "op"), 0o755);
  const opener = localStores(testHost(), { HOME: dir, PATH: `${bin}:/usr/bin:/bin` });
  expect(typeof opener.secrets?.keychain?.get).toBe("function");
  expect(await opener.secrets?.op?.get("op://Private/plainport/password")).toEqual({
    ok: true,
    value: "from-op",
  });
});
