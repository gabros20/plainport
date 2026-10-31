// M2 Task 20: the engine's catalogKey through the real runner, with scripted restic children (T0). `restic cat
// masterkey` runs sensitive and lock-free; only the key derived from its JSON (Catalog seal v1) comes back. The canary
// rides every path: a planted master key (each of its components, in every spelling) is never in a finding, an event,
// a thrown error, plainport's own output or an argv, whether the run succeeds, fails, or prints the key on stderr.

import { describe, expect, test } from "bun:test";
import type { PlainportEvent, Result } from "@plainport/contract";
import { deriveSealKey, keyId, masterKeyMaterial, type SpawnRequest } from "@plainport/core";
import {
  type Canary,
  expectNoCanary,
  makeCanary,
  makeMasterKeyCanary,
  recordOwnOutput,
} from "../../core/src/testing/canary.ts";
import { type Answer, scriptedRun } from "../../secrets/src/testing.ts";
import { resticEngine } from "./engine.ts";
import { fixture } from "./testing.ts";

const STORE = "01K6ZB7Q3M8XWJ5N2T4R6Y8VCD";
const VERSION = fixture("version").stdout;

const code = (result: Result<unknown>) => (result.ok ? "ok" : result.finding.code);

/** catalogKey against a scripted restic: `version` answers as recorded, `cat masterkey` as `answer` says. */
const derive = async (
  canaries: readonly Canary[],
  answer: (request: SpawnRequest) => Answer,
  options: { remote?: boolean; unreachableAfterMs?: number } = {},
) => {
  const password = makeCanary("password");
  const scripted = scriptedRun((request) =>
    request.args.includes("version") ? { stdout: VERSION } : answer(request),
  );
  const engine = resticEngine({
    host: { run: scripted.run },
    restic: "/opt/plainport/restic",
    repository: "/Volumes/Archive/plainport/repos/x",
    password: password.value,
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp/home" },
    retryLock: null,
    ...options,
  });
  const events: PlainportEvent[] = [];
  const errors: unknown[] = [];
  const own = await recordOwnOutput(() =>
    engine.catalogKey(STORE, { op: "op-1", emit: (event) => events.push(event) }).catch((error: unknown) => {
      errors.push(error);
      return undefined;
    }),
  );
  expect(errors).toEqual([]);
  const result = own.value as Result<{ key: Uint8Array; kid: string }>;
  expect(events).toEqual([]);
  expectNoCanary([...canaries, password], {
    stdout: own.stdout,
    stderr: own.stderr,
    findings: result.ok ? [] : [result.finding],
    argv: scripted.requests.map((r) => [r.command, ...r.args]),
    // What the caller gets back is the derived key and its id, never the master key.
    returned: result.ok ? [Buffer.from(result.value.key).toString("hex"), result.value.kid] : [],
  });
  return { result, requests: scripted.requests, password: password.value };
};

describe("restic engine: catalogKey (Catalog seal v1)", () => {
  test("cat masterkey, sensitive and lock-free; the key derived for the store id, and nothing of the master key", async () => {
    const master = makeMasterKeyCanary();
    const { result, requests, password } = await derive([master], () => ({ stdout: `${master.value}\n` }));
    const material = masterKeyMaterial(master.value);
    if (!material.ok) throw new Error(material.finding.message);
    const expected = deriveSealKey(material.value, STORE);
    if (!expected.ok) throw new Error(expected.finding.message);
    expect(result).toEqual({ ok: true, value: { key: expected.value, kid: keyId(expected.value) } });
    const cat = requests.find((r) => r.args.includes("masterkey"));
    expect(cat?.args).toEqual([
      "--repo",
      "/Volumes/Archive/plainport/repos/x",
      "--no-lock",
      "cat",
      "masterkey",
    ]);
    expect(cat?.env.RESTIC_PASSWORD).toBe(password);
  });

  test("another store id gives another key from the same master key", async () => {
    const master = makeMasterKeyCanary();
    const { result } = await derive([master], () => ({ stdout: master.value }));
    const material = masterKeyMaterial(master.value);
    if (!material.ok || !result.ok) throw new Error("no key");
    const other = deriveSealKey(material.value, "01K6ZB7Q3M8XWJ5N2T4R6Y8VCE");
    expect(other.ok && Buffer.from(other.value).equals(Buffer.from(result.value.key))).toBe(false);
  });

  const failures: [string, Answer, string][] = [
    [
      "a wrong password (exit 12)",
      { stderr: "Fatal: wrong password or no key found\n", exit: 12 },
      "restic.wrong-password",
    ],
    [
      "no repository (exit 10)",
      { stderr: "Fatal: repository does not exist\n", exit: 10 },
      "restic.repo-missing",
    ],
    ["a failure that prints the key on stderr", { stderr: "", exit: 1 }, "restic.failed"],
    [
      "a key of another shape",
      { stdout: '{"encrypt":"AAAA","mac":{"k":"AA==","r":"AA=="}}' },
      "restic.output-invalid",
    ],
    ["not JSON", { stdout: "{encrypt: " }, "restic.output-invalid"],
  ];
  for (const [name, answer, expected] of failures) {
    test(`${name}: ${expected}, quoting nothing restic printed`, async () => {
      const master = makeMasterKeyCanary();
      const { result } = await derive([master], () => ({
        ...answer,
        // The master key, printed where it could leak: stderr and, on a failure, stdout too.
        stderr: `${answer.stderr ?? ""}${master.value}\n`,
        ...(answer.exit !== undefined && answer.exit !== 0 ? { stdout: master.value } : {}),
      }));
      expect(code(result)).toBe(expected);
    });
  }

  test("a remote repository that cannot be reached is store.unreachable, from stderr it never decodes", async () => {
    const master = makeMasterKeyCanary();
    const { result } = await derive(
      [master],
      () => ({ stderr: `${master.value} dial tcp 127.0.0.1:9000: connect: connection refused\n`, exit: 1 }),
      { remote: true },
    );
    expect(code(result)).toBe("store.unreachable");
  });

  for (const [name, stderr] of [
    [
      "a cut SFTP link mid-read",
      "subprocess ssh: Connection to 127.0.0.1 closed by remote host.\nLoad(<key/ce7be18577>, 0, 0) returned error, retrying after 1s: connection lost\n",
    ],
    [
      "an SFTP link cut before the session",
      "subprocess ssh: Connection closed by 127.0.0.1 port 39323\nunable to start the sftp session\n",
    ],
  ] as const)
    test(`${name} is store.unreachable, not the seal key (review phase 5 r2 M4)`, async () => {
      const master = makeMasterKeyCanary();
      const { result } = await derive([master], () => ({ stderr, exit: 1 }), { remote: true });
      expect(code(result)).toBe("store.unreachable");
    });

  test("a refused host key is not an unreachable store", async () => {
    const master = makeMasterKeyCanary();
    const { result } = await derive(
      [master],
      () => ({ stderr: "Host key verification failed.\nssh: connect to host nas port 22\n", exit: 1 }),
      { remote: true },
    );
    expect(code(result)).toBe("restic.failed");
  });

  test("a remote read that never ends is stopped at the bound, as store.unreachable", async () => {
    const master = makeMasterKeyCanary();
    const { result } = await derive([master], () => ({ stderr: master.value, exit: "hang" }), {
      remote: true,
      unreachableAfterMs: 200,
    });
    expect(code(result)).toBe("store.unreachable");
  });
});
