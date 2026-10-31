// M2 Task 20 on T2: sealed catalogs on SFTP (OpenSSH in the container) and S3 (SeaweedFS, D94), through the binary's
// store opener with the real restic and rclone.
//
// - sealed by default: `store add` publishes a sealed catalog for a remote store; the bytes under meta/v1/events/
//   are seal envelopes holding no project ULID, path or root key; `ls` sees the seal before it has the key and reads
//   the store live once the secret is resolved (D108); an onload round-trips byte-identical.
// - an empty-mirror recover at every commit boundary (Task 11's rows on a real store): the offload or onload is
//   killed at the step, this device's mirror is deleted, and `plainport recover` settles it from the sealed store
//   alone, as it would on a plain one: rolled back before the event is on the store, finished after.

import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigLoader, ensureDevice, eventMirrorDir, type OpenedStore } from "@plainport/core";
import { compareTrees, hashTree } from "../../../scripts/tree-compare.ts";
import {
  assertedProfile,
  freshPrefix,
  REMOTE_KINDS,
  type RemoteDevice,
  remoteDevice,
  type StoreSpec,
  value,
} from "../../../test/support/remote-device.ts";
import { beforeAllT2, describeT2 } from "../../../test/tiers.ts";
import { rclonePath } from "../../blob-rclone/src/testing/t2.ts";
import { looksSealed } from "../../core/src/catalog/seal.ts";
import { testHost } from "../../core/src/testing/host.ts";
import { storeOpener } from "./stores.ts";

const STORE = "remote";
const PROJECT = "webshop-frontend";
let rclone: string;
const devices: RemoteDevice[] = [];
const timings: string[] = [];

const envelope = (out: string) => JSON.parse(out.trim().split("\n").at(-1) as string);

const device = async (password: string) => {
  const d = await remoteDevice(password, { rclone });
  devices.push(d);
  value(await ensureDevice(testHost(), d.box.paths, { role: "owner", name: "mbp" }));
  return d;
};

/** The `store add` flags for the store config.toml describes (references only). */
const addArgs = (d: RemoteDevice, spec: StoreSpec): string[] =>
  spec.kind === "sftp"
    ? ["--kind", "sftp", "--host", d.env.sftp.alias, "--path", `${d.env.sftp.root}/${spec.prefix}`].concat([
        "--secret",
        "env:T18_STORE_PASSWORD",
      ])
    : [
        "--kind",
        "s3",
        "--endpoint",
        d.env.s3.endpoint,
        "--bucket",
        d.env.s3.bucket,
        "--path",
        spec.prefix,
        "--region",
        d.env.s3.region,
        "--secret",
        "env:T18_STORE_PASSWORD",
        "--access-key-id",
        "env:T18_S3_KEY_ID",
        "--secret-access-key",
        "env:T18_S3_SECRET_KEY",
      ];

/** The S3 key pair `d`'s config references, read from its environment as core's env: provider would. */
const keyPairOf = (d: RemoteDevice) => {
  const [accessKeyId, secretAccessKey] = ["T18_S3_KEY_ID", "T18_S3_SECRET_KEY"].map(
    (name) => d.vars[name] ?? "",
  );
  return { accessKeyId: accessKeyId as string, secretAccessKey: secretAccessKey as string };
};

/** The store as `d`'s opener reaches it, for reading its raw bytes from outside the CLI. */
const opened = async (d: RemoteDevice): Promise<OpenedStore> => {
  const loaded = value(await new ConfigLoader(testHost(), d.box.paths).load({ env: d.vars }));
  const store = loaded.config.stores[STORE];
  if (store === undefined) throw new Error(`no store ${STORE}`);
  return value(
    await storeOpener(testHost(), d.vars).open(
      STORE,
      store,
      d.vars.T18_STORE_PASSWORD as string,
      store.kind === "s3" ? keyPairOf(d) : undefined,
    ),
  );
};

/** Every event file on the store, as its transport bytes. */
const storeEvents = async (d: RemoteDevice): Promise<Uint8Array[]> => {
  const store = await opened(d);
  const keys = value(await store.blob.list("meta/v1/events/"));
  const out: Uint8Array[] = [];
  for (const entry of keys) {
    const bytes = value(await store.blob.get(entry.key));
    if (bytes !== null) out.push(bytes);
  }
  return out;
};

/** A sealed remote store set up by `store add` (its default for the kind), and the work root sending snapshots there. */
const sealedStore = async (d: RemoteDevice, kind: StoreSpec["kind"]) => {
  const spec: StoreSpec = {
    kind,
    prefix: freshPrefix(`t20-${kind}`),
    semantics: assertedProfile(kind, "durable"),
  };
  // No conflict grace (Q16): the durable store releases as M1 did, so a trash goes at once.
  d.configure(
    { [STORE]: spec },
    { store: STORE, extra: ["[onload]", "hydrate = false", "[offload]", 'conflictGrace = "0"'] },
  );
  const started = performance.now();
  const add = await d.cli(["store", "add", STORE, ...addArgs(d, spec), "--json"]);
  timings.push(`store add (sealed) on ${kind}: ${Math.round(performance.now() - started)} ms`);
  expect(add.code, add.out + add.err).toBe(0);
  const added = envelope(add.out).data as { id: string; sealed: boolean; outcome: string };
  expect([added.outcome, added.sealed]).toEqual(["published", true]);
  return added;
};

const makeProject = (d: RemoteDevice): string => {
  const dir = d.box.dir(`work/${PROJECT}`);
  d.box.file(`work/${PROJECT}/package.json`, `${JSON.stringify({ name: PROJECT })}\n`);
  d.box.file(`work/${PROJECT}/src/main.ts`, "export const main = 1;\n");
  d.box.file(`work/${PROJECT}/.env`, "TOKEN=op://vault/item\n");
  writeFileSync(join(dir, "blob.bin"), crypto.getRandomValues(new Uint8Array(16 * 1024)));
  return dir;
};

const waitGone = async (path: string) => {
  for (let i = 0; i < 2400 && existsSync(path); i++) await Bun.sleep(25);
};

const registryOf = (d: RemoteDevice) =>
  JSON.parse(readFileSync(d.box.paths.registryFile, "utf8")) as {
    projects: Record<string, unknown>;
    roots?: Record<string, string>;
  };

const stateOf = async (d: RemoteDevice): Promise<{ state: string; stale: boolean } | undefined> => {
  const ls = await d.cli(["ls", "--json"]);
  expect(ls.code, ls.out + ls.err).toBe(0);
  return (envelope(ls.out).data.projects as { address: string; state: string; stale: boolean }[]).find(
    (p) => p.address === `work:${PROJECT}`,
  );
};

beforeAllT2(async () => {
  rclone = await rclonePath();
});
afterAll(async () => {
  for (const d of devices) await d.cleanup();
  if (timings.length > 0) process.stdout.write(`${timings.join("\n")}\n`);
});

describeT2("sealed stores: sealed by default, nothing readable on the store", () => {
  for (const kind of REMOTE_KINDS) {
    test(`sealed on ${kind}: the bytes under meta/v1/events/ hold no project ULID, path or root key; ls and onload read them`, async () => {
      const d = await device(`t20-${kind}-pw`);
      const added = await sealedStore(d, kind);
      const dir = makeProject(d);
      const before = hashTree(dir, []);
      const off = await d.cli(["offload", `work:${PROJECT}`, "--yes", "--json"]);
      expect(off.code, off.out + off.err).toBe(0);
      const op = envelope(off.out).data.op as string;
      await waitGone(join(d.box.home, "work/.plainport-trash", op));

      const registry = registryOf(d);
      const projectId = Object.keys(registry.projects)[0] as string;
      const rootId = registry.roots?.work as string;
      expect(projectId).toMatch(/^[0-9A-Z]{26}$/);
      const events = await storeEvents(d);
      expect(events.length).toBeGreaterThan(0);
      for (const bytes of events) {
        expect(looksSealed(bytes)).toBe(true);
        const text = new TextDecoder().decode(bytes);
        for (const plain of [projectId, rootId, PROJECT, "work", d.box.home, added.id])
          expect(text, `an event file names ${plain}`).not.toContain(plain);
      }

      // ls opens the store with no password, sees the seal in its identity, resolves the secret, then reads it live.
      const listed = await stateOf(d);
      expect([listed?.state, listed?.stale]).toEqual(["shelved", false]);
      const stores = envelope((await d.cli(["store", "list", "--json"])).out).data.stores as {
        name: string;
        sealed?: boolean;
      }[];
      expect(stores.find((s) => s.name === STORE)?.sealed).toBe(true);

      const back = await d.cli(["onload", `work:${PROJECT}`, "--json"]);
      expect(back.code, back.out + back.err).toBe(0);
      expect(compareTrees(before, hashTree(dir, []))).toEqual([]);
    }, 600_000);
  }
});

/**
 * Each commit boundary: the step a crash stops at, and where recover settles the project from the store alone: here
 * (rolled back before its offload's event is on the store, or an onload finished) or shelved (an offload finished).
 */
const ROWS = [
  ["offload", "offload.snapshot.done", "here"],
  ["offload", "offload.commit.start", "here"],
  ["offload", "offload.commit.appended", "shelved"],
  ["offload", "offload.committed", "shelved"],
  ["onload", "onload.commit.start", "here"],
  ["onload", "onload.commit.appended", "here"],
  ["onload", "onload.committed", "here"],
] as const;

/** Here: the folder is in place and the catalog does not call it shelved; shelved: the reverse. */
const whereIs = async (d: RemoteDevice, dir: string): Promise<"here" | "shelved" | string> => {
  const view = await stateOf(d);
  if (existsSync(dir) && view?.state !== "shelved") return "here";
  if (!existsSync(dir) && view?.state === "shelved") return "shelved";
  return `folder ${existsSync(dir) ? "present" : "absent"}, state ${view?.state}`;
};

describeT2("sealed stores: an empty-mirror recover at every commit boundary", () => {
  for (const kind of REMOTE_KINDS) {
    test(`sealed on ${kind}: a crash at each commit boundary, the mirror deleted, then recover settles it from the store`, async () => {
      const d = await device(`t20-crash-${kind}-pw`);
      const added = await sealedStore(d, kind);
      const dir = makeProject(d);
      const problems: string[] = [];
      for (const [verb, step, settles] of ROWS) {
        // The project as the row needs it: here for an offload, shelved for an onload.
        const wanted = verb === "offload" ? "here" : "shelved";
        if ((await whereIs(d, dir)) !== wanted) {
          const move = await d.cli(
            wanted === "shelved"
              ? ["offload", `work:${PROJECT}`, "--yes", "--json"]
              : ["onload", `work:${PROJECT}`, "--json"],
          );
          if (move.code !== 0) {
            problems.push(`${step}: could not make the project ${wanted}: ${move.out}${move.err}`);
            continue;
          }
          const op = envelope(move.out).data.op as string | undefined;
          if (op !== undefined) await waitGone(join(d.box.home, "work/.plainport-trash", op));
        }
        const argv =
          verb === "offload"
            ? ["offload", `work:${PROJECT}`, "--yes", "--json"]
            : ["onload", `work:${PROJECT}`, "--json"];
        const crashed = await d.cli(argv, { system: testHost({ faults: { at: step } }) });
        if (crashed.code === 0) {
          problems.push(`${step}: the ${verb} was not stopped at the step`);
          continue;
        }
        rmSync(eventMirrorDir(d.box.paths, added.id), { recursive: true, force: true });
        const recovered = await d.cli(["recover", "--json"]);
        if (recovered.code !== 0) {
          problems.push(`${step}: recover exited ${recovered.code}: ${recovered.out}${recovered.err}`);
          continue;
        }
        const ops = (envelope(recovered.out).data.operations ?? []) as { op: string }[];
        for (const { op } of ops) await waitGone(join(d.box.home, "work/.plainport-trash", op));
        const settled = await whereIs(d, dir);
        if (settled !== settles)
          problems.push(`${step}: recover left the project ${settled}, not ${settles}`);
        const again = await d.cli(["recover", "--json"]);
        const operations = (envelope(again.out).data.operations ?? []) as unknown[];
        if (again.code !== 0 || operations.length !== 0)
          problems.push(`${step}: a second recover had work to do: ${again.out}`);
        const events = await storeEvents(d);
        if (!events.every((bytes) => looksSealed(bytes)))
          problems.push(`${step}: a plaintext event is on the sealed store`);
      }
      expect(problems).toEqual([]);
    }, 1_800_000);
  }
});
