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
  /** The remote of `backend` under `root`; dispose() purges every root asked for here. */
  remote(
    backend: Backend,
    root: string,
    how?: { proxied?: boolean; options?: Record<string, string> },
  ): RcloneRemote;
  /** Removes the sandbox only: for a process (an election child) whose roots its parent purges. */
  cleanup(): void;
  /**
   * Purges every root remote() was asked for, one rclone run each, then removes the sandbox; the sandbox goes even
   * when a purge fails or is killed (a test that timed out), so no temp folder outlives the test.
   */
  dispose(): Promise<void>;
}

/** A sandbox, an ssh shim in it (tracing when asked) and the pinned rclone. */
export const t2World = async (how: { trace?: boolean } = {}): Promise<T2World> => {
  const env = loadTestEnv();
  const sandbox = makeSandbox("plainport-rclone-t2-");
  const shim = makeSshShim(join(sandbox.home, "bin"), env.sftp.sshConfig, { trace: how.trace === true });
  const rclone = await rclonePath();
  const host = testHost();
  const roots = new Map<string, { backend: Backend; root: string }>();
  const remote: T2World["remote"] = (backend, root, remoteHow = {}) => {
    roots.set(`${backend}:${root}`, { backend, root });
    return backend === "s3" ? s3Remote(env, root, remoteHow) : sftpRemote(env, shim, root, remoteHow);
  };
  const world: T2World = {
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
    remote,
    cleanup: () => sandbox.cleanup(),
    dispose: async () => {
      try {
        const failed: string[] = [];
        for (const { backend, root } of roots.values()) {
          const purged = await purgeRoot(world, remote(backend, root));
          if (purged !== undefined) failed.push(purged);
        }
        if (failed.length > 0) throw new Error(`the T2 roots could not be purged: ${failed.join("; ")}`);
      } finally {
        sandbox.cleanup();
      }
    },
  };
  return world;
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

/** One rclone run on `remote` (named AT), with the remote's environment built the way the adapter builds it. */
const rcloneOn = async (
  world: T2World,
  remote: RcloneRemote,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ exitCode: number | null; signal: string | null; stderr: string }> => {
  const env: Record<string, string> = {
    HOME: world.sandbox.home,
    PATH: `${world.shim.dir}:/usr/bin:/bin`,
    RCLONE_CONFIG: join(world.sandbox.home, "absent", "rclone.conf"),
    RCLONE_CONFIG_AT_TYPE: remote.type,
  };
  for (const [name, option] of Object.entries({ ...remote.options, ...remote.secrets }))
    env[`RCLONE_CONFIG_AT_${name.toUpperCase()}`] = option;
  // Asynchronous, unlike makeRoot: a long run must not hold the event loop, or a test's timeout could not fire.
  const child = Bun.spawn([world.rclone, "-q", ...args], {
    env,
    stdout: "ignore",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { exitCode, signal: child.signalCode, stderr };
};

/**
 * Copies a local folder's files under `remote`'s root in one rclone run, for tests that need many keys at once (the
 * adapter writes one key per run). Test-only.
 */
export const seedFrom = async (
  world: T2World,
  remote: RcloneRemote,
  local: string,
  under: string,
): Promise<void> => {
  const ran = await rcloneOn(
    world,
    remote,
    ["--transfers", "16", "copy", local, `AT:${remote.root}/${under}`],
    300_000,
  );
  if (ran.exitCode !== 0)
    throw new Error(`rclone copy ${local}: ${ran.exitCode ?? ran.signal} ${ran.stderr}`);
};

/** rclone's exit code for a folder that is not there (on S3, a prefix with no keys). */
const DIRECTORY_NOT_FOUND = 3;

/**
 * Removes `remote`'s root and everything under it in one rclone run: a root never written is fine. Returns what went
 * wrong, if anything. Test-only: deleting key by key through the adapter costs one run (one SFTP connection) per key.
 */
const purgeRoot = async (world: T2World, remote: RcloneRemote): Promise<string | undefined> => {
  const ran = await rcloneOn(world, remote, ["purge", `AT:${remote.root}`], 120_000);
  if (ran.exitCode === 0 || ran.exitCode === DIRECTORY_NOT_FOUND) return undefined;
  return `rclone purge ${remote.root}: ${ran.exitCode ?? ran.signal} ${ran.stderr.trim()}`;
};
