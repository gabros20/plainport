// M2 Task 18: restic at a store's repository location (location.ts), and the engine's remote behaviour: credentials in
// the child's environment only and cut out of every message (with the canary), extended options, a missing remote
// repository as store.not-set-up, a connection that cannot be made as store.unreachable, and the probe without a lock.

import { describe, expect, test } from "bun:test";
import type { PlainportEvent, Result } from "@plainport/contract";
import { expectNoCanary, makeCanary } from "../../core/src/testing/canary.ts";
import { resticEngine } from "./engine.ts";
import { resticTarget, s3Environment, sshCommand, storeRootUrl } from "./location.ts";
import { edited, type Fixture, fixture, replayHost } from "./testing.ts";

const REPO = "repos/01K6ZB7Q3M8XWJ5N2T4R6Y8VCD";

const failure = <T>(result: Result<T>) => {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
  return result;
};

describe("repository locations (golden)", () => {
  test("local: the repository's folder under the store's root", () => {
    expect(resticTarget({ kind: "local", root: "/Volumes/Archive/plainport" }, REPO)).toEqual({
      repository: `/Volumes/Archive/plainport/${REPO}`,
      extended: [],
    });
    expect(resticTarget({ kind: "local", root: "/Volumes/Archive/plainport" }, "repo").repository).toBe(
      "/Volumes/Archive/plainport/repo",
    );
  });

  test("sftp: sftp:<host>:<path>/<repo>, through the system's ssh with BatchMode and strict host keys", () => {
    expect(resticTarget({ kind: "sftp", host: "nas", path: "/volume1/plainport" }, REPO)).toEqual({
      repository: `sftp:nas:/volume1/plainport/${REPO}`,
      extended: ["sftp.command=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes nas -s sftp"],
    });
    // A trailing slash in config changes nothing; a path relative to the login folder stays relative.
    expect(resticTarget({ kind: "sftp", host: "nas", path: "/volume1/plainport/" }, REPO).repository).toBe(
      `sftp:nas:/volume1/plainport/${REPO}`,
    );
    expect(resticTarget({ kind: "sftp", host: "nas", path: "plainport" }, REPO).repository).toBe(
      `sftp:nas:plainport/${REPO}`,
    );
    expect(storeRootUrl({ kind: "sftp", host: "nas", path: "/" })).toBe("sftp:nas:/");
    expect(sshCommand("nas")).toBe("ssh -o BatchMode=yes -o StrictHostKeyChecking=yes nas");
  });

  test("s3: s3:<endpoint>/<bucket>[/<path>]/<repo>, with s3.region only when config sets one", () => {
    expect(
      resticTarget(
        {
          kind: "s3",
          endpoint: "https://s3.eu-central-003.backblazeb2.com/",
          bucket: "plainport",
          path: "macs/hub",
          region: "eu-central-003",
        },
        REPO,
      ),
    ).toEqual({
      repository: `s3:https://s3.eu-central-003.backblazeb2.com/plainport/macs/hub/${REPO}`,
      extended: ["s3.region=eu-central-003"],
    });
    expect(resticTarget({ kind: "s3", endpoint: "http://127.0.0.1:9000", bucket: "b" }, "repo")).toEqual({
      repository: "s3:http://127.0.0.1:9000/b/repo",
      extended: [],
    });
  });

  test("the S3 key pair is restic's AWS_ environment, and nothing else (no session token, Q7)", () => {
    expect(s3Environment({ accessKeyId: "AKID", secretAccessKey: "SECRET" })).toEqual({
      AWS_ACCESS_KEY_ID: "AKID",
      AWS_SECRET_ACCESS_KEY: "SECRET",
    });
  });
});

const S3 = resticTarget({ kind: "s3", endpoint: "http://127.0.0.1:9000", bucket: "b", region: "r1" }, REPO);

type Secrets = { password: string; keyId: string; secretKey: string };

const remoteSetup = (
  queue: Fixture[] | ((secrets: Secrets) => Fixture[]),
  options: { now?: () => number; unreachableAfterMs?: number } = {},
) => {
  const password = makeCanary("password");
  const keyId = makeCanary("keyid");
  const secretKey = makeCanary("secretkey");
  const secrets = { password: password.value, keyId: keyId.value, secretKey: secretKey.value };
  const host = replayHost([fixture("version"), ...(typeof queue === "function" ? queue(secrets) : queue)]);
  const engine = resticEngine({
    host,
    restic: "/opt/plainport/restic",
    repository: S3.repository,
    extended: S3.extended,
    password: password.value,
    secretEnv: s3Environment({ accessKeyId: keyId.value, secretAccessKey: secretKey.value }),
    remote: true,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/home",
      AWS_PROFILE: "inherited",
      AWS_SESSION_TOKEN: "inherited-token",
      AWS_ACCESS_KEY_ID: "inherited-id",
    },
    retryLock: null,
    ...options,
  });
  const events: PlainportEvent[] = [];
  return {
    host,
    engine,
    events,
    ctx: { op: "op-1", emit: (event: PlainportEvent) => events.push(event) },
    canaries: [password, keyId, secretKey],
    secrets,
  };
};

describe("restic engine: a remote repository", () => {
  test("the key pair is in the child's environment only, the location and options in argv, no inherited AWS_ variable", async () => {
    const { host, engine, canaries, secrets } = remoteSetup([fixture("snapshots")]);
    expect((await engine.list({}, { op: "op-1" })).ok).toBe(true);
    const call = host.calls[1];
    expect(call?.args?.slice(0, 4)).toEqual(["--repo", S3.repository, "-o", "s3.region=r1"]);
    expect(call?.env).toMatchObject({
      AWS_ACCESS_KEY_ID: secrets.keyId,
      AWS_SECRET_ACCESS_KEY: secrets.secretKey,
      RESTIC_PASSWORD: secrets.password,
    });
    expect(call?.env.AWS_PROFILE).toBeUndefined();
    expect(call?.env.AWS_SESSION_TOKEN).toBeUndefined();
    // `restic version` reaches no repository: no secret at all.
    expect(host.calls[0]?.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expectNoCanary(canaries, { argv: host.calls.map((c) => [c.command, ...(c.args ?? [])]) });
  });

  test("whatever restic says of the key pair or the password is cut out of findings and log lines", async () => {
    const leaky = remoteSetup((secrets) => {
      const said = `request with key ${secrets.keyId} and secret ${secrets.secretKey} (password ${secrets.password}) failed`;
      return [
        edited(fixture("snapshots"), {
          exitCode: 1,
          stdout: "",
          stderr: `${said}\n${JSON.stringify({ message_type: "exit_error", code: 1, message: `Fatal: ${said}` })}\n`,
        }),
      ];
    });
    const result = failure(await leaky.engine.list({}, leaky.ctx));
    expect(result.finding.message).toContain("[redacted]");
    expect(leaky.events.length).toBeGreaterThan(0);
    expectNoCanary(leaky.canaries, { findings: [result.finding], events: leaky.events });
  });

  test("a missing remote repository is store.not-set-up (exit 6), a local one restic.repo-missing", async () => {
    const missing = edited(fixture("snapshots"), {
      exitCode: 10,
      stdout: "",
      stderr: `${JSON.stringify({ message_type: "exit_error", code: 10, message: "Fatal: repository does not exist: unable to open config file: Stat: The specified key does not exist." })}\n`,
    });
    const { engine } = remoteSetup([missing]);
    const result = failure(await engine.list({}));
    expect(result.finding.code).toBe("store.not-set-up");
    expect(result.exitCode).toBe(6);

    const local = resticEngine({
      host: replayHost([fixture("version"), missing]),
      restic: "/r",
      repository: "/Volumes/A/repo",
      password: "p",
      env: {},
      retryLock: null,
    });
    expect(failure(await local.list({})).finding.code).toBe("restic.repo-missing");
  });

  test("a connection that cannot be made is store.unreachable (exit 9); a refused host key is not", async () => {
    const refused = edited(fixture("snapshots"), {
      exitCode: 1,
      stdout: "",
      stderr: [
        "subprocess ssh: ssh: connect to host 127.0.0.1 port 1: Connection refused",
        JSON.stringify({
          message_type: "exit_error",
          code: 1,
          message:
            "Fatal: unable to open repository at sftp:nas:/x: unable to start the sftp session, error: error receiving version packet from server: server unexpectedly closed connection: unexpected EOF",
        }),
        "",
      ].join("\n"),
    });
    const { engine } = remoteSetup([refused]);
    const result = failure(await engine.list({}));
    expect(result.finding.code).toBe("store.unreachable");
    expect(result.exitCode).toBe(9);

    const hostKey = edited(refused, {
      stderr: refused.stderr.replace(
        "ssh: connect to host 127.0.0.1 port 1: Connection refused",
        "Host key verification failed.",
      ),
    });
    const other = remoteSetup([hostKey]);
    expect(failure(await other.engine.list({})).finding.code).toBe("restic.failed");
  });

  test("restic retrying a refused connection is stopped once the retries outlast the budget: store.unreachable", async () => {
    let now = 0;
    const retry = (after: string) =>
      `Stat(<config/>) returned error, retrying after ${after}: Stat: Get "http://127.0.0.1:9/b/?location=": dial tcp 127.0.0.1:9: connect: connection refused`;
    const retrying = edited(fixture("snapshots"), {
      exitCode: 130,
      stdout: "",
      stderr: `${[retry("600ms"), retry("2s"), retry("3s")].join("\n")}\n`,
    });
    const { host, engine } = remoteSetup([retrying], {
      unreachableAfterMs: 5_000,
      now: () => {
        now += 3_000;
        return now;
      },
    });
    const result = failure(await engine.list({}));
    expect(result.finding.code).toBe("store.unreachable");
    expect(result.finding.message).toContain("retries");
    // The run itself was told to stop: the runner ends its process group.
    expect(host.calls[1]?.signal?.aborted).toBe(true);
  });

  test("retries within the budget are restic's own business: the run goes on", async () => {
    const retrying = edited(fixture("snapshots"), {
      stderr: `Load(<lock/x>) returned error, retrying after 600ms: dial tcp 127.0.0.1:9: connect: connection refused\n${fixture("snapshots").stderr}`,
    });
    const { host, engine } = remoteSetup([retrying], { unreachableAfterMs: 60_000, now: () => 0 });
    expect((await engine.list({})).ok).toBe(true);
    expect(host.calls[1]?.signal?.aborted).toBe(false);
  });

  test("the adoption probe lists without a lock (--no-lock)", async () => {
    const { host, engine } = remoteSetup([fixture("snapshots")]);
    expect((await engine.list({ tags: ["plainport"], noLock: true })).ok).toBe(true);
    expect(host.calls[1]?.args).toContain("--no-lock");
  });
});
