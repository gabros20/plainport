// T2: the rclone blob store against the S3 store (SeaweedFS, D94) and the SFTP server that `scripts/testenv up` brings
// up. It checks the adapter's calls on the real backends with the unmeasured profile (every property unknown, so only
// read is eligible); measuring what each backend guarantees is Task 17's.

import { expect, test } from "bun:test";
import type { Result } from "@plainport/contract";
import { toolPath } from "@plainport/core";
import { loadTestEnv } from "../../../scripts/testenv.ts";
import { describeT2 } from "../../../test/tiers.ts";
import { blobStoreContract } from "../../core/src/testing/blob-store-contract.ts";
import { testHost } from "../../core/src/testing/host.ts";
import { makeSandbox } from "../../core/src/testing/sandbox.ts";
import { type RcloneRemote, rcloneBlobStore } from "./rclone-store.ts";
import { makeRoot } from "./testing/t2.ts";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

const READ_ONLY = {
  read: "eligible",
  append: "refused",
  elect: "refused",
  commit: "refused",
  release: "refused",
} as const;

const remotes = (): Record<"s3" | "sftp", (run: string) => RcloneRemote> => {
  const env = loadTestEnv();
  return {
    s3: (run) => ({
      type: "s3",
      root: `${env.s3.bucket}/rclone-${run}`,
      options: {
        provider: "SeaweedFS",
        endpoint: env.s3.endpoint,
        region: env.s3.region,
        no_check_bucket: "true",
      },
      secrets: { access_key_id: env.s3.accessKeyId, secret_access_key: env.s3.secretAccessKey },
    }),
    sftp: (run) => ({
      type: "sftp",
      root: `${env.sftp.root}/rclone-${run}`,
      options: {
        host: env.sftp.host,
        port: String(env.sftp.port),
        user: env.sftp.user,
        key_file: env.sftp.identityFile,
        known_hosts_file: env.sftp.knownHosts,
        // The known_hosts file holds the server's ed25519 key only.
        host_key_algorithms: "ssh-ed25519",
        shell_type: "none",
        disable_hashcheck: "true",
      },
    }),
  };
};

for (const kind of ["s3", "sftp"] as const) {
  describeT2(`blob-rclone on ${kind}`, () => {
    const make = async () => {
      const sandbox = makeSandbox("plainport-rclone-t2-");
      const host = testHost();
      const found = await toolPath(host, "rclone", { env: {} });
      if (!found.ok) throw new Error(found.finding.message);
      const remote = remotes()[kind](crypto.randomUUID());
      if (kind === "sftp")
        makeRoot({ home: sandbox.home, path: "/usr/bin:/bin", rclone: found.value.path }, remote);
      const store = rcloneBlobStore({
        host,
        rclone: found.value.path,
        remote,
        paths: sandbox.paths,
        env: { HOME: sandbox.home, PATH: "/usr/bin:/bin" },
      });
      return {
        store,
        cleanup: async () => {
          try {
            for (const { key } of value(await store.list(""))) value(await store.delete(key));
          } finally {
            sandbox.cleanup();
          }
        },
      };
    };

    // Each call is an rclone run (an SFTP one a connection): the listing case took 3.6 s on CI, close to bun's 5 s.
    blobStoreContract(`rclone-${kind}, unmeasured`, make, {
      eligibility: READ_ONLY,
      probeTimeout: 60_000,
      testTimeout: 60_000,
    });

    test("a missing key is null beside others and under no folder; an empty value round-trips", async () => {
      const { store, cleanup } = await make();
      try {
        value(await store.put("meta/v1/events/a.json", new TextEncoder().encode("a\n")));
        value(await store.put("meta/v1/empty", new Uint8Array()));
        expect(value(await store.get("meta/v1/events/b.json"))).toBeNull();
        expect(value(await store.get("nowhere/at/all.json"))).toBeNull();
        expect(value(await store.stat("nowhere/at/all.json"))).toBeNull();
        // A folder is never read as a key.
        expect(value(await store.get("meta/v1/events"))).toBeNull();
        expect(value(await store.get("meta/v1/empty"))).toEqual(new Uint8Array());
        const got = value(await store.getMany(["meta/v1/events/a.json", "meta/v1/events/b.json"]));
        expect([...got.keys()]).toEqual(["meta/v1/events/a.json"]);
        expect(value(await store.list("meta/v1/tmp/"))).toEqual([]);
      } finally {
        await cleanup();
      }
    }, 60_000);
  });
}
