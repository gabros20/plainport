// The op: provider against a fake `op` on a sandbox PATH (T1: real process groups): it answers, is signed out, or hangs
// as a sign-in prompt would. The canary is handed to the fake through a file, never argv, and must show up in the ok
// value only; a hanging op is stopped at the deadline with nothing left in its process group. No real 1Password item
// is read.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "@plainport/contract";
import type { Spawner } from "@plainport/core";
import { posixSpawner } from "@plainport/host-macos";
import { describeT1 } from "../../../test/tiers.ts";
import {
  type Canary,
  expectNoCanary,
  makeCanary,
  recordArgv,
  recordOwnOutput,
} from "../../core/src/testing/canary.ts";
import { testHost } from "../../host-macos/src/testing.ts";
import { opProvider } from "./op.ts";

describeT1("op: provider against a fake op", () => {
  let dir: string;
  let bin: string;
  const groups: number[] = [];
  const grouping: Spawner = {
    spawn: (request) => {
      const child = posixSpawner.spawn(request);
      groups.push(child.pid);
      return child;
    },
    signalGroup: (pgid, signal) => posixSpawner.signalGroup(pgid, signal),
  };
  const recorded = recordArgv(grouping);
  const { run } = testHost({ spawner: recorded.spawner });

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-op-")));
    bin = join(dir, "bin");
    mkdirSync(bin);
    recorded.argv.length = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const pgid of groups.splice(0)) {
      const left = Bun.spawnSync(["/usr/bin/pgrep", "-g", String(pgid)], {
        stdout: "pipe",
      }).stdout.toString();
      expect(left.trim(), `process group ${pgid} left running`).toBe("");
    }
  });

  const fakeOp = (script: string) => {
    const path = join(bin, "op");
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
  };
  const provider = () =>
    opProvider({ run, env: { HOME: join(dir, "home"), PATH: `${bin}:/usr/bin:/bin`, FAKE_DIR: dir } });
  const ref = "op://Private/plainport nas/password";

  const watched = async (canary: Canary, call: () => Promise<Result<string>>): Promise<Result<string>> => {
    const errors: unknown[] = [];
    const own = await recordOwnOutput(() =>
      call().catch((error: unknown) => {
        errors.push(error);
        return undefined;
      }),
    );
    expect(errors).toEqual([]);
    const result = own.value as Result<string>;
    expectNoCanary([canary], {
      stdout: own.stdout,
      stderr: own.stderr,
      findings: result.ok ? [] : [result.finding],
      argv: recorded.argv,
    });
    return result;
  };

  test("found: op read --no-newline <ref> prints the value", async () => {
    const canary = makeCanary("op");
    writeFileSync(join(dir, "value"), canary.value);
    // The fake checks it was asked the right question, then prints the value from the file it was planted in.
    fakeOp(`[ "$1 $2 $3" = "read --no-newline ${ref}" ] || exit 9\ncat "${join(dir, "value")}"`);
    expect(await watched(canary, () => provider().get(ref))).toEqual({ ok: true, value: canary.value });
    expect(recorded.argv).toEqual([["op", "read", "--no-newline", ref]]);
  });

  test("signed out: store.secret-missing saying so, stderr never quoted", async () => {
    const canary = makeCanary("op");
    writeFileSync(join(dir, "value"), canary.value);
    fakeOp(
      `echo "[ERROR] 2026/10/29 12:00:00 You are not currently signed in. $(cat "${join(dir, "value")}")" >&2\nexit 1`,
    );
    const got = await watched(canary, () => provider().get(ref));
    expect(got.ok ? "" : got.finding.code).toBe("store.secret-missing");
    expect(got.ok ? "" : got.finding.message).toContain("signed out");
  });

  test("hanging (a sign-in it waits for): store.secret-missing at the deadline, its whole group stopped", async () => {
    const canary = makeCanary("op");
    writeFileSync(join(dir, "value"), canary.value);
    fakeOp(`cut -c1-20 "${join(dir, "value")}"\nsleep 60 &\nwait`);
    const got = await watched(canary, () => provider().get(ref, { deadlineMs: 500 }));
    expect(got.ok ? "" : got.finding.code).toBe("store.secret-missing");
    expect(got.ok ? "" : got.finding.message).toContain("did not answer within 0.5 seconds");
  }, 20_000);

  test("no op on PATH: store.secret-missing saying how to install it", async () => {
    const canary = makeCanary("op");
    const got = await watched(canary, () => provider().get(ref));
    expect(got.ok ? "" : got.finding.message).toContain("not installed");
  });
});
