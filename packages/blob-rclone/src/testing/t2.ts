// Test-only: the rclone stores the T2 suites build on the environment `scripts/testenv up` brought up (M2 Task 17).
// The S3 store (SeaweedFS, D94) directly or through Toxiproxy; SFTP through the system's OpenSSH and the sandbox's
// ssh config (test/support/ssh-shim.ts), directly or through Toxiproxy.

import { join } from "node:path";
import type { Result } from "@plainport/contract";
import { toolPath } from "@plainport/core";
import { loadTestEnv, type TestEnv } from "../../../../scripts/testenv.ts";
import { makeSshShim, type SshShim } from "../../../../test/support/ssh-shim.ts";
import { testHost } from "../../../core/src/testing/host.ts";
import { makeSandbox, type Sandbox } from "../../../core/src/testing/sandbox.ts";
import {
  type RcloneBlobStore,
  type RcloneBlobStoreOptions,
  type RcloneRemote,
  rcloneBlobStore,
} from "../rclone-store.ts";

export type Backend = "s3" | "sftp";

export const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

export const rclonePath = async (): Promise<string> => {
  const found = await toolPath(testHost(), "rclone", { env: {} });
  if (!found.ok) throw new Error(found.finding.message);
  return found.value.path;
};

/** The S3 store's remote, its root under a fresh prefix; `proxied` goes through Toxiproxy. */
export const s3Remote = (
  env: TestEnv,
  root: string,
  how: { proxied?: boolean; options?: Record<string, string> } = {},
): RcloneRemote => ({
  type: "s3",
  root: `${env.s3.bucket}/${root}`,
  options: {
    provider: "SeaweedFS",
    endpoint: how.proxied ? env.s3.proxied : env.s3.endpoint,
    region: env.s3.region,
    no_check_bucket: "true",
    ...how.options,
  },
  secrets: { access_key_id: env.s3.accessKeyId, secret_access_key: env.s3.secretAccessKey },
});

/** The SFTP remote through the system's ssh (rclone's ssh option), its root under the writable folder. */
export const sftpRemote = (
  env: TestEnv,
  shim: SshShim,
  root: string,
  how: { proxied?: boolean } = {},
): RcloneRemote => ({
  type: "sftp",
  root: `${env.sftp.root}/${root}`,
  options: {
    ssh: shim.rcloneSsh(how.proxied ? env.sftp.proxiedAlias : env.sftp.alias),
    // No remote shell commands (hashes, disk usage): every run is the SFTP subsystem alone.
    shell_type: "none",
    disable_hashcheck: "true",
  },
});

export interface T2World {
  env: TestEnv;
  sandbox: Sandbox;
  shim: SshShim;
  rclone: string;
  /** A store over `remote` with this world's sandbox; `patch` overrides any option. */
  store(remote: RcloneRemote, patch?: Partial<RcloneBlobStoreOptions>): RcloneBlobStore;
  /** The remote of `backend` under `root`. */
  remote(
    backend: Backend,
    root: string,
    how?: { proxied?: boolean; options?: Record<string, string> },
  ): RcloneRemote;
  cleanup(): void;
}

/** A sandbox, an ssh shim in it (tracing when asked) and the pinned rclone. */
export const t2World = async (how: { trace?: boolean } = {}): Promise<T2World> => {
  const env = loadTestEnv();
  const sandbox = makeSandbox("plainport-rclone-t2-");
  const shim = makeSshShim(join(sandbox.home, "bin"), env.sftp.sshConfig, { trace: how.trace === true });
  const rclone = await rclonePath();
  const host = testHost();
  return {
    env,
    sandbox,
    shim,
    rclone,
    store: (remote, patch = {}) => {
      // An SFTP store's root is a real folder, which setting the store up makes (a missing one is unreachable).
      if (remote.type === "sftp")
        makeRoot({ home: sandbox.home, path: `${shim.dir}:/usr/bin:/bin`, rclone }, remote);
      return rcloneBlobStore({
        host,
        rclone,
        remote,
        paths: sandbox.paths,
        env: { HOME: sandbox.home, PATH: `${shim.dir}:/usr/bin:/bin`, TMPDIR: sandbox.dir("tmp") },
        ...patch,
      });
    },
    remote: (backend, root, remoteHow = {}) =>
      backend === "s3" ? s3Remote(env, root, remoteHow) : sftpRemote(env, shim, root, remoteHow),
    cleanup: () => sandbox.cleanup(),
  };
};

/**
 * Makes `remote`'s root folder (rclone mkdir, which is idempotent), as setting a store up does. Test-only: it builds
 * the remote's environment the way the adapter does.
 */
export const makeRoot = (how: { home: string; path: string; rclone: string }, remote: RcloneRemote): void => {
  const env: Record<string, string> = {
    HOME: how.home,
    PATH: how.path,
    RCLONE_CONFIG: join(how.home, "absent", "rclone.conf"),
    RCLONE_CONFIG_ROOT_TYPE: remote.type,
  };
  for (const [name, option] of Object.entries({ ...remote.options, ...remote.secrets }))
    env[`RCLONE_CONFIG_ROOT_${name.toUpperCase()}`] = option;
  const ran = Bun.spawnSync([how.rclone, "-q", "mkdir", `ROOT:${remote.root}`], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  if (ran.exitCode !== 0)
    throw new Error(`rclone mkdir ${remote.root}: ${ran.exitCode} ${ran.stderr.toString()}`);
};

/**
 * Copies a local folder's files under `remote`'s root in one rclone run, for tests that need many keys at once (the
 * adapter writes one key per run). Test-only: it builds the remote's environment the way the adapter does.
 */
export const seedFrom = (world: T2World, remote: RcloneRemote, local: string, under: string): void => {
  const env: Record<string, string> = {
    HOME: world.sandbox.home,
    PATH: `${world.shim.dir}:/usr/bin:/bin`,
    RCLONE_CONFIG: join(world.sandbox.home, "absent", "rclone.conf"),
    RCLONE_CONFIG_SEED_TYPE: remote.type,
  };
  for (const [name, option] of Object.entries({ ...remote.options, ...remote.secrets }))
    env[`RCLONE_CONFIG_SEED_${name.toUpperCase()}`] = option;
  const ran = Bun.spawnSync(
    [world.rclone, "-q", "--transfers", "16", "copy", local, `SEED:${remote.root}/${under}`],
    { env, stdout: "pipe", stderr: "pipe", timeout: 300_000 },
  );
  if (ran.exitCode !== 0) throw new Error(`rclone copy ${local}: ${ran.exitCode} ${ran.stderr.toString()}`);
};

/** Deletes every key under the store's root. */
export const emptyStore = async (store: RcloneBlobStore): Promise<void> => {
  for (const { key } of value(await store.list(""))) value(await store.delete(key));
};
