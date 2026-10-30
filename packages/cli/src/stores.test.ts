// The binary's store opener carries the secret providers (Task 15): a store whose secret is an op: reference reads it
// through the 1Password CLI on the user's PATH, here a fake one in a sandbox.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SFTP_OPENSSH_PROFILE } from "@plainport/blob-rclone";
import type { Result } from "@plainport/contract";
import {
  type Engine,
  type HostPorts,
  type RunSpec,
  recordMeasured,
  resolvePaths,
  type Store,
  UNKNOWN_SEMANTICS,
} from "@plainport/core";
import { PINNED_RESTIC } from "@plainport/engine-restic";
import { expectNoCanary, makeCanary } from "../../core/src/testing/canary.ts";
import { testHost } from "../../core/src/testing/host.ts";
import { localStores, storeFactsOf, storeOpener } from "./stores.ts";

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

// M2 Task 18: the opener for local, sftp and s3 stores. Both layers address one root (Q7), restic at the repository the
// store publishes; credentials go only in the children's environment (with the canary); the profile is the measured
// one under config's assertions. Nothing runs here: the host records what would run and answers it.

const ID = "01K6ZB7Q3M8XWJ5N2T4R6Y8VCD";
const STORE_JSON = `${JSON.stringify({ v: 2, id: ID, repo: `repos/${ID}`, catalog: { seal: "none" }, format: 2 })}\n`;

/** A host that records every run and answers: restic's version, rclone's cat of store.json, an empty listing. */
const recordingHost = () => {
  const base = testHost();
  const calls: RunSpec[] = [];
  const host: HostPorts = {
    ...base,
    run: async (spec) => {
      calls.push(spec);
      const name = spec.command.split("/").at(-1);
      const args = spec.args ?? [];
      const stdout =
        name === "restic" && args.includes("version")
          ? `${JSON.stringify({ message_type: "version", version: PINNED_RESTIC, go_version: "go1.24", go_os: "darwin", go_arch: "arm64" })}\n`
          : name === "restic"
            ? "[]\n"
            : args.includes("cat")
              ? STORE_JSON
              : "";
      return {
        ok: true,
        value: {
          exitCode: 0,
          signal: null,
          stdout: { text: stdout, droppedBytes: 0 },
          stderr: { text: "", droppedBytes: 0 },
          ...(spec.capture === undefined ? {} : { captured: new TextEncoder().encode(stdout) }),
          leftoversStopped: false,
          durationMs: 1,
        },
      };
    },
  };
  return { host, calls };
};

const toolsDir = () => {
  const tools = join(dir, "tools");
  mkdirSync(tools, { recursive: true });
  for (const tool of ["restic", "rclone"]) {
    writeFileSync(join(tools, tool), "#!/bin/sh\nexit 1\n");
    chmodSync(join(tools, tool), 0o755);
  }
  return tools;
};

const openerEnv = () => ({
  HOME: join(dir, "home"),
  PATH: "/usr/bin:/bin",
  PLAINPORT_TOOLS_DIR: toolsDir(),
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  AWS_SECRET_ACCESS_KEY: "inherited",
});

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

describe("the opener: an sftp store", () => {
  const store: Store = { kind: "sftp", host: "nas", path: "/volume1/plainport", secret: "env:PW" };

  test("restic and rclone reach one root through the system's ssh, and restic the repository store.json names", async () => {
    const password = makeCanary("password");
    const { host, calls } = recordingHost();
    const opened = value(await storeOpener(host, openerEnv()).open("nas", store, password.value));
    expect(opened.location).toBe("sftp:nas:/volume1/plainport");
    expect(value(await opened.engine.list({}))).toEqual([]);

    const rclone = calls.find((c) => c.command.endsWith("/rclone"));
    expect(rclone?.args?.at(-1)).toBe("PLAINPORT:/volume1/plainport/meta/v1");
    expect(rclone?.env).toMatchObject({
      RCLONE_CONFIG_PLAINPORT_TYPE: "sftp",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    });
    // The adapter has ssh log to its own file (-E) after the command it is given.
    expect(rclone?.env.RCLONE_CONFIG_PLAINPORT_SSH).toStartWith(
      "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes nas -E ",
    );
    const restic = calls.filter((c) => c.command.endsWith("/restic")).at(-1);
    expect(restic?.args?.slice(0, 4)).toEqual([
      "--repo",
      `sftp:nas:/volume1/plainport/repos/${ID}`,
      "-o",
      "sftp.command=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes nas -s sftp",
    ]);
    expect(restic?.env.RESTIC_PASSWORD).toBe(password.value);
    expect(restic?.env.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
    expect(restic?.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expectNoCanary([password], { argv: calls.map((c) => [c.command, ...(c.args ?? [])]) });
  });

  test("engineAt reaches any repository under the same root (bootstrap's)", async () => {
    const { host, calls } = recordingHost();
    const opened = value(await storeOpener(host, openerEnv()).open("nas", store, "pw"));
    const engineAt = opened.engineAt as (repo: string) => Engine;
    value(await engineAt(`repos/${ID}`).list({ noLock: true }));
    const restic = calls.at(-1);
    expect(restic?.args?.[1]).toBe(`sftp:nas:/volume1/plainport/repos/${ID}`);
    expect(restic?.args).toContain("--no-lock");
  });

  test("the profile is unknown until measured or asserted; config's assertions are `asserted`", async () => {
    const { host } = recordingHost();
    const bare = value(await storeOpener(host, openerEnv()).open("nas", store, "pw"));
    expect(bare.blob.semantics()).toEqual(UNKNOWN_SEMANTICS);
    const asserted = value(
      await storeOpener(host, openerEnv()).open(
        "nas",
        { ...store, semantics: { durability: "durable", readAfterWrite: true } },
        "pw",
      ),
    );
    expect(asserted.blob.semantics()).toEqual({
      ...UNKNOWN_SEMANTICS,
      durability: { value: "durable", evidence: "asserted" },
      readAfterWrite: { value: true, evidence: "asserted" },
    });
  });

  test("this device's measurement counts while its facts hold, under config's assertions", async () => {
    const env = openerEnv();
    const paths = value(resolvePaths(env));
    const { host } = recordingHost();
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(paths.registryFile, `${JSON.stringify({ v: 1, projects: {}, stores: { nas: ID } })}\n`);
    const facts = storeFactsOf(store, paths.home);
    value(await recordMeasured(host, paths, ID, facts, { semantics: SFTP_OPENSSH_PROFILE }));
    const opened = value(
      await storeOpener(host, env).open("nas", { ...store, semantics: { durability: "durable" } }, "pw"),
    );
    expect(opened.blob.semantics()).toEqual({
      ...SFTP_OPENSSH_PROFILE,
      durability: { value: "durable", evidence: "asserted" },
    });
    // Moved to another host: the measurement no longer holds.
    const moved = value(await storeOpener(host, env).open("nas", { ...store, host: "nas2" }, "pw"));
    expect(moved.blob.semantics()).toEqual(UNKNOWN_SEMANTICS);
  });
});

describe("the opener: an s3 store", () => {
  const store: Store = {
    kind: "s3",
    endpoint: "https://s3.example.eu/",
    bucket: "plainport",
    path: "macs",
    region: "eu-1",
    secret: "env:PW",
    accessKeyId: "env:KEY_ID",
    secretAccessKey: "env:SECRET_KEY",
  };

  test("the key pair reaches restic and rclone in their environment only; both address <bucket>/<path>", async () => {
    const password = makeCanary("password");
    const keyId = makeCanary("keyid");
    const secretKey = makeCanary("secretkey");
    const { host, calls } = recordingHost();
    const opened = value(
      await storeOpener(host, openerEnv()).open("b2", store, password.value, {
        accessKeyId: keyId.value,
        secretAccessKey: secretKey.value,
      }),
    );
    expect(opened.location).toBe("s3:https://s3.example.eu/plainport/macs");
    value(await opened.engine.list({}));
    const rclone = calls.find((c) => c.command.endsWith("/rclone"));
    expect(rclone?.args?.at(-1)).toBe("PLAINPORT:plainport/macs/meta/v1");
    expect(rclone?.env).toMatchObject({
      RCLONE_CONFIG_PLAINPORT_TYPE: "s3",
      RCLONE_CONFIG_PLAINPORT_PROVIDER: "Other",
      RCLONE_CONFIG_PLAINPORT_ENDPOINT: "https://s3.example.eu/",
      RCLONE_CONFIG_PLAINPORT_REGION: "eu-1",
      RCLONE_CONFIG_PLAINPORT_ACCESS_KEY_ID: keyId.value,
      RCLONE_CONFIG_PLAINPORT_SECRET_ACCESS_KEY: secretKey.value,
    });
    const restic = calls.filter((c) => c.command.endsWith("/restic")).at(-1);
    expect(restic?.args?.slice(0, 4)).toEqual([
      "--repo",
      `s3:https://s3.example.eu/plainport/macs/repos/${ID}`,
      "-o",
      "s3.region=eu-1",
    ]);
    expect(restic?.env).toMatchObject({
      AWS_ACCESS_KEY_ID: keyId.value,
      AWS_SECRET_ACCESS_KEY: secretKey.value,
      RESTIC_PASSWORD: password.value,
    });
    expect(restic?.env.AWS_SESSION_TOKEN).toBeUndefined();
    expectNoCanary([password, keyId, secretKey], {
      argv: calls.map((c) => [c.command, ...(c.args ?? [])]),
    });
  });

  test("without its key pair an s3 store does not open: store.secret-missing", async () => {
    const { host } = recordingHost();
    const refused = await storeOpener(host, openerEnv()).open("b2", store, "pw");
    expect(refused.ok ? "" : refused.finding.code).toBe("store.secret-missing");
  });
});

describe("the opener: local and peer stores", () => {
  test("a local store: restic at <root>/<repo> as store.json names it, repo/ for an M1 store without one", async () => {
    const { host, calls } = recordingHost();
    const env = openerEnv();
    const root = join(dir, "ssd");
    mkdirSync(root);
    const opened = value(await storeOpener(host, env).open("ssd", { kind: "local", path: root }, "pw"));
    expect(opened.location).toBe(root);
    value(await opened.engine.list({}));
    expect(calls.at(-1)?.args?.[1]).toBe(join(root, "repo"));
    mkdirSync(join(root, "meta/v1"), { recursive: true });
    writeFileSync(join(root, "meta/v1/store.json"), STORE_JSON);
    const again = value(await storeOpener(host, env).open("ssd", { kind: "local", path: root }, "pw"));
    value(await again.engine.list({}));
    expect(calls.at(-1)?.args?.[1]).toBe(join(root, `repos/${ID}`));
  });

  test("a remote store without a store.json is not set up: its engine refuses before restic runs", async () => {
    const { host, calls } = recordingHost();
    const silent: HostPorts = {
      ...host,
      run: async (spec) => {
        const ran = await host.run(spec);
        // rclone's cat of a key that is not there: exit 3 with nothing captured (on S3 a prefix is no folder).
        if (!spec.command.endsWith("/rclone") || !ran.ok) return ran;
        return { ok: true, value: { ...ran.value, exitCode: 3, captured: new Uint8Array() } };
      },
    };
    const opened = value(
      await storeOpener(silent, openerEnv()).open(
        "b2",
        {
          kind: "s3",
          endpoint: "https://s3.example.eu",
          bucket: "b",
          secret: "env:PW",
          accessKeyId: "env:K",
          secretAccessKey: "env:S",
        },
        "pw",
        { accessKeyId: "k", secretAccessKey: "s" },
      ),
    );
    const listed = await opened.engine.list({});
    expect(listed.ok ? "" : listed.finding.code).toBe("store.not-set-up");
    expect(calls.filter((c) => c.command.endsWith("/restic"))).toHaveLength(0);
  });

  test("a peer store is store.unsupported until M3", async () => {
    const { host } = recordingHost();
    const refused = await storeOpener(host, openerEnv()).open(
      "mini",
      { kind: "peer", device: "mini", path: "/x" },
      "pw",
    );
    expect(refused.ok ? "" : refused.finding.code).toBe("store.unsupported");
  });
});
