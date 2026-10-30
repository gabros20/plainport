// M2 Task 18 on T2: restic reaches SFTP and S3 stores (SeaweedFS, D94) at the bootstrapped repository location, and
// bootstrap holds against real simultaneous initialisers, all through the binary's store opener with the real restic
// and rclone (DESIGN.md "Storage → Store kinds", "Bootstrap"; Q7, Q9).
//
// - The two layers agree (Q7): what restic writes at a repository is found through rclone under the same root, and a
//   repository copied through rclone opens with restic.
// - Two processes with different passwords bootstrap one fresh store at once: exactly one publishes (D109), and the
//   loser's restic never runs at the winner's repository.
// - A kill (SIGKILL) at each bootstrap step or seam, then `plainport recover`, settles to published or rolled back,
//   with the store, the registry and the journals agreeing.
// - A single-device round trip, offload then onload, is byte-identical (Task 3's comparison) with the store's
//   durability asserted; without the assertion the offload commits and keeps its folder.
// - A cut mid-upload fails before the commit, and invariants 1 to 3 hold.
//
// Every store lives under a fresh prefix; the SFTP children are run one or two at a time (sshd drops logins past ~10).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOOTSTRAP_AFTER_EFFECT,
  BOOTSTRAP_STEPS,
  ConfigLoader,
  ensureDevice,
  type OpenedStore,
  openBootstrapStore,
  resolvePaths,
  runBootstrap,
  STORE_IDENTITY_KEY,
} from "@plainport/core";
import { applyProfile } from "../../../scripts/testenv.ts";
import { compareTrees, hashTree } from "../../../scripts/tree-compare.ts";
import type { BootstrapChildConfig, BootstrapChildResult } from "../../../test/support/bootstrap-child.ts";
import {
  assertedProfile,
  freshPrefix,
  REMOTE_KINDS,
  type RemoteDevice,
  remoteDevice,
  type StoreSpec,
  value,
} from "../../../test/support/remote-device.ts";
import { describeT2 } from "../../../test/tiers.ts";
import { rclonePath } from "../../blob-rclone/src/testing/t2.ts";
import { releaseWhenReady } from "../../core/src/testing/barrier.ts";
import { testHost } from "../../core/src/testing/host.ts";
import { invariantViolations } from "../../core/src/testing/invariants.ts";
import { storeOpener } from "./stores.ts";

const CHILD = join(import.meta.dir, "../../../test/support/bootstrap-child.ts");
const STORE = "remote";

let rclone: string;
const devices: RemoteDevice[] = [];
const timings: string[] = [];

const device = async (password: string, opener?: { unreachableAfterMs?: number }) => {
  const d = await remoteDevice(password, { rclone, ...(opener === undefined ? {} : { opener }) });
  devices.push(d);
  value(await ensureDevice(testHost(), d.box.paths, { role: "owner", name: "mbp" }));
  return d;
};

/** The S3 key pair `d`'s config references, read from its environment as core's env: provider would. */
const keyPairOf = (d: RemoteDevice) => {
  const [accessKeyId, secretAccessKey] = ["T18_S3_KEY_ID", "T18_S3_SECRET_KEY"].map(
    (name) => d.vars[name] ?? "",
  );
  return { accessKeyId: accessKeyId as string, secretAccessKey: secretAccessKey as string };
};

/** The store as `d`'s opener reaches it, for checks from outside the CLI. */
const opened = async (d: RemoteDevice, name = STORE): Promise<OpenedStore> => {
  const loaded = value(await new ConfigLoader(testHost(), d.box.paths).load({ env: d.vars }));
  const store = loaded.config.stores[name];
  if (store === undefined) throw new Error(`no store ${name}`);
  const host = testHost();
  return value(
    await storeOpener(host, d.vars).open(
      name,
      store,
      d.vars.T18_STORE_PASSWORD as string,
      store.kind === "s3" ? keyPairOf(d) : undefined,
    ),
  );
};

/** Sets the store up from `d` in process, as the bootstrap child does. */
const bootstrapHere = async (d: RemoteDevice, name = STORE) => {
  const host = testHost();
  const loaded = value(await new ConfigLoader(host, d.box.paths).load({ env: d.vars }));
  const store = value(
    await openBootstrapStore(host, {
      paths: d.box.paths,
      env: d.vars,
      name,
      config: loaded.config,
      opener: storeOpener(host, d.vars),
    }),
  );
  return value(
    await runBootstrap(
      {
        io: host,
        paths: d.box.paths,
        faultAt: () => {},
        clock: () => new Date(),
        log: () => {},
        wait: (ms) => Bun.sleep(ms),
      },
      store,
      { name, seal: "none" },
    ),
  );
};

/** Runs the bootstrap child for `d`; resolves with its result line, or null when it was killed. */
const child = async (
  d: RemoteDevice,
  extra: Partial<BootstrapChildConfig> = {},
): Promise<{ result: BootstrapChildResult | null; signal: string | null; stderr: string }> => {
  const path = join(d.box.dir("child"), `config-${Math.random().toString(36).slice(2)}.json`);
  const config: BootstrapChildConfig = { env: d.vars, store: STORE, ...extra };
  writeFileSync(path, JSON.stringify(config));
  // The child's own environment is this process's, so its test guard protects the real home; the device's environment
  // (its sandboxed HOME, the ssh shim, the secrets) is in its config, which is all its opener and children get.
  const proc = Bun.spawn([process.execPath, CHILD, path], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 240_000,
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const line = out.trim().split("\n").at(-1) ?? "";
  return {
    result: line.startsWith("{") ? (JSON.parse(line) as BootstrapChildResult) : null,
    signal: proc.signalCode,
    stderr: err,
  };
};

/** The --json envelope: the last line, after any event lines. */
const envelope = (out: string): { ok: boolean; data: Record<string, unknown> } =>
  JSON.parse(out.trim().split("\n").at(-1) as string) as { ok: boolean; data: Record<string, unknown> };

const registryStores = (d: RemoteDevice): Record<string, string> => {
  const path = d.box.paths.registryFile;
  if (!existsSync(path)) return {};
  return (JSON.parse(readFileSync(path, "utf8")) as { stores?: Record<string, string> }).stores ?? {};
};

const journalsOf = (d: RemoteDevice): string[] => {
  const dir = d.box.paths.journalDir;
  if (!existsSync(dir)) return [];
  return [...new Bun.Glob("*.json").scanSync(dir)];
};

beforeAll(async () => {
  rclone = await rclonePath();
});
afterAll(async () => {
  for (const d of devices) await d.cleanup();
  if (timings.length > 0) process.stdout.write(`${timings.join("\n")}\n`);
});

describeT2("remote stores: the two layers agree (Q7)", () => {
  for (const kind of REMOTE_KINDS) {
    test(`stores on ${kind}: a marker restic writes is found through rclone, and a repository rclone writes opens with restic`, async () => {
      const d = await device("layers-pw");
      const spec: StoreSpec = { kind, prefix: freshPrefix("layers") };
      d.configure({ [STORE]: spec });
      d.makeRoot(spec);
      const store = await opened(d);
      const engineAt = store.engineAt as (repo: string) => import("@plainport/core").Engine;
      const a = "repos/01K6ZB7Q3M8XWJ5N2T4R6Y8VC0";
      const b = "repos/01K6ZB7Q3M8XWJ5N2T4R6Y8VC1";
      value(await engineAt(a).init());
      // restic → rclone: restic's own config file, at the same prefix.
      const listed = value(await store.blob.list(`${a}/`));
      expect(listed.map((e) => e.key)).toContain(`${a}/config`);
      // rclone → restic: every file of that repository, copied key by key, is a repository restic opens.
      for (const { key } of listed) {
        const bytes = value(await store.blob.get(key));
        if (bytes !== null) value(await store.blob.put(`${b}${key.slice(a.length)}`, bytes));
      }
      expect(value(await engineAt(b).list({ noLock: true }))).toEqual([]);
    }, 240_000);
  }
});

describeT2("remote stores: bootstrap with real simultaneous initialisers", () => {
  for (const kind of REMOTE_KINDS) {
    test(`bootstrap on ${kind}: two processes with different passwords produce one repository, and the loser never touches it`, async () => {
      for (let round = 0; round < 2; round++) {
        const spec: StoreSpec = { kind, prefix: freshPrefix(`race${round}`) };
        const pair = [await device(`race-a-${round}`), await device(`race-b-${round}`)];
        for (const d of pair) d.configure({ [STORE]: spec });
        pair[0]?.makeRoot(spec);
        const barrier = pair[0]?.box.dir(`barrier-${round}`) as string;
        const started = performance.now();
        const runs = pair.map((d, i) => child(d, { barrier: { dir: barrier, name: `d${i}` } }));
        // A child that ends before it is ready (a setup failure) fails the round with what it said.
        const ended = Promise.race(runs).then((r) => {
          throw new Error(`a child ended before the barrier: ${JSON.stringify(r.result)} ${r.stderr}`);
        });
        await Promise.race([releaseWhenReady(barrier, ["d0", "d1"]), ended]);
        ended.catch(() => {});
        const results = await Promise.all(runs);
        timings.push(`bootstrap race on ${kind}: ${Math.round(performance.now() - started)} ms`);
        const outcomes = results.map((r) => r.result?.outcome ?? `killed: ${r.stderr}`);
        // D109: exactly one winner per simultaneous round.
        expect(outcomes.filter((o) => o === "published")).toHaveLength(1);
        const winnerAt = outcomes.indexOf("published");
        const winner = results[winnerAt]?.result as BootstrapChildResult;
        const loser = results[1 - winnerAt]?.result as BootstrapChildResult;
        expect(loser.code).toBe("store.bootstrap-lost");
        const winnerRepo = `repos/${winner.id}`;
        expect(loser.repos.length).toBeGreaterThan(0);
        expect(loser.repos.filter((r) => r.endsWith(winnerRepo))).toEqual([]);
        // One published repository, the winner's; it opens with the winner's password and refuses the loser's.
        const winnerDevice = pair[winnerAt] as RemoteDevice;
        const loserDevice = pair[1 - winnerAt] as RemoteDevice;
        const store = await opened(winnerDevice);
        const published = JSON.parse(
          new TextDecoder().decode(value(await store.blob.get(STORE_IDENTITY_KEY)) ?? new Uint8Array()),
        ) as { id: string; repo: string };
        expect(published).toMatchObject({ id: winner.id, repo: winnerRepo });
        expect(value(await store.engine.list({ noLock: true }))).toEqual([]);
        const theirs = await (await opened(loserDevice)).engine.list({ noLock: true });
        expect(theirs.ok ? "" : theirs.finding.code).toBe("restic.wrong-password");
        expect(registryStores(winnerDevice)).toEqual({ [STORE]: winner.id as string });
        expect(registryStores(loserDevice)).toEqual({});
      }
    }, 600_000);
  }
});

/** Every bootstrap crash row a sole attempt reaches: its journal steps and its after-effect seams. */
const ROWS = [
  ...BOOTSTRAP_STEPS,
  ...Object.keys(BOOTSTRAP_AFTER_EFFECT).filter((seam) => seam !== "bootstrap.refusal.written"),
];
/** Before the candidacy nothing is published, so recover rolls back; from it on the attempt publishes. */
const settlesTo = (row: string) =>
  ["bootstrap.begin", "bootstrap.init.done", "bootstrap.initialised"].includes(row)
    ? "rolled-back"
    : "published";

describeT2("remote stores: a kill at each bootstrap step, then recover", () => {
  for (const kind of REMOTE_KINDS) {
    test(`bootstrap on ${kind}: a SIGKILL at every step and seam, then plainport recover, settles it`, async () => {
      const problems: string[] = [];
      for (const row of ROWS) {
        const d = await device(`crash-${row}`);
        const spec: StoreSpec = { kind, prefix: freshPrefix("crash") };
        d.configure({ [STORE]: spec });
        d.makeRoot(spec);
        const killed = await child(d, { faultAt: row });
        if (killed.signal !== "SIGKILL" || killed.result !== null) {
          problems.push(
            `${row}: the child was not killed (${killed.signal}, ${JSON.stringify(killed.result)})`,
          );
          continue;
        }
        const recovered = await d.cli(["recover", "--json"]);
        if (recovered.code !== 0) {
          problems.push(`${row}: recover exited ${recovered.code}: ${recovered.out}${recovered.err}`);
          continue;
        }
        const bootstraps = envelope(recovered.out).data.bootstraps as {
          attempt: string;
          outcome: string;
          id?: string;
        }[];
        const want = settlesTo(row);
        if (bootstraps.length !== 1 || bootstraps[0]?.outcome !== want) {
          problems.push(`${row}: recover settled ${JSON.stringify(bootstraps)}, not ${want}`);
          continue;
        }
        const attempt = bootstraps[0]?.attempt as string;
        const store = await opened(d);
        const bytes = value(await store.blob.get(STORE_IDENTITY_KEY));
        const published =
          bytes === null ? undefined : (JSON.parse(new TextDecoder().decode(bytes)) as { id: string });
        const pinned = registryStores(d)[STORE];
        if (want === "published") {
          if (published?.id !== attempt || pinned !== attempt)
            problems.push(`${row}: published ${published?.id}, pinned ${pinned}, not the attempt ${attempt}`);
          // The published repository is this attempt's, and it opens with this device's password.
          const listed = await store.engine.list({ noLock: true });
          if (!listed.ok)
            problems.push(`${row}: the published repository does not open: ${listed.finding.code}`);
        } else if (published !== undefined || pinned !== undefined)
          problems.push(`${row}: rolled back, yet published ${published?.id}, pinned ${pinned}`);
        if (journalsOf(d).some((name) => name.startsWith(attempt)))
          problems.push(`${row}: the bootstrap journal is still there`);
        const again = await d.cli(["recover", "--json"]);
        if (again.code !== 0 || (envelope(again.out).data.bootstraps as unknown[]).length !== 0)
          problems.push(`${row}: a second recover had work to do: ${again.out}`);
      }
      expect(problems).toEqual([]);
    }, 1_200_000);
  }
});

/** A small project: sources, a .env, a symlink, an exec bit, a read-only file, binary bytes, dependencies to strip. */
const makeProject = (d: RemoteDevice, bytes = 64 * 1024): string => {
  const dir = d.box.dir("work/web");
  d.box.file("work/web/package.json", `${JSON.stringify({ name: "web" })}\n`);
  d.box.file("work/web/package-lock.json", `${JSON.stringify({ lockfileVersion: 3 })}\n`);
  d.box.file("work/web/src/main.ts", "export const main = 1;\n");
  d.box.file("work/web/.env", "TOKEN=op://vault/item\n");
  d.box.file("work/web/bin/run.sh", "#!/bin/sh\necho hi\n");
  chmodSync(join(dir, "bin/run.sh"), 0o755);
  d.box.file("work/web/docs/frozen.txt", "read only\n");
  chmodSync(join(dir, "docs/frozen.txt"), 0o444);
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(
    join(dir, "assets/blob.bin"),
    crypto.getRandomValues(new Uint8Array(Math.min(bytes, 65_536))),
  );
  for (let at = 65_536, i = 0; at < bytes; at += 65_536, i++)
    writeFileSync(join(dir, `assets/part-${i}.bin`), crypto.getRandomValues(new Uint8Array(65_536)));
  symlinkSync("src/main.ts", join(dir, "main-link"));
  d.box.file("work/web/node_modules/dep/index.js", "x".repeat(4000));
  return dir;
};

const waitGone = async (path: string) => {
  for (let i = 0; i < 2400 && existsSync(path); i++) await Bun.sleep(25);
};

describeT2("remote stores: a single-device remote round trip", () => {
  for (const kind of REMOTE_KINDS) {
    test(`remote round trip on ${kind}: offload then onload is byte-identical (durability asserted)`, async () => {
      const d = await device("trip-pw");
      const spec: StoreSpec = {
        kind,
        prefix: freshPrefix("trip"),
        semantics: assertedProfile(kind, "durable"),
      };
      d.configure({ [STORE]: spec }, { store: STORE, extra: ["[onload]", "hydrate = false"] });
      d.makeRoot(spec);
      let started = performance.now();
      await bootstrapHere(d);
      timings.push(`bootstrap on ${kind}: ${Math.round(performance.now() - started)} ms`);
      const dir = makeProject(d);
      const before = hashTree(dir, ["node_modules"]);

      started = performance.now();
      const off = await d.cli(["offload", "work:web", "--yes", "--json"]);
      timings.push(`offload on ${kind}: ${Math.round(performance.now() - started)} ms`);
      expect(off.err).toBe("");
      expect(off.code).toBe(0);
      const op = envelope(off.out).data.op as string;
      await waitGone(join(d.box.home, "work/.plainport-trash", op));
      expect(existsSync(dir)).toBe(false);

      started = performance.now();
      const back = await d.cli(["onload", "work:web", "--json"]);
      timings.push(`onload on ${kind}: ${Math.round(performance.now() - started)} ms`);
      expect(back.code).toBe(0);
      expect(envelope(back.out).data).toMatchObject({ snapshot: op });
      expect(compareTrees(before, hashTree(dir, ["node_modules"]))).toEqual([]);
    }, 600_000);
  }

  test("remote round trip on sftp without the durability assertion: the offload commits and keeps its folder", async () => {
    const d = await device("kept-pw");
    const spec: StoreSpec = { kind: "sftp", prefix: freshPrefix("kept") };
    d.configure({ [STORE]: spec }, { store: STORE, extra: ["[onload]", "hydrate = false"] });
    d.makeRoot(spec);
    await bootstrapHere(d);
    const dir = makeProject(d);
    const before = hashTree(dir, []);
    const off = await d.cli(["offload", "work:web", "--yes", "--json"]);
    expect(off.code).toBe(6);
    const refused = (
      envelope(off.out) as unknown as { error: { finding: { code: string; message: string } } }
    ).error.finding;
    expect(refused.code).toBe("store.semantics-unknown");
    expect(refused.message).toContain("durability is acked-unsynced (asserted)");
    expect(compareTrees(before, hashTree(dir, []))).toEqual([]);
    expect(existsSync(`${dir}.plainport`)).toBe(false);
    // Committed: the store holds the offloaded event.
    const store = await opened(d);
    const events = value(await store.blob.list("meta/v1/events/"));
    expect(events.length).toBeGreaterThan(0);
  }, 600_000);
});

describeT2("remote stores: a cut mid-upload", () => {
  for (const kind of REMOTE_KINDS) {
    test(`remote round trip on ${kind}: a cut mid-upload fails before the commit, invariants 1 to 3 hold`, async () => {
      const d = await device("cut-pw", { unreachableAfterMs: 10_000 });
      const spec: StoreSpec = {
        kind,
        prefix: freshPrefix("cut"),
        proxied: true,
        semantics: assertedProfile(kind, "durable"),
      };
      d.configure({ [STORE]: spec }, { store: STORE, extra: ["[onload]", "hydrate = false"] });
      d.makeRoot(spec);
      await bootstrapHere(d);
      const dir = makeProject(d, 24 * 1024 * 1024);
      const before = hashTree(dir, []);
      try {
        await applyProfile(d.env, kind, "latency");
        const running = d.cli(["offload", "work:web", "--yes", "--json"]);
        // The upload has begun once the journal says the snapshot started.
        const journalHas = (step: string) =>
          journalsOf(d).some((name) =>
            readFileSync(join(d.box.paths.journalDir, name), "utf8").includes(`"${step}"`),
          );
        for (let i = 0; i < 2400 && !journalHas("offload.snapshot.start"); i++) await Bun.sleep(25);
        await Bun.sleep(1_500);
        await applyProfile(d.env, kind, "cut");
        const off = await running;
        await applyProfile(d.env, kind, "clear");
        expect(off.code).not.toBe(0);
        const error = (envelope(off.out) as unknown as { error: { finding: { code: string } } }).error;
        expect(error.finding.code).toBe("store.unreachable");
      } finally {
        await applyProfile(d.env, kind, "clear");
      }
      expect(compareTrees(before, hashTree(dir, []))).toEqual([]);
      expect(journalsOf(d)).toEqual([]);
      const store = await opened(d);
      const paths = value(resolvePaths(d.vars));
      const registry = JSON.parse(readFileSync(paths.registryFile, "utf8")) as {
        projects: Record<string, { path: string }>;
      };
      const id = Object.entries(registry.projects).find(([, e]) => e.path === "web")?.[0];
      expect(
        await invariantViolations({
          now: new Date(),
          paths,
          device: (JSON.parse(readFileSync(paths.deviceFile, "utf8")) as { id: string }).id,
          project: { id, dir },
          roots: [join(d.box.home, "work")],
          store: { name: STORE, blob: store.blob, engine: store.engine },
          stripped: ["node_modules"],
        }),
      ).toEqual([]);
    }, 600_000);
  }
});
