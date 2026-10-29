// T2: what the rclone blob store guarantees on the S3 store (SeaweedFS 4.48, D94) and on SFTP through the system's
// OpenSSH, measured on the containers `scripts/testenv up` brings up (M2 Task 17; DESIGN.md "Remote stores:
// consistency and publication"). Each backend's measurements must give exactly its profile in profiles.ts, which is
// then recorded in a sandboxed sidecar as `measured`; the contract and semantic suites run on both with that profile;
// Task 6's election runs between two processes; and a lost acknowledgement, a cut link and a restart of the store
// each end the way the profile says.
//
// `scripts/testenv up && bun run test:t2 -t "blob-rclone|semantics|publish"`

import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  publishEvent,
  readStoreState,
  recordMeasured,
  type StoreFacts,
  type StoreSemantics,
  sameBytes,
  ulid,
} from "@plainport/core";
import { applyProfile, dockerEnv } from "../../../scripts/testenv.ts";
import { s3Probe } from "../../../test/support/s3-probe.ts";
import { SFTP, sftpPackets, sftpServerExtensions } from "../../../test/support/ssh-shim.ts";
import { describeT2 } from "../../../test/tiers.ts";
import { releaseWhenReady } from "../../core/src/testing/barrier.ts";
import { ALL_ELIGIBLE, blobStoreContract } from "../../core/src/testing/blob-store-contract.ts";
import { testHost } from "../../core/src/testing/host.ts";
import { SEAWEEDFS_PROFILE, SFTP_OPENSSH_PROFILE } from "./profiles.ts";
import type { ElectChildConfig, RoundResult } from "./testing/elect-child.ts";
import { type Backend, emptyStore, seedFrom, t2World, value } from "./testing/t2.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array | null): string | null =>
  data === null ? null : new TextDecoder().decode(data);
const run = () => `t17-${crypto.randomUUID()}`;
const ADMITTED = { ...ALL_ELIGIBLE, release: "post-grace-proof" } as const;

const PROFILES: Record<Backend, StoreSemantics> = { s3: SEAWEEDFS_PROFILE, sftp: SFTP_OPENSSH_PROFILE };

/** The profile a measurement shows: each property found, with the evidence it was found by. */
type Found = Partial<StoreSemantics>;
const measured = <T>(v: T) => ({ value: v, evidence: "measured" as const });

/** The pinned tools' versions, which the sidecar's facts name. */
const versions = (rclone: string): { rclone: string; restic: string } => {
  const out = (command: string[]) => Bun.spawnSync(command, { stdout: "pipe" }).stdout.toString();
  const rcloneVersion = /rclone v(\S+)/.exec(out([rclone, "version"]))?.[1];
  const restic = join(rclone, "..", "restic");
  const resticVersion = /restic (\S+)/.exec(out([restic, "version"]))?.[1];
  if (rcloneVersion === undefined || resticVersion === undefined) throw new Error("no tool versions");
  return { rclone: rcloneVersion, restic: resticVersion };
};

/**
 * Checks the measured properties together with the ones only asserted give exactly `profile`, then records them in
 * a sandboxed sidecar as `measured` and reads them back: under the same facts they hold; under another rclone they
 * are dropped.
 */
const recordsAs = async (backend: Backend, found: Found, profile: StoreSemantics): Promise<void> => {
  const asserted: Found = Object.fromEntries(
    Object.entries(profile).filter(([, p]) => p !== "unknown" && p.evidence !== "measured"),
  );
  expect({ ...found, ...asserted }).toEqual(profile);
  const world = await t2World();
  try {
    const io = testHost();
    const storeId = ulid(Date.now());
    const tools = versions(world.rclone);
    const facts: StoreFacts = {
      endpoint:
        backend === "s3"
          ? `${world.env.s3.endpoint}/${world.env.s3.bucket}`
          : `sftp://${world.env.sftp.user}@${world.env.sftp.host}:${world.env.sftp.port}${world.env.sftp.root}`,
      access: backend,
      ...tools,
    };
    value(await recordMeasured(io, world.sandbox.paths, storeId, facts, { semantics: profile }));
    const read = value(await readStoreState(io, world.sandbox.paths, storeId, facts));
    expect(read.measured?.semantics).toEqual(profile);
    const other = value(
      await readStoreState(io, world.sandbox.paths, storeId, { ...facts, rclone: "0.0.0" }),
    );
    expect(other.measured).toBeUndefined();
  } finally {
    world.cleanup();
  }
};

for (const backend of ["s3", "sftp"] as const) {
  describeT2(`blob-rclone semantics on ${backend}: the contract with the measured profile`, () => {
    blobStoreContract(
      `rclone-${backend}, measured`,
      async () => {
        const world = await t2World();
        const store = world.store(world.remote(backend, run()), { semantics: PROFILES[backend] });
        return {
          store,
          cleanup: async () => {
            try {
              await emptyStore(store);
            } finally {
              world.cleanup();
            }
          },
        };
      },
      {
        eligibility: ADMITTED,
        // Every SFTP put is two ssh connections, and the probe writes its listing keys all at once: sshd drops new
        // connections beyond its MaxStartups (10 unauthenticated by default, found here as "Connection closed by"),
        // so the probe keeps to 8 keys there. The 1,500-key listing is measured below with keys copied in one run.
        listProbeKeys: backend === "s3" ? 1001 : 8,
        probeTimeout: 600_000,
      },
    );
  });
}

describeT2("blob-rclone semantics on s3 (SeaweedFS): measured", () => {
  const found: Found = {};

  test("read-after-write and list-after-write, a new key and a replaced one, 25 rounds", async () => {
    const world = await t2World();
    const store = world.store(world.remote("s3", run()), { semantics: SEAWEEDFS_PROFILE });
    try {
      for (let round = 0; round < 25; round++) {
        const key = `meta/v1/events/${ulid(Date.now())}.json`;
        value(await store.put(key, bytes(`one ${round}`)));
        expect(text(value(await store.get(key)))).toBe(`one ${round}`);
        expect(value(await store.list("meta/v1/events/")).map((e) => e.key)).toContain(key);
        value(await store.put(key, bytes(`two ${round}`)));
        expect(text(value(await store.get(key)))).toBe(`two ${round}`);
      }
      found.readAfterWrite = measured(true);
      found.listAfterWrite = measured(true);
    } finally {
      await emptyStore(store);
      world.cleanup();
    }
  }, 300_000);

  test("a listing beyond 1,000 keys is complete across pages, as the direct ListObjectsV2 sees it", async () => {
    const world = await t2World();
    const root = run();
    const store = world.store(world.remote("s3", root));
    const probe = s3Probe(world.env.s3);
    try {
      const local = world.sandbox.dir("seed/page");
      const keys = Array.from({ length: 2500 }, (_, i) => `page/${String(i).padStart(5, "0")}`);
      for (const key of keys) writeFileSync(join(local, key.slice("page/".length)), "p");
      seedFrom(world, world.remote("s3", root), local, "page");
      const listed = value(await store.list("page/"));
      expect(listed.map((e) => e.key)).toEqual(keys);
      const direct = await probe.list(`${root}/page/`, 1000);
      expect(direct.keys).toHaveLength(keys.length);
      expect(direct.pages).toBe(3);
      found.listComplete = measured(true);
    } finally {
      await emptyStore(store);
      world.cleanup();
    }
  }, 300_000);

  test("a put shows its object only once whole: an observer reading during a slow upload", async () => {
    const world = await t2World();
    const store = world.store(world.remote("s3", run()), { bwlimit: "256k" });
    try {
      const key = "meta/v1/events/slow.json";
      const data = new Uint8Array(512 * 1024).fill(9);
      let done = false;
      const seen: number[] = [];
      const observer = (async () => {
        while (!done) {
          const got = value(await store.get(key));
          seen.push(got === null ? -1 : got.length);
        }
      })();
      value(await store.put(key, data));
      done = true;
      await observer;
      expect(seen.length).toBeGreaterThan(2);
      expect(seen.filter((size) => size !== -1 && size !== data.length)).toEqual([]);
      expect(value(await store.get(key))?.length).toBe(data.length);
      found.publication = measured("atomic-put");
    } finally {
      await emptyStore(store);
      world.cleanup();
    }
  }, 300_000);

  test("If-None-Match: the direct SigV4 probe is the reference, and the adapter gives the same", async () => {
    const world = await t2World();
    const root = run();
    const probe = s3Probe(world.env.s3);
    const store = world.store(world.remote("s3", root), { semantics: SEAWEEDFS_PROFILE });
    try {
      // The store itself, without rclone.
      const direct = `${root}/direct/store.json`;
      expect((await probe.put(direct, bytes("first"), { ifNoneMatch: true })).status).toBe(200);
      expect((await probe.put(direct, bytes("second"), { ifNoneMatch: true })).status).toBe(412);
      expect(text((await probe.get(direct)).body)).toBe("first");
      for (let round = 0; round < 5; round++) {
        const key = `${root}/direct/race-${round}`;
        const statuses = (
          await Promise.all(
            Array.from({ length: 12 }, (_, i) => probe.put(key, bytes(`w${i}`), { ifNoneMatch: true })),
          )
        ).map((r) => r.status);
        expect(statuses.filter((s) => s === 200)).toHaveLength(1);
        expect(statuses.filter((s) => s === 412)).toHaveLength(11);
      }

      // Through the adapter: the same answers, as store.key-exists.
      expect(store.capabilities().createIfAbsent).toBe(true);
      value(await store.put("meta/v1/store.json", bytes("first"), { ifNotExists: true }));
      const again = await store.put("meta/v1/store.json", bytes("second"), { ifNotExists: true });
      expect(again).toMatchObject({ ok: false, finding: { code: "store.key-exists" } });
      expect(text(value(await store.get("meta/v1/store.json")))).toBe("first");
      value(await store.put("meta/v1/empty", new Uint8Array(), { ifNotExists: true }));
      expect(await store.put("meta/v1/empty", new Uint8Array(), { ifNotExists: true })).toMatchObject({
        ok: false,
        finding: { code: "store.key-exists" },
      });
      for (let round = 0; round < 10; round++) {
        const key = `race/${round}`;
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) => store.put(key, bytes(`writer ${i}`), { ifNotExists: true })),
        );
        const winners = results.flatMap((result, i) => (result.ok ? [i] : []));
        expect(winners).toHaveLength(1);
        for (const result of results) if (!result.ok) expect(result.finding.code).toBe("store.key-exists");
        expect(text(value(await store.get(key)))).toBe(`writer ${winners[0]}`);
      }
      found.conditionalCreate = measured(true);

      // Switched off (Task 29's non-conditional store, re-planned here): the same store with a profile that does not
      // claim it never sends the header, so a plain put replaces.
      const plain = world.store(world.remote("s3", root), {
        semantics: { ...SEAWEEDFS_PROFILE, conditionalCreate: { value: false, evidence: "asserted" } },
      });
      expect(plain.capabilities().createIfAbsent).toBe(false);
      expect(() => plain.put("meta/v1/store.json", bytes("x"), { ifNotExists: true })).toThrow();
      value(await plain.put("meta/v1/store.json", bytes("replaced")));
      expect(text(value(await store.get("meta/v1/store.json")))).toBe("replaced");
    } finally {
      await emptyStore(store);
      world.cleanup();
    }
  }, 300_000);

  test("an acknowledged put survives a restart of the store (scripts/testenv restart minio)", async () => {
    const world = await t2World();
    const store = world.store(world.remote("s3", run()), { semantics: SEAWEEDFS_PROFILE });
    try {
      const key = `meta/v1/events/${ulid(Date.now())}.json`;
      const event = bytes('{"v":1,"type":"offloaded"}\n');
      expect(value(await publishEvent(store, { key, data: event, sameEvent: sameBytes }))).toEqual({
        written: true,
      });
      const restarted = Bun.spawnSync(
        ["bun", join(import.meta.dir, "../../../scripts/testenv.ts"), "restart", "minio"],
        {
          env: { ...process.env, ...dockerEnv(world.env) },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 180_000,
        },
      );
      expect({ exit: restarted.exitCode, stderr: restarted.stderr.toString() }).toMatchObject({ exit: 0 });
      expect(value(await store.get(key))).toEqual(event);
      expect(value(await store.list("meta/v1/events/")).map((e) => e.key)).toEqual([key]);
      // A restart is not a power cut, and SeaweedFS's volumes fsync only on request: acknowledged, not synced.
      found.durability = measured("acked-unsynced");
    } finally {
      await emptyStore(store);
      world.cleanup();
    }
  }, 300_000);

  test("the measurements give SeaweedFS's profile, recorded in the sidecar as measured", async () => {
    await recordsAs("s3", found, SEAWEEDFS_PROFILE);
  }, 60_000);
});

describeT2("blob-rclone semantics on sftp (OpenSSH, through the system's ssh): measured", () => {
  const found: Found = {};

  test("read-after-write and list-after-write, a new key and a replaced one, 25 rounds", async () => {
    const world = await t2World();
    const store = world.store(world.remote("sftp", run()), { semantics: SFTP_OPENSSH_PROFILE });
    try {
      for (let round = 0; round < 25; round++) {
        const key = `meta/v1/events/${ulid(Date.now())}.json`;
        value(await store.put(key, bytes(`one ${round}`)));
        expect(text(value(await store.get(key)))).toBe(`one ${round}`);
        expect(value(await store.list("meta/v1/events/")).map((e) => e.key)).toContain(key);
        value(await store.put(key, bytes(`two ${round}`)));
        expect(text(value(await store.get(key)))).toBe(`two ${round}`);
      }
      found.readAfterWrite = measured(true);
      found.listAfterWrite = measured(true);
    } finally {
      await emptyStore(store);
      world.cleanup();
    }
  }, 300_000);

  test("a listing of 1,500 keys in one folder is complete across the server's READDIR batches", async () => {
    const world = await t2World();
    const root = run();
    const store = world.store(world.remote("sftp", root));
    try {
      const local = world.sandbox.dir("seed/page");
      const keys = Array.from({ length: 1500 }, (_, i) => `page/${String(i).padStart(5, "0")}`);
      for (const key of keys) writeFileSync(join(local, key.slice("page/".length)), "p");
      seedFrom(world, world.remote("sftp", root), local, "page");
      expect(value(await store.list("page/")).map((e) => e.key)).toEqual(keys);
      found.listComplete = measured(true);
    } finally {
      await emptyStore(store);
      world.cleanup();
    }
  }, 300_000);

  test("the move onto a key is one posix-rename: it replaces a key that is there, and a reader never sees it gone or torn", async () => {
    const world = await t2World({ trace: true });
    const store = world.store(world.remote("sftp", run()), { semantics: SFTP_OPENSSH_PROFILE });
    try {
      const key = "meta/v1/state.json";
      const size = 64 * 1024;
      const fill = (n: number) => new Uint8Array(size).fill(n);
      value(await store.put(key, fill(0)));
      let done = false;
      const seen: string[] = [];
      const observer = (async () => {
        while (!done) {
          const got = value(await store.get(key));
          seen.push(
            got === null
              ? "gone"
              : got.length === size && got.every((b) => b === got[0])
                ? `whole ${got[0]}`
                : `torn ${got.length}`,
          );
        }
      })();
      // Every replacing put succeeds: the rename does not refuse an existing target.
      for (let n = 1; n <= 15; n++) value(await store.put(key, fill(n)));
      done = true;
      await observer;
      expect(seen.length).toBeGreaterThan(3);
      expect(seen.filter((s) => !s.startsWith("whole "))).toEqual([]);
      expect(value(await store.get(key))).toEqual(fill(15));

      // The SFTP requests rclone sent: each move is posix-rename@openssh.com, with no remove of the key before it.
      const connections = readdirSync(world.shim.traces?.dir as string)
        .filter((name) => name.endsWith(".up"))
        .map((name) => sftpPackets(readFileSync(join(world.shim.traces?.dir as string, name))));
      const moves = connections.filter((packets) =>
        packets.some((p) => p.extended === "posix-rename@openssh.com"),
      );
      expect(moves).toHaveLength(16);
      for (const packets of moves) {
        expect(packets.filter((p) => p.type === 13)).toEqual([]); // SSH_FXP_REMOVE
        expect(packets.filter((p) => p.type === SFTP.RENAME)).toEqual([]);
      }
      found.publication = measured("temp-then-rename");
    } finally {
      await emptyStore(store);
      world.cleanup();
    }
  }, 300_000);

  test("durability: the server offers fsync@openssh.com, and rclone never sends it (acked-unsynced, R2-6)", async () => {
    const world = await t2World({ trace: true });
    const store = world.store(world.remote("sftp", run()), { semantics: SFTP_OPENSSH_PROFILE });
    try {
      for (let n = 0; n < 5; n++) value(await store.put(`meta/v1/events/${n}.json`, bytes(`event ${n}\n`)));
      value(await store.put("meta/v1/empty", new Uint8Array()));
      const dir = world.shim.traces?.dir as string;
      const names = readdirSync(dir).filter((name) => name.endsWith(".up"));
      const up = names.map((name) => sftpPackets(readFileSync(join(dir, name))));
      const offered = names.map((name) =>
        sftpServerExtensions(readFileSync(join(dir, name.replace(/\.up$/, ".down")))),
      );
      // Six puts: six uploads (OPEN, WRITE, CLOSE) and six moves.
      expect(up.filter((packets) => packets.some((p) => p.type === SFTP.OPEN))).toHaveLength(6);
      for (const extensions of offered) expect(extensions).toContain("fsync@openssh.com");
      expect(up.flat().filter((p) => p.extended === "fsync@openssh.com")).toEqual([]);
      found.durability = measured("acked-unsynced");
    } finally {
      await emptyStore(store);
      world.cleanup();
    }
  }, 300_000);

  test("the measurements give SFTP's profile, recorded in the sidecar as measured", async () => {
    await recordsAs("sftp", found, SFTP_OPENSSH_PROFILE);
  }, 60_000);
});

/** Two devices, each its own process, holding Task 6's election round after round on one store. */
const electionRace = async (
  backend: Backend,
  profiles: [StoreSemantics, StoreSemantics],
  rounds: number,
): Promise<Record<string, number>> => {
  const world = await t2World();
  const root = run();
  const reader = world.store(world.remote(backend, root));
  try {
    const barrier = world.sandbox.dir("barrier");
    for (let round = 0; round < rounds; round++) mkdirSync(join(barrier, String(round)));
    const names = ["a", "b"] as const;
    const children = names.map((name, i) => {
      const config: ElectChildConfig = {
        backend,
        root,
        semantics: profiles[i] as StoreSemantics,
        rounds,
        barrier,
        name,
      };
      const path = world.sandbox.file(`elect-${name}.json`, JSON.stringify(config));
      return Bun.spawn(["bun", join(import.meta.dir, "testing", "elect-child.ts"), path], {
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
    });
    for (let round = 0; round < rounds; round++) await releaseWhenReady(join(barrier, String(round)), names);
    const outputs = await Promise.all(
      children.map(async (child) => {
        const [out, err, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (exit !== 0) throw new Error(`an election child exited ${exit}: ${err}`);
        return out
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as RoundResult);
      }),
    );
    const tally: Record<string, number> = {};
    for (let round = 0; round < rounds; round++) {
      const results = outputs.map((lines) => lines.find((line) => line.round === round));
      expect(results.every((r) => r !== undefined)).toBe(true);
      const [a, b] = results as [RoundResult, RoundResult];
      expect({ round, a, b, errors: [a, b].filter((r) => r.outcome === "error") }).toMatchObject({
        errors: [],
      });
      const won = [a, b].filter((r) => r.outcome === "won");
      expect({ round, a, b, twoWinners: won.length > 1 }).toMatchObject({ twoWinners: false });
      const published = value(await reader.get(`elect/${String(round).padStart(3, "0")}/store.json`));
      if (won.length === 1) {
        const winner = won[0] as RoundResult;
        expect(text(published)).toBe(`${JSON.stringify({ id: winner.id })}\n`);
        for (const r of [a, b]) if (r.outcome === "lost") expect(r.winner).toBe(winner.id);
      } else {
        // No winner: nobody published, and neither attempt can have lost to anyone.
        expect(published).toBeNull();
        for (const r of [a, b]) expect(r.outcome).toBe("contested");
      }
      const key = `${a.outcome}/${b.outcome}`;
      tally[key] = (tally[key] ?? 0) + 1;
    }
    return tally;
  } finally {
    await emptyStore(reader);
    world.cleanup();
  }
};

describeT2("blob-rclone semantics: Task 6's election, two processes, 50 rounds", () => {
  const ROUNDS = 50;
  const withoutConditional: StoreSemantics = {
    ...SEAWEEDFS_PROFILE,
    conditionalCreate: { value: false, evidence: "asserted" },
  };

  test("on SeaweedFS, both devices with its conditional create: never two winners", async () => {
    const tally = await electionRace("s3", [SEAWEEDFS_PROFILE, SEAWEEDFS_PROFILE], ROUNDS);
    console.info(`election on s3 (conditional create on both): ${JSON.stringify(tally)}`);
  }, 900_000);

  test("on SeaweedFS, one device without conditional create (the switched-off path): never two winners", async () => {
    const tally = await electionRace("s3", [SEAWEEDFS_PROFILE, withoutConditional], ROUNDS);
    console.info(`election on s3 (mixed): ${JSON.stringify(tally)}`);
  }, 900_000);

  test("on SFTP, through the sole-candidate fallback: never two winners", async () => {
    const tally = await electionRace("sftp", [SFTP_OPENSSH_PROFILE, SFTP_OPENSSH_PROFILE], ROUNDS);
    console.info(`election on sftp: ${JSON.stringify(tally)}`);
  }, 1_800_000);
});

describeT2("blob-rclone semantics: faults through Toxiproxy", () => {
  test("lost-ack on a put: the write landed, the call failed, and the retry finds the landed event", async () => {
    const world = await t2World();
    const root = run();
    const proxied = world.store(world.remote("s3", root, { proxied: true }), {
      semantics: SEAWEEDFS_PROFILE,
    });
    const direct = world.store(world.remote("s3", root), { semantics: SEAWEEDFS_PROFILE });
    try {
      for (const ifNotExists of [false, true]) {
        const key = `meta/v1/events/${ulid(Date.now())}.json`;
        const event = bytes(`{"v":1,"id":"${key}"}\n`);
        await applyProfile(world.env, "s3", "lost-ack");
        let put: Awaited<ReturnType<typeof proxied.put>>;
        try {
          put = await proxied.put(key, event, { ifNotExists });
        } finally {
          await applyProfile(world.env, "s3", "clear");
        }
        // Plain: rclone's last try lost its answer too. Create-only: a retry inside rclone found its own landed
        // write and was refused (412). Either way the call failed, and the event is there.
        expect(put.ok).toBe(false);
        expect(value(await direct.get(key))).toEqual(event);
        const retry = await publishEvent(proxied, { key, data: event, sameEvent: sameBytes });
        expect(value(retry)).toEqual({ written: false });
      }
      expect(value(await direct.list("meta/v1/events/"))).toHaveLength(2);
    } finally {
      await applyProfile(world.env, "s3", "clear");
      await emptyStore(direct);
      world.cleanup();
    }
  }, 300_000);

  for (const backend of ["s3", "sftp"] as const) {
    test(`cut during a list on ${backend} fails as store.unreachable, never as a short listing`, async () => {
      const world = await t2World();
      const root = run();
      // Many small pages (S3) or many folders (SFTP), so the listing is still running when the link is cut.
      const remote =
        backend === "s3"
          ? world.remote("s3", root, { proxied: true, options: { list_chunk: "50" } })
          : world.remote("sftp", root, { proxied: true });
      const store = world.store(remote);
      const direct = world.store(world.remote(backend, root));
      try {
        const local = world.sandbox.dir("seed/tree");
        const keys: string[] = [];
        for (let folder = 0; folder < (backend === "s3" ? 1 : 40); folder++) {
          for (let file = 0; file < (backend === "s3" ? 600 : 10); file++) {
            const relative = `${String(folder).padStart(2, "0")}/${String(file).padStart(3, "0")}`;
            mkdirSync(join(local, String(folder).padStart(2, "0")), { recursive: true });
            writeFileSync(join(local, relative), "p");
            keys.push(`tree/${relative}`);
          }
        }
        seedFrom(world, world.remote(backend, root), local, "tree");
        expect(value(await direct.list("tree/")).map((e) => e.key)).toEqual(keys.sort());

        await applyProfile(world.env, backend, "latency");
        const listing = store.list("tree/");
        await Bun.sleep(backend === "s3" ? 1_500 : 5_000);
        await applyProfile(world.env, backend, "cut");
        const listed = await listing;
        await applyProfile(world.env, backend, "clear");
        expect(listed).toMatchObject({ ok: false, finding: { code: "store.unreachable" } });
        // Once the link is back, the same listing is whole.
        expect(value(await store.list("tree/"))).toHaveLength(keys.length);
      } finally {
        await applyProfile(world.env, backend, "clear");
        await emptyStore(direct);
        world.cleanup();
      }
    }, 600_000);
  }
});
