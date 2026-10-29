// The keychain: and op: providers against scripted children through the real runner (T0): found, missing, empty, a
// garbled reference, denied or signed out, a child that hangs past the deadline, cancellation, and a program that is
// not there. The canary rides every path: the planted value is in the ok result only, never in a finding, a thrown
// error, plainport's own output, an argv or an environment variable a child was given.

import { describe, expect, test } from "bun:test";
import type { Result } from "@plainport/contract";
import type { SecretProvider, SpawnRequest } from "@plainport/core";
import { type Canary, expectNoCanary, makeCanary, recordOwnOutput } from "../../core/src/testing/canary.ts";
import { keychainProvider, SECURITY } from "./keychain.ts";
import { opProvider } from "./op.ts";
import { type Answer, scriptedRun } from "./testing.ts";

const USER_ENV = {
  HOME: "/Users/someone",
  USER: "someone",
  PATH: "/opt/homebrew/bin:/usr/bin:/bin",
  OP_SERVICE_ACCOUNT_TOKEN: "ops_token",
  OP_ACCOUNT: "my.1password.com",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  RESTIC_PASSWORD: "restic-pw",
  PLAINPORT_STORE_PASSWORD: "store-pw",
};

/** One provider call with the canary watching every place it could leak to. */
const call = async (
  canary: Canary,
  answer: Answer | ((request: SpawnRequest) => Answer),
  make: (run: ReturnType<typeof scriptedRun>["run"]) => SecretProvider,
  invoke: (provider: SecretProvider) => Promise<Result<unknown>>,
) => {
  const scripted = scriptedRun(typeof answer === "function" ? answer : () => answer);
  const errors: unknown[] = [];
  const own = await recordOwnOutput(() =>
    invoke(make(scripted.run)).catch((error: unknown) => {
      errors.push(error);
      return undefined;
    }),
  );
  expect(errors).toEqual([]);
  const result = own.value as Result<unknown>;
  expectNoCanary([canary], {
    stdout: own.stdout,
    stderr: own.stderr,
    findings: result.ok ? [] : [result.finding],
    argv: scripted.requests.map((r) => [r.command, ...r.args]),
    output: scripted.requests.map((r) => JSON.stringify(r.env)),
  });
  return { result, requests: scripted.requests };
};

const code = (result: Result<unknown>) => (result.ok ? "ok" : result.finding.code);
const said = (result: Result<unknown>) =>
  result.ok ? "" : `${result.finding.message} | ${result.finding.fix}`;

describe("keychain: provider", () => {
  const keychain = (run: ReturnType<typeof scriptedRun>["run"]) => keychainProvider({ run, env: USER_ENV });
  const get = (ref: string, ctx?: Parameters<SecretProvider["get"]>[1]) => (p: SecretProvider) =>
    p.get(ref, ctx);

  test("found: find-generic-password -s -a -w, sensitive, within Q14's deadline; one trailing newline cut", async () => {
    const canary = makeCanary("keychain");
    const { result, requests } = await call(
      canary,
      { stdout: `${canary.value}\n` },
      keychain,
      get("keychain:plainport/nas"),
    );
    expect(result).toEqual({ ok: true, value: canary.value });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.command).toBe(SECURITY);
    expect(request?.args).toEqual(["find-generic-password", "-s", "plainport", "-a", "nas", "-w"]);
    // The child gets the user's home and locale, not the user's secrets.
    expect(request?.env).toEqual({ HOME: "/Users/someone", USER: "someone" });
  });

  test("missing (exit 44) is store.secret-missing whose fix is the interactive add-generic-password", async () => {
    const canary = makeCanary("keychain");
    const { result } = await call(
      canary,
      { stderr: `security: The specified item could not be found ${canary.value}`, exit: 44 },
      keychain,
      get("keychain:plain port/it's"),
    );
    expect(code(result)).toBe("store.secret-missing");
    expect(said(result)).toContain(`security add-generic-password -s 'plain port' -a 'it'\\''s' -w`);
  });

  test("empty is store.secret-missing", async () => {
    const canary = makeCanary("keychain");
    const { result } = await call(canary, { stdout: "\n" }, keychain, get("keychain:plainport/nas"));
    expect(said(result)).toContain("is empty");
  });

  test("denied or locked (exit 128, 51, 36) is store.secret-missing saying so", async () => {
    for (const exit of [128, 51, 36]) {
      const canary = makeCanary("keychain");
      const { result } = await call(
        canary,
        { stdout: canary.value, exit },
        keychain,
        get("keychain:plainport/nas"),
      );
      expect(code(result)).toBe("store.secret-missing");
      expect(said(result)).toContain("refused");
    }
  });

  test("any other failure names the exit, never the output", async () => {
    const canary = makeCanary("keychain");
    const { result } = await call(
      canary,
      { stdout: canary.value, stderr: canary.value, exit: 3 },
      keychain,
      get("keychain:plainport/nas"),
    );
    expect(said(result)).toContain("exit 3");
  });

  test("a garbled reference runs nothing", async () => {
    const canary = makeCanary("keychain");
    const { result, requests } = await call(canary, {}, keychain, get("keychain:plainport"));
    expect(code(result)).toBe("store.secret-missing");
    expect(said(result)).toContain("keychain:<service>/<account>");
    expect(requests).toEqual([]);
  });

  test("an unanswered prompt (a child that hangs) is store.secret-missing at the deadline", async () => {
    const canary = makeCanary("keychain");
    const { result } = await call(
      canary,
      { stdout: canary.value.slice(0, 20), exit: "hang" },
      keychain,
      get("keychain:plainport/nas", { deadlineMs: 50 }),
    );
    expect(code(result)).toBe("store.secret-missing");
    expect(said(result)).toContain("did not answer within 0.05 seconds");
  }, 10_000);

  test("cancellation stops the child: process.cancelled", async () => {
    const canary = makeCanary("keychain");
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 20);
    const { result } = await call(
      canary,
      { stdout: canary.value, exit: "hang" },
      keychain,
      get("keychain:plainport/nas", { signal: stop.signal }),
    );
    expect(code(result)).toBe("process.cancelled");
  }, 10_000);

  test("no /usr/bin/security (not macOS) is store.secret-missing", async () => {
    const canary = makeCanary("keychain");
    const { result } = await call(canary, { spawnError: "ENOENT" }, keychain, get("keychain:plainport/nas"));
    expect(said(result)).toContain("macOS only");
  });

  test("set: the command goes on security -i's stdin, the value as -X hex; argv is -i alone", async () => {
    const canary = makeCanary("keychain");
    let line = "";
    const { result, requests } = await call(
      canary,
      (request) => {
        line = new TextDecoder().decode(request.stdin);
        return {};
      },
      keychain,
      (p) => (p.set as NonNullable<SecretProvider["set"]>)('keychain:plain port/b2 "key"', canary.value),
    );
    expect(result).toEqual({ ok: true, value: undefined });
    const [request] = requests;
    expect(request?.args).toEqual(["-i"]);
    expect(line).toBe(
      `"add-generic-password" "-U" "-s" "plain port" "-a" "b2 \\"key\\"" "-X" "${Buffer.from(canary.value).toString("hex")}"\n`,
    );
    // The provider overwrote the stdin it built once the run ended.
    expect(request?.stdin?.every((byte) => byte === 0)).toBe(true);
  });

  test("set refuses a value find-generic-password -w would give back as hex, and a reference that would inject a command", async () => {
    const canary = makeCanary("keychain");
    for (const [ref, value] of [
      ["keychain:plainport/nas", `${canary.value}\nsecond line`],
      ["keychain:plainport/nas", "árvíztűrő"],
      ["keychain:plainport/nas", ""],
      ['keychain:plainport/nas\n"delete-keychain"', canary.value],
    ] as const) {
      const { result, requests } = await call(canary, {}, keychain, (p) =>
        (p.set as NonNullable<SecretProvider["set"]>)(ref, value),
      );
      expect(code(result)).toBe("usage.invalid");
      expect(requests).toEqual([]);
    }
  });

  test("set: a failed write is store.failed naming the exit", async () => {
    const canary = makeCanary("keychain");
    const { result } = await call(canary, { stderr: canary.value, exit: 128 }, keychain, (p) =>
      (p.set as NonNullable<SecretProvider["set"]>)("keychain:plainport/nas", canary.value),
    );
    expect(code(result)).toBe("store.failed");
    expect(said(result)).toContain("exit 128");
  });
});

describe("op: provider", () => {
  const op = (run: ReturnType<typeof scriptedRun>["run"]) => opProvider({ run, env: USER_ENV });
  const ref = "op://Private/plainport nas/password";
  const get = (r: string, ctx?: Parameters<SecretProvider["get"]>[1]) => (p: SecretProvider) => p.get(r, ctx);

  test("found: op read --no-newline <ref>, with the user's PATH and OP_* variables and no other secret", async () => {
    const canary = makeCanary("op");
    const { result, requests } = await call(canary, { stdout: canary.value }, op, get(ref));
    expect(result).toEqual({ ok: true, value: canary.value });
    const [request] = requests;
    expect([request?.command, ...(request?.args ?? [])]).toEqual(["op", "read", "--no-newline", ref]);
    expect(request?.env).toEqual({
      HOME: "/Users/someone",
      USER: "someone",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      OP_SERVICE_ACCOUNT_TOKEN: "ops_token",
      OP_ACCOUNT: "my.1password.com",
    });
  });

  test("signed out, dismissed and not found are told apart from stderr's bytes, never quoted", async () => {
    for (const [stderr, expected] of [
      ["[ERROR] 2026/10/29 You are not currently signed in. Please run `op signin --help`", "signed out"],
      ["[ERROR] authorization prompt dismissed, please try again", "dismissed"],
      ['[ERROR] "plainport nas" isn\'t an item in the "Private" vault', "no vault, item or field"],
      ["[ERROR] something else", "failed (exit 1)"],
    ] as const) {
      const canary = makeCanary("op");
      const { result } = await call(canary, { stderr: `${stderr} ${canary.value}`, exit: 1 }, op, get(ref));
      expect(code(result)).toBe("store.secret-missing");
      expect(said(result)).toContain(expected);
      expect(said(result)).not.toContain("[ERROR]");
    }
  });

  test("empty is store.secret-missing", async () => {
    const canary = makeCanary("op");
    const { result } = await call(canary, { stdout: "" }, op, get(ref));
    expect(said(result)).toContain("is empty");
  });

  test("a garbled reference runs nothing", async () => {
    const canary = makeCanary("op");
    const { result, requests } = await call(canary, {}, op, get("op:Private/nas"));
    expect(said(result)).toContain("op://<vault>/<item>/<field>");
    expect(requests).toEqual([]);
  });

  test("an op that hangs (a sign-in it waits for) is store.secret-missing at the deadline", async () => {
    const canary = makeCanary("op");
    const { result } = await call(
      canary,
      { stdout: canary.value.slice(0, 30), exit: "hang" },
      op,
      get(ref, { deadlineMs: 50 }),
    );
    expect(code(result)).toBe("store.secret-missing");
    expect(said(result)).toContain("did not answer within 0.05 seconds");
  }, 10_000);

  test("cancellation stops op: process.cancelled", async () => {
    const canary = makeCanary("op");
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 20);
    const { result } = await call(
      canary,
      { stdout: canary.value, exit: "hang" },
      op,
      get(ref, { signal: stop.signal }),
    );
    expect(code(result)).toBe("process.cancelled");
  }, 10_000);

  test("no op on PATH is store.secret-missing saying how to install it", async () => {
    const canary = makeCanary("op");
    const { result } = await call(canary, { spawnError: "ENOENT" }, op, get(ref));
    expect(said(result)).toContain("not installed");
  });
});
