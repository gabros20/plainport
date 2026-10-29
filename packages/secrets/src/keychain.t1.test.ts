// The keychain: provider against the real /usr/bin/security and a throwaway keychain (T1, macOS). The keychain is a
// file in a temp folder, made with HOME pointing at a sandbox, so `security` keeps its search list there; the provider
// reads and writes that file only, through its test hook. The user's own search list and default keychain must be
// byte-identical before and after; they are read, never written. Nothing here touches a real Keychain item.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Result } from "@plainport/contract";
import { posixSpawner } from "@plainport/host-macos";
import { describeT1Mac } from "../../../test/tiers.ts";
import {
  type Canary,
  expectNoCanary,
  makeCanary,
  recordArgv,
  recordOwnOutput,
} from "../../core/src/testing/canary.ts";
import { testHost } from "../../host-macos/src/testing.ts";
import { keychainProvider, SECURITY } from "./keychain.ts";

/** What `security` says about the user's own keychains, read with the user's real home: never written. */
const userKeychains = (): string => {
  const env = { HOME: userInfo().homedir, PATH: "/usr/bin:/bin" };
  const read = (args: string[]) => {
    const ran = Bun.spawnSync([SECURITY, ...args], { env, stdout: "pipe", stderr: "pipe" });
    return `${ran.exitCode}\n${ran.stdout.toString("latin1")}\n${ran.stderr.toString("latin1")}`;
  };
  return [read(["list-keychains", "-d", "user"]), read(["default-keychain", "-d", "user"])].join("\n--\n");
};

describeT1Mac("keychain: provider against a throwaway keychain", () => {
  let dir: string;
  let home: string;
  let keychain: string;
  let before: string;
  // The test host's guard refuses the real home; the recorded spawner keeps every argv for the canary.
  const recorded = recordArgv(posixSpawner);
  const { run } = testHost({ spawner: recorded.spawner });
  /** `security` with the sandbox's HOME: its search list and default keychain live there, not in the user's. */
  const security = (...args: string[]) => {
    const ran = Bun.spawnSync([SECURITY, ...args], {
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (ran.exitCode !== 0) throw new Error(`security ${args[0]} failed (${ran.exitCode})`);
  };
  const provider = () =>
    keychainProvider({ run, env: { HOME: home, PATH: "/usr/bin:/bin" }, testKeychain: keychain });

  beforeAll(() => {
    before = userKeychains();
    dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-keychain-")));
    home = join(dir, "home");
    mkdirSync(home);
    keychain = join(dir, "throwaway.keychain-db");
    const password = makeCanary("kcpassword").value;
    security("create-keychain", "-p", password, keychain);
    // Unlocked, and never locking again while the suite runs: a locked keychain would ask for its password.
    security("unlock-keychain", "-p", password, keychain);
    security("set-keychain-settings", keychain);
  });

  let deleted = false;
  const deleteKeychain = () => {
    if (deleted) return;
    deleted = true;
    security("delete-keychain", keychain);
  };

  afterAll(() => {
    try {
      deleteKeychain();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** One provider call, watched by the canary everywhere but its ok result and the keychain file itself. */
  const watched = async <T>(canary: Canary, call: () => Promise<Result<T>>): Promise<Result<T>> => {
    recorded.argv.length = 0;
    const errors: unknown[] = [];
    const own = await recordOwnOutput(() =>
      call().catch((error: unknown) => {
        errors.push(error);
        return undefined;
      }),
    );
    expect(errors).toEqual([]);
    const result = own.value as Result<T>;
    expectNoCanary([canary], {
      stdout: own.stdout,
      stderr: own.stderr,
      findings: result.ok ? [] : [result.finding],
      argv: recorded.argv,
      dirs: [home],
    });
    return result;
  };

  test("set through security -i, then get: the value round trips and is in no argv", async () => {
    const canary = makeCanary("keychain");
    const value = `${canary.value} with spaces, "double" and 'single' quotes, a back\\slash\\ and ~!@#$%^&*()`;
    const ref = `keychain:plainport test/b2 "key" it's \\here`;
    const keychainProvider = provider();
    const set = keychainProvider.set as NonNullable<typeof keychainProvider.set>;
    expect(await watched(canary, () => set(ref, value))).toEqual({ ok: true, value: undefined });
    expect(recorded.argv).toEqual([[SECURITY, "-i"]]);
    expect(await watched(canary, () => keychainProvider.get(ref))).toEqual({ ok: true, value });
    // -U updates the item in place.
    const again = `${canary.value}-rotated`;
    expect((await watched(canary, () => set(ref, again))).ok).toBe(true);
    expect(await watched(canary, () => keychainProvider.get(ref))).toEqual({ ok: true, value: again });
  });

  test("missing: store.secret-missing whose fix is the interactive add-generic-password", async () => {
    const canary = makeCanary("keychain");
    const got = await watched(canary, () => provider().get("keychain:plainport/no-such-item"));
    expect(got.ok ? "" : got.finding.code).toBe("store.secret-missing");
    expect(got.ok ? "" : got.finding.fix).toContain(
      "security add-generic-password -s 'plainport' -a 'no-such-item' -w",
    );
  });

  test("empty: store.secret-missing", async () => {
    const canary = makeCanary("keychain");
    security("add-generic-password", "-s", "plainport", "-a", "empty", "-w", "", keychain);
    const got = await watched(canary, () => provider().get("keychain:plainport/empty"));
    expect(got.ok ? "" : got.finding.message).toContain("is empty");
  });

  test("garbled, and an injection: refused before security runs", async () => {
    const canary = makeCanary("keychain");
    const keychainProvider = provider();
    const set = keychainProvider.set as NonNullable<typeof keychainProvider.set>;
    expect((await watched(canary, () => keychainProvider.get("keychain:no-account"))).ok).toBe(false);
    const injected = await watched(canary, () =>
      set(`keychain:plainport/x" "-w" "y"\n"delete-keychain" "${keychain}`, canary.value),
    );
    expect(injected.ok ? "" : injected.finding.code).toBe("usage.invalid");
    expect(recorded.argv).toEqual([]);
  });

  // Last: the throwaway keychain is deleted, and the user's keychains are as they were.
  test("the user's search list and default keychain are byte-identical before and after", () => {
    deleteKeychain();
    expect(userKeychains()).toBe(before);
  });
});
