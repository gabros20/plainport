// M2 Task 19 on T2: `plainport store add` and `store test` on SFTP (OpenSSH in the container) and S3 (SeaweedFS, D94),
// through the binary's store opener with the real restic and rclone.
//
// - add on a fresh prefix sets the store up (format 2, its own repos/<id>), making an SFTP store's folder first; a
//   re-run adopts it and writes nothing; a second device with the same password adopts it, one with another password
//   records nothing.
// - test writes, reads, lists and deletes one probe key, reports delete allowed, measures read and list after write,
//   and records them in the sidecar under the facts the opener checks, so the opener reads them back.
//
// The stores' properties are asserted in config.toml (the opener reads them, Q8), as Task 18's T2 does, until a
// measurement exists; with an assertion taken out, the opener reads the measured property instead.

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  ConfigLoader,
  readRegistry,
  readStoreState,
  resolvePaths,
  STORE_IDENTITY_KEY,
} from "@plainport/core";
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
import { testHost } from "../../core/src/testing/host.ts";
import { storeFactsOf, storeOpener } from "./stores.ts";

const STORE = "remote";
let rclone: string;
const devices: RemoteDevice[] = [];

const device = async (password: string) => {
  const d = await remoteDevice(password, { rclone });
  devices.push(d);
  return d;
};

const envelope = (out: string) => JSON.parse(out.trim().split("\n").at(-1) as string);

/** The `store add` flags for the store config.toml describes. */
const addArgs = (d: RemoteDevice, spec: StoreSpec): string[] =>
  spec.kind === "sftp"
    ? [
        "--kind",
        "sftp",
        "--host",
        d.env.sftp.alias,
        "--path",
        `${d.env.sftp.root}/${spec.prefix}`,
        "--secret",
        "env:T18_STORE_PASSWORD",
      ]
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

beforeAll(async () => {
  rclone = await rclonePath();
});
afterAll(async () => {
  for (const d of devices) await d.cleanup();
});

for (const kind of REMOTE_KINDS) {
  describeT2(`store add and store test on ${kind}`, () => {
    test(`store add sets a fresh ${kind} store up, adopts it again, and store test measures and records it`, async () => {
      const spec: StoreSpec = { kind, prefix: freshPrefix(`t19-${kind}`) };
      const a = await device("t19-password-a");
      // The store's table and its asserted properties are config.toml's; store add is given the same table.
      a.configure({ [STORE]: spec });
      const add = await a.cli(["store", "add", STORE, ...addArgs(a, spec), "--json"]);
      expect(add.code, add.out + add.err).toBe(0);
      const added = envelope(add.out).data;
      expect(added).toMatchObject({ outcome: "published", format: 2 });
      expect(added.repo).toBe(`repos/${added.id}`);

      const again = await a.cli(["store", "add", STORE, ...addArgs(a, spec), "--json"]);
      expect(again.code, again.out + again.err).toBe(0);
      expect(envelope(again.out).data).toMatchObject({
        id: added.id,
        outcome: "adopted",
        configChanged: false,
      });

      const tested = await a.cli(["store", "test", STORE, "--json"]);
      expect(tested.code, tested.out + tested.err).toBe(0);
      const report = envelope(tested.out).data;
      expect(report).toMatchObject({
        reachable: true,
        delete: "allowed",
        id: added.id,
        format: 2,
        repository: { opens: true },
        recorded: true,
        ok: true,
        losing: [],
        contested: [],
      });
      expect(report.semantics.readAfterWrite).toEqual({ value: true, evidence: "measured" });
      expect(report.semantics.listAfterWrite).toEqual({ value: true, evidence: "measured" });
      // Recorded under the facts the opener checks, so it reads the measurement back.
      const paths = value(resolvePaths(a.vars, { cwd: a.box.home }));
      const loaded = value(await new ConfigLoader(testHost(), paths).load({ env: a.vars }));
      const store = loaded.config.stores[STORE];
      if (store === undefined) throw new Error("no store");
      const state = value(await readStoreState(testHost(), paths, added.id, storeFactsOf(store, paths.home)));
      expect(state.measured?.test).toMatchObject({ ok: true, delete: "allowed" });
      expect(state.measured?.semantics?.readAfterWrite).toEqual({ value: true, evidence: "measured" });
      // With the owner's assertions of the two properties taken out of config, the opener reads the measurement.
      const { readAfterWrite: _r, listAfterWrite: _l, ...rest } = assertedProfile(kind);
      a.configure({ [STORE]: { ...spec, semantics: rest } });
      const reloaded = value(await new ConfigLoader(testHost(), paths).load({ env: a.vars })).config.stores[
        STORE
      ];
      if (reloaded === undefined) throw new Error("no store");
      const blob = await storeOpener(testHost(), a.vars).open(
        STORE,
        reloaded,
        "t19-password-a",
        kind === "s3"
          ? {
              accessKeyId: a.vars.T18_S3_KEY_ID as string,
              secretAccessKey: a.vars.T18_S3_SECRET_KEY as string,
            }
          : undefined,
      );
      const opened = value(blob);
      expect(opened.blob.semantics().readAfterWrite).toEqual({ value: true, evidence: "measured" });
      const identity = value(await opened.blob.get(STORE_IDENTITY_KEY));
      expect(JSON.parse(new TextDecoder().decode(identity as Uint8Array)).id).toBe(added.id);

      // A second device: the same password adopts it; another records nothing.
      const b = await device("t19-password-a");
      b.configure({ [STORE]: spec });
      const adopted = await b.cli(["store", "add", STORE, ...addArgs(b, spec), "--json"]);
      expect(adopted.code, adopted.out + adopted.err).toBe(0);
      expect(envelope(adopted.out).data).toMatchObject({ id: added.id, outcome: "adopted" });
      const c = await device("t19-password-other");
      c.configure({ [STORE]: spec });
      const refused = await c.cli(["store", "add", STORE, ...addArgs(c, spec), "--json"]);
      expect(refused.code).not.toBe(0);
      expect(envelope(refused.out).error.finding.code).toBe("restic.wrong-password");
      const cPaths = value(resolvePaths(c.vars, { cwd: c.box.home }));
      expect(value(await readRegistry(testHost(), cPaths)).stores).toBeUndefined();
    }, 300_000);
  });
}
