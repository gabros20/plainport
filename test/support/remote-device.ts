// Test-only: a device that uses the T2 stores `scripts/testenv up` brought up (M2 Task 18), through the binary's own
// store opener: a sandboxed home with the ssh shim first on PATH (test/support/ssh-shim.ts), a config.toml naming an
// sftp store (OpenSSH in the container) and an s3 store (SeaweedFS, D94) under one fresh prefix each, their secrets as
// env: references, and the CLI run in process with the real restic and rclone.
//
// Until `store test` measures a store (Task 19), the stores' profiles are asserted in config with the values Task 17
// measured (blob-rclone's profiles.ts); `durability` is the test's to choose, since Q21's post-grace proof (Task 24)
// is what admits an acked-unsynced store to release.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { SEAWEEDFS_PROFILE, SFTP_OPENSSH_PROFILE } from "../../packages/blob-rclone/src/profiles.ts";
import { makeRoot } from "../../packages/blob-rclone/src/testing/t2.ts";
import { REGISTRY } from "../../packages/cli/src/commands/index.ts";
import type { Ports } from "../../packages/cli/src/registry.ts";
import { storeOpener } from "../../packages/cli/src/stores.ts";
import { capture, sandboxPorts } from "../../packages/cli/src/testing.ts";
import type { Result } from "../../packages/contract/src/index.ts";
import { type StoreSemantics, semanticValue } from "../../packages/core/src/ports/blob-store.ts";
import { testHost } from "../../packages/core/src/testing/host.ts";
import { makeSandbox, type Sandbox } from "../../packages/core/src/testing/sandbox.ts";
import { loadTestEnv, type TestEnv } from "../../scripts/testenv.ts";
import { makeSshShim, type SshShim } from "./ssh-shim.ts";

export type RemoteKind = "sftp" | "s3";
export const REMOTE_KINDS: readonly RemoteKind[] = ["sftp", "s3"];

export const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

/** A fresh prefix for one test's stores, under the T2 SFTP folder and bucket. */
export const freshPrefix = (label: string): string => `t18/${label}-${randomBytes(6).toString("hex")}`;

/** The measured reference profile of a kind as config's assertions, with `durability` replaced when asked. */
export const assertedProfile = (
  kind: RemoteKind,
  durability?: "durable" | "acked-unsynced",
): Record<string, string | boolean> => {
  const profile: StoreSemantics = kind === "sftp" ? SFTP_OPENSSH_PROFILE : SEAWEEDFS_PROFILE;
  const out: Record<string, string | boolean> = {};
  for (const [property, held] of Object.entries(profile)) {
    const known = semanticValue(held as StoreSemantics["durability"]);
    if (known !== "unknown") out[property] = known;
  }
  if (durability !== undefined) out.durability = durability;
  return out;
};

const tomlValue = (value: string | boolean): string =>
  typeof value === "string" ? `"${value}"` : String(value);

export interface StoreSpec {
  kind: RemoteKind;
  /** The store's prefix under the T2 folder or bucket. */
  prefix: string;
  /** Through Toxiproxy, for fault tests. */
  proxied?: boolean;
  /** Config's assertions; assertedProfile(kind) by default. */
  semantics?: Record<string, string | boolean>;
}

/** The config.toml table of a store named `name`. */
export const storeToml = (env: TestEnv, name: string, spec: StoreSpec): string[] => {
  const semantics = spec.semantics ?? assertedProfile(spec.kind);
  const lines =
    spec.kind === "sftp"
      ? [
          `[stores.${name}]`,
          'kind = "sftp"',
          `host = "${spec.proxied ? env.sftp.proxiedAlias : env.sftp.alias}"`,
          `path = "${env.sftp.root}/${spec.prefix}"`,
          'secret = "env:T18_STORE_PASSWORD"',
        ]
      : [
          `[stores.${name}]`,
          'kind = "s3"',
          `endpoint = "${spec.proxied ? env.s3.proxied : env.s3.endpoint}"`,
          `bucket = "${env.s3.bucket}"`,
          `path = "${spec.prefix}"`,
          `region = "${env.s3.region}"`,
          'secret = "env:T18_STORE_PASSWORD"',
          'accessKeyId = "env:T18_S3_KEY_ID"',
          'secretAccessKey = "env:T18_S3_SECRET_KEY"',
        ];
  return [
    ...lines,
    `[stores.${name}.semantics]`,
    ...Object.entries(semantics).map(([k, v]) => `${k} = ${tomlValue(v)}`),
  ];
};

export interface RemoteDevice {
  box: Sandbox;
  env: TestEnv;
  shim: SshShim;
  rclone: string;
  /** The environment the CLI, its opener and their children get. */
  vars: Record<string, string>;
  /** Writes config.toml: the stores (by name) and the work root on this device (`~/work`, storing to `store`). */
  configure(stores: Record<string, StoreSpec>, root?: { store: string; extra?: string[] }): void;
  /** Makes an SFTP store's root folder, as setting the store up does (an S3 prefix is no folder). */
  makeRoot(spec: StoreSpec): void;
  ports(over?: Partial<Ports>): Ports;
  cli(argv: string[], over?: Partial<Ports>): Promise<{ code: number; out: string; err: string }>;
  cleanup(): Promise<void>;
}

export const remoteDevice = async (
  password: string,
  options: { rclone: string; extraPath?: string } & { opener?: { unreachableAfterMs?: number } },
): Promise<RemoteDevice> => {
  const env = loadTestEnv();
  const box = makeSandbox("plainport-remote-t2-");
  const shim = makeSshShim(join(box.home, "bin"), env.sftp.sshConfig);
  const vars: Record<string, string> = {
    HOME: box.home,
    PATH: [
      shim.dir,
      ...(options.extraPath === undefined ? [] : [options.extraPath]),
      "/usr/bin",
      "/bin",
    ].join(":"),
    TMPDIR: box.dir("tmp"),
    T18_STORE_PASSWORD: password,
    T18_S3_KEY_ID: env.s3.accessKeyId,
    T18_S3_SECRET_KEY: env.s3.secretAccessKey,
    PLAINPORT_STORE_PASSWORD: password,
  };
  const ports = (over: Partial<Ports> = {}): Ports => {
    const host = testHost();
    return sandboxPorts(box.home, {
      env: vars,
      system: host,
      io: host,
      stores: storeOpener(host, vars, options.opener ?? {}),
      ...over,
    });
  };
  return {
    box,
    env,
    shim,
    rclone: options.rclone,
    vars,
    configure: (stores, root) =>
      box.file(
        ".config/plainport/config.toml",
        [
          "version = 1",
          ...(root === undefined ? [] : [`defaultStore = "${root.store}"`]),
          ...Object.entries(stores).flatMap(([name, spec]) => storeToml(env, name, spec)),
          ...(root === undefined
            ? []
            : ["[roots.work]", `store = "${root.store}"`, 'on = { mbp = "~/work" }', ...(root.extra ?? [])]),
          "",
        ].join("\n"),
      ),
    makeRoot: (spec) => {
      if (spec.kind !== "sftp") return;
      makeRoot(
        { home: box.home, path: vars.PATH as string, rclone: options.rclone },
        {
          type: "sftp",
          root: `${env.sftp.root}/${spec.prefix}`,
          options: { ssh: shim.rcloneSsh(spec.proxied ? env.sftp.proxiedAlias : env.sftp.alias) },
        },
      );
    },
    ports,
    cli: (argv, over = {}) => capture(argv, REGISTRY, { ports: ports(over) }),
    cleanup: () => box.cleanupSettled(),
  };
};
