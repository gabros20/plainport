// T1: the rclone blob store against the real pinned rclone on its `local` backend (ADR-0018), which runs the same
// temp-then-rename path as SFTP. `bun run test:t1 -t blob-rclone` runs it.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "@plainport/contract";
import {
  type HostPorts,
  InjectedFault,
  type RunSpec,
  runProcess,
  type StoreSemantics,
  toolPath,
} from "@plainport/core";
import { describeT1 } from "../../../test/tiers.ts";
import { posixSpawner } from "../../core/src/spawner.ts";
import { ALL_ELIGIBLE, blobStoreContract } from "../../core/src/testing/blob-store-contract.ts";
import { expectNoCanary, makeCanary, recordArgv } from "../../core/src/testing/canary.ts";
import { testHost } from "../../core/src/testing/host.ts";
import { makeSandbox, type Sandbox } from "../../core/src/testing/sandbox.ts";
import { RCLONE_REMOTE, type RcloneBlobStoreOptions, rcloneBlobStore, TEMP_PREFIX } from "./rclone-store.ts";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

const rclonePath = async (): Promise<string> => {
  const found = await toolPath(testHost(), "rclone", { env: {} });
  if (!found.ok) throw new Error(found.finding.message);
  return found.value.path;
};

/** What this adapter supplies on rclone's local backend, asserted for the contract's probe to check. */
const LOCAL_PROFILE: StoreSemantics = {
  readAfterWrite: { value: true, evidence: "asserted" },
  listAfterWrite: { value: true, evidence: "asserted" },
  listComplete: { value: true, evidence: "asserted" },
  publication: { value: "temp-then-rename", evidence: "asserted" },
  conditionalCreate: { value: false, evidence: "asserted" },
  // rclone's local backend does not fsync what it writes.
  durability: { value: "acked-unsynced", evidence: "asserted" },
  cancellation: { value: "never-lands-late", evidence: "asserted" },
};

interface World {
  sandbox: Sandbox;
  root: string;
  options: RcloneBlobStoreOptions;
}

const world = async (patch: Partial<RcloneBlobStoreOptions> = {}): Promise<World> => {
  const sandbox = makeSandbox("plainport-rclone-");
  const root = sandbox.dir("store");
  const options: RcloneBlobStoreOptions = {
    host: testHost(),
    rclone: await rclonePath(),
    remote: { type: "local", root },
    paths: sandbox.paths,
    env: { HOME: sandbox.home, PATH: "/usr/bin:/bin", TMPDIR: sandbox.dir("tmp") },
    ...patch,
  };
  return { sandbox, root, options };
};

const keysUnder = (dir: string, prefix = ""): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? keysUnder(join(dir, entry.name), `${prefix}${entry.name}/`)
          : [`${prefix}${entry.name}`],
      )
    : [];

describeT1("blob-rclone on rclone's local backend", () => {
  blobStoreContract(
    "rclone-local, unmeasured",
    async () => {
      const w = await world();
      return { store: rcloneBlobStore(w.options), cleanup: () => w.sandbox.cleanup() };
    },
    {
      eligibility: {
        read: "eligible",
        append: "refused",
        elect: "refused",
        commit: "refused",
        release: "refused",
      },
    },
  );

  blobStoreContract(
    "rclone-local, with what the adapter supplies there",
    async () => {
      const w = await world({ semantics: LOCAL_PROFILE });
      return { store: rcloneBlobStore(w.options), cleanup: () => w.sandbox.cleanup() };
    },
    {
      eligibility: { ...ALL_ELIGIBLE, release: "post-grace-proof" },
      // Every write is two rclone runs: the listing probe keeps to a few dozen keys.
      listProbeKeys: 30,
      probeTimeout: 120_000,
    },
  );

  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.sandbox.cleanup());

  test("a poisoned rclone.conf, or rclone settings in this process's environment, are never used", async () => {
    // copy_links makes rclone follow a symlink, which it otherwise skips: a listing that shows it read the poison.
    const poison = `[${RCLONE_REMOTE}]\ntype = local\ncopy_links = true\n`;
    const conf = w.sandbox.file(".config/rclone/rclone.conf", poison);
    mkdirSync(join(w.root, "meta"), { recursive: true });
    writeFileSync(join(w.sandbox.home, "target"), "poisoned\n");
    symlinkSync(join(w.sandbox.home, "target"), join(w.root, "meta", "link"));
    writeFileSync(join(w.root, "meta", "real"), "real\n");

    // The signal works: rclone reading that file does follow the link.
    const direct = value(
      await w.options.host.run({
        command: w.options.rclone,
        args: ["-q", "lsjson", "-R", "--files-only", `${RCLONE_REMOTE}:${w.root}`],
        cwd: "/",
        env: { HOME: w.sandbox.home, RCLONE_CONFIG: conf, [`RCLONE_CONFIG_${RCLONE_REMOTE}_TYPE`]: "local" },
      }),
    );
    expect(direct.stdout.text).toContain('"link"');

    const store = rcloneBlobStore({
      ...w.options,
      env: {
        ...w.options.env,
        RCLONE_CONFIG: conf,
        [`RCLONE_CONFIG_${RCLONE_REMOTE}_COPY_LINKS`]: "true",
        RCLONE_LOCAL_COPY_LINKS: "true",
        RCLONE_COPY_LINKS: "true",
      },
    });
    expect(value(await store.list("")).map((e) => e.key)).toEqual(["meta/real"]);
    expect(new TextDecoder().decode(value(await store.get("meta/real")) ?? undefined)).toBe("real\n");
  });

  test("an observer listing events/ during a slow upload never sees the key before it is whole", async () => {
    const store = rcloneBlobStore({ ...w.options, bwlimit: "1M" });
    const data = new Uint8Array(1536 * 1024).fill(42);
    const key = "meta/v1/events/01J00000000000000000000000.json";
    let done = false;
    let sawTemporary = false;
    const seen: number[] = [];
    const observer = (async () => {
      while (!done) {
        if (keysUnder(join(w.root, "meta/v1/tmp")).length > 0) sawTemporary = true;
        for (const entry of value(await store.list("meta/v1/events/"))) {
          seen.push(entry.size);
          const bytes = value(await store.get(entry.key));
          if (bytes !== null) seen.push(bytes.length);
        }
      }
    })();
    try {
      value(await store.put(key, data));
    } finally {
      done = true;
      await observer;
    }
    expect(sawTemporary).toBe(true); // the upload was slow enough to be watched
    expect(seen.every((size) => size === data.length)).toBe(true);
    expect(value(await store.get(key))?.length).toBe(data.length);
    expect(keysUnder(join(w.root, "meta/v1/tmp"))).toEqual([]);
  }, 60_000);

  for (const [at, expected] of [
    ["rclone.put.uploaded", "nothing under events/"],
    ["rclone.put.moved", "the whole event"],
  ] as const) {
    test(`a crash at ${at} leaves ${expected} and at most one temporary, which the sweep removes`, async () => {
      const host: HostPorts = testHost({ faults: { at } });
      const store = rcloneBlobStore({ ...w.options, host });
      const key = "meta/v1/events/01J00000000000000000000000.json";
      const data = new TextEncoder().encode('{"v":1}\n');
      await expect(store.put(key, data)).rejects.toBeInstanceOf(InjectedFault);

      const after = rcloneBlobStore(w.options);
      const events = value(await after.list("meta/v1/events/"));
      if (at === "rclone.put.uploaded") expect(events).toEqual([]);
      else expect(new TextDecoder().decode(value(await after.get(key)) ?? undefined)).toBe('{"v":1}\n');
      const temporaries = keysUnder(join(w.root, "meta/v1/tmp"));
      expect(temporaries.length).toBeLessThanOrEqual(1);

      // A fresh temporary is not swept (another device's put may be in flight); an old one is: seen from a clock
      // past the sweep's floor (one call's deadline plus clock skew).
      expect(value(await after.sweepTemporaries(after.minSweepAgeMs)).swept).toEqual([]);
      const base = testHost();
      const later = rcloneBlobStore({
        ...w.options,
        host: {
          ...base,
          clock: { ...base.clock, now: () => new Date(Date.now() + after.minSweepAgeMs + 60_000) },
        },
      });
      const swept = value(await later.sweepTemporaries(later.minSweepAgeMs)).swept;
      expect(swept).toEqual(temporaries.map((name) => `${TEMP_PREFIX}${name}`));
      expect(keysUnder(join(w.root, "meta/v1/tmp"))).toEqual([]);
      expect(value(await after.list("meta/v1/events/")).length).toBe(at === "rclone.put.uploaded" ? 0 : 1);
    }, 30_000);
  }

  test("getMany reads every key there in one copy, leaves out the missing, and cleans its temp folder", async () => {
    const store = rcloneBlobStore(w.options);
    const keys = ["meta/v1/store.json", "meta/v1/events/01.json", "meta/v1/events/02.json"];
    for (const key of keys) value(await store.put(key, new TextEncoder().encode(`${key}\n`)));
    const got = value(await store.getMany([...keys, "meta/v1/events/missing.json"]));
    expect([...got.keys()].sort()).toEqual([...keys].sort());
    for (const key of keys) expect(new TextDecoder().decode(got.get(key))).toBe(`${key}\n`);
    expect(keysUnder(join(w.sandbox.paths.cacheDir, "rclone", "get"))).toEqual([]);
  }, 30_000);

  test("the canary: a secret in the remote's options reaches neither argv nor an error", async () => {
    const canary = makeCanary("rclone");
    const recording = recordArgv(posixSpawner);
    const host: HostPorts = {
      ...testHost(),
      run: (spec: RunSpec) => runProcess(recording.spawner, spec),
    };
    const readOnly = w.sandbox.dir("read-only");
    const store = rcloneBlobStore({
      ...w.options,
      host,
      remote: { type: "local", root: readOnly, secrets: { pass: canary.value } },
    });
    const { chmodSync } = await import("node:fs");
    chmodSync(readOnly, 0o500);
    const findings: unknown[] = [];
    try {
      for (const result of [
        await store.put("meta/v1/events/a.json", new Uint8Array([1])),
        await store.get("meta/v1/events/a.json"),
        await store.list(""),
        await store.delete("meta/v1/events/a.json"),
      ]) {
        if (!result.ok) findings.push(result.finding);
      }
    } finally {
      chmodSync(readOnly, 0o700);
    }
    expect(findings.length).toBeGreaterThan(0);
    expect(recording.argv.length).toBeGreaterThan(0);
    expectNoCanary([canary], { argv: recording.argv, findings });
  }, 30_000);
});
