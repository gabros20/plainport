// T1 (M2 Task 20): catalogKey against the real restic on a temp repository. Two passwords of one repository give the
// same key, since both open the one master key; another repository gives another key, and a wrong password none.
// CI's restic matrix runs it on every supported restic (PLAINPORT_RESTIC_MATRIX: 0.18.1 and the pinned 0.19.1, D93).
// The canary is the repository's real master key: every component of it, in every spelling, is looked for in the
// sandbox, plainport's own output, the findings, the events, the returned key and the argv of every restic run.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlainportEvent, Result } from "@plainport/contract";
import {
  type CatalogKey,
  deriveSealKey,
  type Engine,
  type HostPorts,
  keyId,
  masterKeyMaterial,
  type RunSpec,
  toolPath,
} from "@plainport/core";
import { testHost } from "@plainport/host-macos/testing";
import { describeT1, resticUnderTest } from "../../../test/tiers.ts";
import {
  type Canary,
  expectNoCanary,
  makeMasterKeyCanary,
  recordOwnOutput,
} from "../../core/src/testing/canary.ts";
import { resticEngine } from "./engine.ts";

const TIMEOUT = 60_000;
const STORE = "01K6ZB7Q3M8XWJ5N2T4R6Y8VCD";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

describeT1("restic engine: catalogKey on the real restic", () => {
  const host = testHost();
  const matrix = resticUnderTest();
  const argv: string[][] = [];
  /** The host's runner, every argv recorded for the canary. */
  const recording: Pick<HostPorts, "run"> = {
    run: (spec: RunSpec) => {
      argv.push([spec.command, ...(spec.args ?? [])]);
      return host.run(spec);
    },
  };
  let root: string;
  let resticPath: string;

  const make = (password: string, repo = "repo"): Engine =>
    resticEngine({
      host: recording,
      restic: resticPath,
      repository: join(root, repo),
      password,
      env: { PATH: "/usr/bin:/bin", HOME: join(root, "home"), TMPDIR: join(root, "tmp") },
      cacheDir: join(root, "cache"),
      retryLock: null,
      ...(matrix === undefined ? {} : { expectedVersion: matrix.version }),
    });

  /** restic run directly by the test, outside plainport: its stdout, which may be the master key. */
  const restic = async (repo: string, password: string, args: string[]): Promise<string> => {
    const ran = value(
      await host.run({
        command: resticPath,
        args: ["--repo", join(root, repo), "--cache-dir", join(root, "cache"), ...args],
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", HOME: join(root, "home"), RESTIC_PASSWORD: password },
        sensitive: true,
        capture: { maxBytes: 64 * 1024 },
      }),
    );
    if (ran.exitCode !== 0) throw new Error(`restic ${args.join(" ")} exited ${ran.exitCode}`);
    return new TextDecoder().decode(ran.captured);
  };

  /** The canary over the repository's own master key: mac.k, mac.r and encrypt, as makeMasterKeyCanary orders them. */
  const masterCanary = (json: string): Canary => {
    const parsed = JSON.parse(json) as { encrypt: string; mac: { k: string; r: string } };
    const parts = [parsed.mac.k, parsed.mac.r, parsed.encrypt].map(
      (b64) => new Uint8Array(Buffer.from(b64, "base64")),
    );
    return makeMasterKeyCanary(() => parts.shift() ?? new Uint8Array());
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "plainport-catalog-key-t1-"));
    mkdirSync(join(root, "home"));
    mkdirSync(join(root, "tmp"));
    if (matrix === undefined) {
      const found = await toolPath(host, "restic", { env: {} });
      if (!found.ok) throw new Error(found.finding.message);
      resticPath = found.value.path;
    } else resticPath = matrix.path;
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test(
    "two passwords of one repository give the same key; another repository another; nothing of the master key leaks",
    async () => {
      value(await make("first-password").init());
      writeFileSync(join(root, "tmp", "second"), "second-password\n");
      await restic("repo", "first-password", [
        "key",
        "add",
        "--new-password-file",
        join(root, "tmp", "second"),
      ]);
      rmSync(join(root, "tmp", "second"));
      const master = await restic("repo", "first-password", ["--no-lock", "cat", "masterkey"]);
      const canary = masterCanary(master);
      const material = value(masterKeyMaterial(master));
      const expected = value(deriveSealKey(material, STORE));

      const events: PlainportEvent[] = [];
      const errors: unknown[] = [];
      argv.length = 0;
      const own = await recordOwnOutput(async () => {
        const keys: Result<CatalogKey>[] = [];
        for (const password of ["first-password", "second-password"])
          keys.push(
            await make(password)
              .catalogKey(STORE, { op: "t1", emit: (event) => events.push(event) })
              .catch((error: unknown) => {
                errors.push(error);
                throw error;
              }),
          );
        // A wrong password gives no key, and its finding says nothing of the key either.
        keys.push(await make("wrong-password").catalogKey(STORE, { op: "t1" }));
        return keys;
      });
      const [first, second, wrong] = own.value;
      expect(value(first as Result<CatalogKey>)).toEqual({ key: expected, kid: keyId(expected) });
      expect(value(second as Result<CatalogKey>)).toEqual({ key: expected, kid: keyId(expected) });
      expect(wrong?.ok ? "ok" : wrong?.finding.code).toBe("restic.wrong-password");
      expect(errors).toEqual([]);
      expect(events.filter((event) => event.type !== "log")).toEqual([]);
      expectNoCanary([canary], {
        dirs: [root],
        stdout: own.stdout,
        stderr: own.stderr,
        events,
        findings: wrong?.ok ? [] : [wrong?.finding],
        argv,
        returned: [Buffer.from(expected).toString("hex"), keyId(expected)],
      });
      // Reading the key took no lock: the repository holds none.
      expect(await restic("repo", "first-password", ["--no-lock", "list", "locks"])).toBe("");

      // Another repository: another master key, so another catalog key for the same store id.
      value(await make("first-password", "other").init());
      const other = value(await make("first-password", "other").catalogKey(STORE));
      expect(other.kid).not.toBe(keyId(expected));
    },
    TIMEOUT,
  );
});
