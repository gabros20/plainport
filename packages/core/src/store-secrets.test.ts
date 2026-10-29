// Store secrets (Task 15, Q7, Q14, ADR-0013): a reference resolves through its provider, `env:` and `file:` in core and
// `keychain:` and `op:` through the injected providers, bounded by Q14's deadline and stoppable by a signal. Every path
// runs the canary: the value shows up in the ok result only, never in a finding, a thrown error or plainport's output.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";
import { type ResolvedConfig, type Store, StoreSchema } from "./config/schema.ts";
import type { Scheduler } from "./deadline.ts";
import type { LocalIo } from "./io.ts";
import { parseSecretRef, type SecretContext, type SecretProvider } from "./ports/secrets.ts";
import { resolveS3Credentials, resolveSecret, secretVariables } from "./store.ts";
import { type Canary, expectNoCanary, makeCanary, recordOwnOutput } from "./testing/canary.ts";
import { testHost } from "./testing/host.ts";
import { makeSandbox, type Sandbox } from "./testing/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = makeSandbox("plainport-secrets-");
});
afterEach(() => box.cleanup());

/** A scheduler whose timers fire at once: every deadline passes before a call that never answers. */
const expired: Scheduler = {
  setTimer: (fire) => setTimeout(fire, 0),
  clearTimer: (h) => clearTimeout(h as never),
};
const never = <T>(): Promise<T> => new Promise<T>(() => {});

/** Resolves `ref` for store `ssd` with the canary watching: plainport's own output, the finding, any thrown error. */
const watched = async (canary: Canary, run: () => Promise<Result<string>>): Promise<Result<string>> => {
  const errors: unknown[] = [];
  const own = await recordOwnOutput(() =>
    run().catch((error: unknown) => {
      errors.push(error);
      return undefined;
    }),
  );
  const result = own.value;
  expect(errors).toEqual([]);
  if (result === undefined) throw new Error("unreachable");
  expectNoCanary([canary], {
    stdout: own.stdout,
    stderr: own.stderr,
    findings: result.ok ? [] : [result.finding],
  });
  return result;
};

const resolve = (ref: string | undefined, env: Record<string, string> = {}, options = {}) =>
  resolveSecret(testHost(), env, box.home, "ssd", ref, options);

const missing = (result: Result<string>): string => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.finding.code).toBe("store.secret-missing");
  return `${result.finding.message} | ${result.finding.fix}`;
};

describe("parseSecretRef", () => {
  test("takes each provider's reference apart", () => {
    expect(parseSecretRef("env:PLAINPORT_STORE_PASSWORD")).toEqual({
      scheme: "env",
      name: "PLAINPORT_STORE_PASSWORD",
    });
    expect(parseSecretRef("file:~/.config/pw")).toEqual({ scheme: "file", path: "~/.config/pw" });
    expect(parseSecretRef("keychain:plainport/nas")).toEqual({
      scheme: "keychain",
      service: "plainport",
      account: "nas",
    });
    expect(parseSecretRef("keychain:plainport/b2/key id")).toEqual({
      scheme: "keychain",
      service: "plainport",
      account: "b2/key id",
    });
    expect(parseSecretRef("op://Private/plainport b2/password")).toEqual({
      scheme: "op",
      reference: "op://Private/plainport b2/password",
    });
    expect(parseSecretRef("op://Private/item/section/field?attribute=otp")).toEqual({
      scheme: "op",
      reference: "op://Private/item/section/field?attribute=otp",
    });
  });

  test("garbled references are undefined", () => {
    for (const ref of [
      "env:",
      "env:1BAD",
      "env:A-B",
      "file:",
      "keychain:plainport",
      "keychain:/nas",
      "keychain:plainport/",
      "keychain:plain\nport/nas",
      "op:Private/item/field",
      "op://Private/item",
      "op://Private//field",
      "op://a/b/c/d/e",
      "op://Private/item/field\nquit",
      "vault:x",
      "plain",
    ])
      expect(parseSecretRef(ref), ref).toBeUndefined();
  });
});

describe("resolveSecret: env:", () => {
  test("found, and only in the ok value", async () => {
    const canary = makeCanary("env");
    const got = await watched(canary, () => resolve("env:MY_PW", { MY_PW: canary.value }));
    expect(got).toEqual({ ok: true, value: canary.value });
  });

  test("missing and empty are store.secret-missing naming the variable, never a value", async () => {
    const canary = makeCanary("env");
    expect(missing(await watched(canary, () => resolve("env:MY_PW", { OTHER: canary.value })))).toContain(
      "MY_PW is not set",
    );
    expect(missing(await watched(canary, () => resolve("env:MY_PW", { MY_PW: "" })))).toContain("MY_PW");
  });

  test("a garbled reference is store.secret-missing with the reference's form", async () => {
    expect(missing(await resolve("env:1BAD"))).toContain("env:<VARIABLE>");
  });

  test("a config that names no secret is store.secret-missing", async () => {
    expect(missing(await resolve(undefined))).toContain("names no secret");
  });

  test("cancelled before it reads: operation.cancelled, no value", async () => {
    const canary = makeCanary("env");
    const stop = new AbortController();
    stop.abort();
    const got = await watched(canary, () =>
      resolve("env:MY_PW", { MY_PW: canary.value }, { signal: stop.signal }),
    );
    expect(got.ok ? undefined : got.finding.code).toBe("operation.cancelled");
  });
});

describe("resolveSecret: file:", () => {
  test("found, with one trailing newline cut", async () => {
    const canary = makeCanary("file");
    writeFileSync(join(box.home, "pw"), `${canary.value}\n`);
    const got = await watched(canary, () => resolve(`file:${join(box.home, "pw")}`));
    expect(got).toEqual({ ok: true, value: canary.value });
  });

  test("~ is the home folder", async () => {
    writeFileSync(join(box.home, "pw"), "secret-in-home");
    expect(await resolve("file:~/pw")).toEqual({ ok: true, value: "secret-in-home" });
  });

  test("missing and empty are store.secret-missing naming the path", async () => {
    expect(missing(await resolve(`file:${join(box.home, "nope")}`))).toContain("ENOENT");
    writeFileSync(join(box.home, "empty"), "\n");
    expect(missing(await resolve(`file:${join(box.home, "empty")}`))).toContain("is empty");
  });

  test("a read that never answers (a hung mount) is store.secret-missing at the deadline", async () => {
    const io = testHost();
    const hung: LocalIo = { ...io, fs: { ...io.fs, readText: () => never<string>() } };
    const got = await resolveSecret(hung, {}, box.home, "ssd", "file:/Volumes/hung/pw", {
      scheduler: expired,
      deadlineMs: 1000,
    });
    expect(missing(got)).toContain("did not answer within 1 seconds");
  });

  test("cancelled while it reads: operation.cancelled", async () => {
    const io = testHost();
    const hung: LocalIo = { ...io, fs: { ...io.fs, readText: () => never<string>() } };
    const stop = new AbortController();
    const pending = resolveSecret(hung, {}, box.home, "ssd", "file:/Volumes/hung/pw", {
      signal: stop.signal,
    });
    stop.abort();
    const got = await pending;
    expect(got.ok ? undefined : got.finding.code).toBe("operation.cancelled");
  });
});

describe("resolveSecret: keychain: and op: through their providers", () => {
  const provider = (answer: (ref: string, ctx?: SecretContext) => Promise<Result<string>>) => {
    const calls: { ref: string; ctx?: SecretContext }[] = [];
    const p: SecretProvider = {
      get: (ref, ctx) => {
        calls.push({ ref, ...(ctx === undefined ? {} : { ctx }) });
        return answer(ref, ctx);
      },
    };
    return { p, calls };
  };

  test("the provider gets the whole reference, the signal and Q14's deadline; its value comes back", async () => {
    const canary = makeCanary("keychain");
    const { p, calls } = provider(async () => ok(canary.value));
    const stop = new AbortController();
    const got = await watched(canary, () =>
      resolve("keychain:plainport/ssd", {}, { providers: { keychain: p }, signal: stop.signal }),
    );
    expect(got).toEqual({ ok: true, value: canary.value });
    expect(calls).toEqual([
      { ref: "keychain:plainport/ssd", ctx: { signal: stop.signal, deadlineMs: 30_000 } },
    ]);
  });

  test("the provider's store.secret-missing names the store and what it was for", async () => {
    const { p } = provider(async () =>
      fail(finding("store.secret-missing", { message: "the Keychain has no item", fix: "add it" })),
    );
    const got = await resolve("op://Private/ssd/password", {}, { providers: { op: p } });
    expect(missing(got)).toBe("store ssd's password: the Keychain has no item | add it");
  });

  test("a provider that never answers is store.secret-missing at the deadline", async () => {
    const { p } = provider(() => never());
    const got = await resolve("op://Private/ssd/password", {}, { providers: { op: p }, scheduler: expired });
    expect(missing(got)).toContain("did not answer within 30 seconds");
  });

  test("a garbled keychain: or op: reference never reaches the provider", async () => {
    const { p, calls } = provider(async () => ok("x"));
    expect(missing(await resolve("keychain:nas", {}, { providers: { keychain: p } }))).toContain(
      "keychain:<service>/<account>",
    );
    expect(missing(await resolve("op:Private/nas", {}, { providers: { op: p } }))).toContain(
      "op://<vault>/<item>/<field>",
    );
    expect(calls).toEqual([]);
  });

  test("a build without the provider says so", async () => {
    expect(missing(await resolve("keychain:plainport/ssd"))).toContain("keychain:");
  });

  test("se: and bw: are refused, naming their milestone", async () => {
    expect(missing(await resolve("se:device"))).toContain("M3");
    expect(missing(await resolve("bw:plainport-nas"))).toContain("not in this build");
  });
});

describe("S3 credentials (Q7)", () => {
  const s3 = {
    kind: "s3",
    endpoint: "https://s3.example.com",
    bucket: "b",
    secret: "env:S3_PW",
    accessKeyId: "env:S3_KEY",
    secretAccessKey: "env:S3_SECRET",
  };

  test("an s3 store requires the restic password and both key references; region and path are optional", () => {
    expect(StoreSchema.safeParse(s3).success).toBe(true);
    expect(StoreSchema.safeParse({ ...s3, region: "eu-central-003", path: "plainport/one" }).success).toBe(
      true,
    );
    for (const key of ["secret", "accessKeyId", "secretAccessKey"]) {
      const { [key as keyof typeof s3]: _, ...without } = s3;
      expect(StoreSchema.safeParse(without).success, key).toBe(false);
    }
    expect(StoreSchema.safeParse({ ...s3, accessKeyId: "AKIAEXAMPLE" }).success).toBe(false);
    for (const path of ["/plainport", "plainport/", ""])
      expect(StoreSchema.safeParse({ ...s3, path }).success, path).toBe(false);
  });

  test("temporary session credentials are not supported: no sessionToken key", () => {
    expect(StoreSchema.safeParse({ ...s3, sessionToken: "env:AWS_SESSION_TOKEN" }).success).toBe(false);
  });

  test("the key pair resolves through the providers; AWS_SESSION_TOKEN is never read", async () => {
    const store = StoreSchema.parse(s3) as Extract<Store, { kind: "s3" }>;
    const env = new Proxy(
      { S3_KEY: "AKIA-key", S3_SECRET: "the-secret", AWS_SESSION_TOKEN: "session" } as Record<string, string>,
      {
        get: (target, name) => {
          if (name === "AWS_SESSION_TOKEN") throw new Error("AWS_SESSION_TOKEN was read");
          return target[name as string];
        },
      },
    );
    const got = await resolveS3Credentials(testHost(), env, box.home, "b2", store);
    expect(got).toEqual({ ok: true, value: { accessKeyId: "AKIA-key", secretAccessKey: "the-secret" } });
  });

  test("a missing half of the key pair is store.secret-missing naming which", async () => {
    const store = StoreSchema.parse(s3) as Extract<Store, { kind: "s3" }>;
    const got = await resolveS3Credentials(testHost(), { S3_KEY: "k" }, box.home, "b2", store);
    expect(got.ok ? "" : got.finding.message).toContain("store b2's secret access key");
  });

  test("secretVariables names every env: reference: passwords, the S3 key pair, recovery and the prune key", () => {
    const config = {
      stores: { b2: StoreSchema.parse(s3), ssd: { kind: "local", path: "/x" } },
      secrets: { recovery: "env:RECOVERY" },
      deletion: { delay: "7d", pruneKey: "env:PRUNE" },
    } as unknown as ResolvedConfig;
    expect(secretVariables(config)).toEqual([
      "PLAINPORT_STORE_PASSWORD",
      "PRUNE",
      "RECOVERY",
      "S3_KEY",
      "S3_PW",
      "S3_SECRET",
    ]);
  });
});
