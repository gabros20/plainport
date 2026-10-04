// plainport onload, hydrate and dehydrate through the CLI: a sandboxed home set up by init, a project offloaded with
// the fake engine (T0), and fake package managers on PATH that record the install and write a marker, so nothing
// reaches a registry (D13). Invariants 1–3 are checked after each run.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fsBlobStore } from "@plainport/blob-fs";
import { nodeLocalIo } from "@plainport/core";
import { testHost as macosTestHost } from "@plainport/host-macos/testing";
import { z } from "zod";
import { describeT1 } from "../../../../test/tiers.ts";
import { fakeEngine } from "../../../core/src/testing/fake-engine.ts";
import { testHost } from "../../../core/src/testing/host.ts";
import { captureTree, invariantViolations, type TreeCapture } from "../../../core/src/testing/invariants.ts";
import { makeSandbox, type Sandbox } from "../../../core/src/testing/sandbox.ts";
import { gate } from "../gate.ts";
import type { Ports } from "../registry.ts";
import { localStores } from "../stores.ts";
import { capture, fakeRepositoryAt, STORE_PASSWORD, sandboxPorts } from "../testing.ts";
import { REGISTRY } from "./index.ts";

let box: Sandbox;
let bin: string;
let released: TreeCapture | undefined;
const NOW = new Date("2026-10-03T12:00:00Z");
const PATH = process.env.PATH ?? "/usr/bin:/bin";

beforeEach(async () => {
  released = undefined;
  box = makeSandbox("plainport-onload-cli-");
  box.dir("work");
  bin = box.dir("bin");
  const npm = join(bin, "npm");
  writeFileSync(
    npm,
    [
      "#!/bin/sh",
      'echo "$*" >> "$FAKE_PM_LOG"',
      'if [ -n "$FAKE_PM_FAIL" ]; then echo "npm ERR! network request failed (offline)" >&2; exit 1; fi',
      'mkdir -p node_modules/vite && echo "npm $*" > node_modules/.installed-by',
      "",
    ].join("\n"),
  );
  chmodSync(npm, 0o755);
  const run = await cli([
    "init",
    "--root",
    "work=~/work",
    "--store-path",
    "~/ssd",
    "--device",
    "mbp",
    "--yes",
  ]);
  if (run.code !== 0) throw new Error(run.err);
  box.file("work/web/package.json", `${JSON.stringify({ name: "web" })}\n`);
  box.file("work/web/package-lock.json", `${JSON.stringify({ lockfileVersion: 3 })}\n`);
  box.file("work/web/src/main.ts", "x".repeat(1500));
  box.file("work/web/.env", "TOKEN=op://vault/item\n");
  box.file("work/web/node_modules/vite/index.js", "x".repeat(6000));
});
afterEach(() => box.cleanup());

const dir = () => join(box.home, "work/web");
const ssd = () => join(box.home, "ssd");

const ports = (env: Record<string, string> = {}): Ports =>
  sandboxPorts(box.home, {
    clock: { now: () => NOW },
    env: {
      HOME: box.home,
      PATH: `${bin}:${PATH}`,
      PLAINPORT_STORE_PASSWORD: STORE_PASSWORD,
      FAKE_PM_LOG: join(box.home, "pm.log"),
      ...env,
    },
    system: testHost({
      faults: {
        onStep: (step) => {
          if (step === "offload.release.trash") released = captureTree(dir());
        },
      },
    }),
  });
async function cli(argv: string[], env: Record<string, string> = {}) {
  return capture(argv, REGISTRY, { ports: ports(env) });
}
const envelope = (out: string) => JSON.parse(out.trim().split("\n").at(-1) as string);

const expectInvariants = async () => {
  const registry = JSON.parse(readFileSync(box.paths.registryFile, "utf8"));
  const id = Object.entries(registry.projects as Record<string, { path: string }>).find(
    ([, e]) => e.path === "web",
  )?.[0];
  expect(
    await invariantViolations({
      now: NOW,
      paths: box.paths,
      device: JSON.parse(readFileSync(box.paths.deviceFile, "utf8")).id,
      project: { id, dir: dir() },
      roots: [join(box.home, "work")],
      store: {
        name: "local",
        blob: fsBlobStore(nodeLocalIo, ssd()),
        engine: fakeEngine(fakeRepositoryAt(ssd())),
      },
      ...(released === undefined ? {} : { released }),
      stripped: ["node_modules"],
    }),
  ).toEqual([]);
};

const offloaded = async (kept = false): Promise<string> => {
  const run = await cli(["offload", "work:web", "--yes", "--json"]);
  if (run.code !== 0) throw new Error(run.err);
  const op = envelope(run.out).data.op as string;
  for (let i = 0; !kept && i < 1200 && existsSync(join(box.home, "work/.plainport-trash", op)); i++)
    await Bun.sleep(25);
  return op;
};

describe("onload: the command", () => {
  test("onload is safe_write: it runs without --yes; --dry-run is refused (no preview yet)", async () => {
    const verdict = gate(["onload", "work:web"], REGISTRY, { approved: () => false });
    expect(verdict.ok && [verdict.command.risk, verdict.risk]).toEqual(["safe_write", "safe_write"]);
    const dry = await cli(["onload", "work:web", "--dry-run"]);
    expect(dry.code).toBe(2);
  });

  test("restores the project, installs its dependencies and prints the envelope (--json)", async () => {
    const snapshot = await offloaded();
    const run = await cli(["onload", "work:web", "--json"]);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    const lines = run.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({
      plainport_json: 1,
      ok: true,
      verb: "onload",
      data: {
        exitCode: 0,
        project: "work:web",
        snapshot,
        over: snapshot,
        store: "local",
        dir: dir(),
        restored: "restore",
        hydrate: { status: "installed", steps: [{ path: "", command: "npm ci", ok: true }], untrusted: [] },
      },
    });
    expect(lines.filter((l) => l.type === "phase" && l.status === "start").map((l) => l.phase)).toEqual([
      "resolve",
      "preflight",
      "restore",
      "verify",
      "swap",
      "toolchain",
      "hydrate",
    ]);
    expect(readFileSync(join(dir(), "src/main.ts"), "utf8")).toBe("x".repeat(1500));
    expect(readFileSync(join(dir(), ".env"), "utf8")).toBe("TOKEN=op://vault/item\n");
    expect(existsSync(`${dir()}.plainport`)).toBe(false);
    expect(readFileSync(join(box.home, "pm.log"), "utf8")).toBe("ci\n");
    await expectInvariants();
  });

  test("a kept folder renamed back says so: where it came from, why, and why nothing was installed (agent smoke)", async () => {
    writeFileSync(box.paths.configFile, 'version = 1\n[offload]\nkeepLocalFor = "24h"\n');
    const snapshot = await offloaded(true);
    const trash = join(box.home, "work/.plainport-trash", snapshot, "web");
    const run = await cli(["onload", "work:web", "--json"]);
    expect(run.code).toBe(0);
    const schema = REGISTRY.find((c) => c.name === "onload")?.output;
    expect(schema?.safeParse(envelope(run.out).data).success).toBe(true);
    const data = envelope(run.out).data;
    expect(data).toMatchObject({
      restored: "reuse",
      reused: {
        from: trash,
        offload: snapshot,
        reason: `the folder offload ${snapshot} released was still kept (keepLocalFor) and unchanged since it was verified`,
      },
      hydrate: {
        status: "reused",
        steps: [],
        reason:
          "the folder came back with the dependencies it had when it was offloaded, so nothing was installed",
      },
    });
    expect(existsSync(join(box.home, "pm.log"))).toBe(false);
    // The offload's trash, and the trash holder it leaves empty, are gone.
    expect(existsSync(join(box.home, "work/.plainport-trash"))).toBe(false);
    await expectInvariants();
  });

  test("the human output of a reuse names the folder renamed back and says nothing was restored or installed", async () => {
    writeFileSync(box.paths.configFile, 'version = 1\n[offload]\nkeepLocalFor = "24h"\n');
    const snapshot = await offloaded(true);
    const run = await cli(["onload", "work:web"]);
    expect(run.code).toBe(0);
    expect(run.out).toBe(
      [
        `onloaded work:web into ${dir()}: renamed back from ${join(box.home, "work/.plainport-trash", snapshot, "web")}, not restored from the store (the folder offload ${snapshot} released was still kept (keepLocalFor) and unchanged since it was verified)`,
        "dependencies came back with the folder, so nothing was installed",
        "",
      ].join("\n"),
    );
  });

  test("help onload explains restored and reuse", async () => {
    const run = await cli(["help", "onload"]);
    expect(run.out).toContain("keepLocalFor");
    const schema = JSON.stringify(
      z.toJSONSchema(REGISTRY.find((c) => c.name === "onload")?.output ?? z.never()),
    );
    expect(schema).toContain("renamed back");
    expect(schema).toContain('"reason"');
  });

  test("names the project by its stub, and says in one line what came back", async () => {
    await offloaded();
    const run = await cli(["onload", `${dir()}.plainport`]);
    expect(run.code).toBe(0);
    expect(run.out).toMatch(
      /^onloaded work:web from snapshot [0-9A-Z]{26} into .+\/work\/web; dependencies installed \(npm ci\)\n$/,
    );
    await expectInvariants();
  });

  test("a failed install exits 10: the envelope's data names the project and snapshot, the hint is plainport hydrate (D14)", async () => {
    const snapshot = await offloaded();
    const run = await cli(["onload", "work:web", "--json"], { FAKE_PM_FAIL: "1" });
    expect(run.code).toBe(10);
    const env = envelope(run.out);
    expect(env).toMatchObject({
      ok: false,
      verb: "onload",
      error: { code: 10, hint: "plainport hydrate work:web", finding: { code: "hydrate.failed" } },
      data: { exitCode: 10, project: "work:web", snapshot, hydrate: { status: "failed" } },
    });
    expect(existsSync(join(dir(), "src/main.ts"))).toBe(true);
    await expectInvariants();

    // plainport hydrate retries; it succeeds once the install does.
    const again = await cli(["hydrate", "work:web", "--json"]);
    expect(again.code).toBe(0);
    expect(envelope(again.out)).toMatchObject({
      ok: true,
      verb: "hydrate",
      data: { exitCode: 0, project: "work:web", dir: dir(), hydrate: { status: "installed" } },
    });
    expect(existsSync(join(dir(), "node_modules/.installed-by"))).toBe(true);
  });

  test("the human output of exit 10 says the files are back and how to retry", async () => {
    await offloaded();
    const run = await cli(["onload", "work:web"], { FAKE_PM_FAIL: "1" });
    expect(run.code).toBe(10);
    expect(run.out).toMatch(/^restored work:web from snapshot [0-9A-Z]{26} into .+; npm ci failed/);
    expect(run.err).toContain("plainport hydrate work:web");
  });

  test("--no-hydrate restores without installing; --to lands elsewhere", async () => {
    await offloaded();
    // --to's folder must be there; onload makes only the project's own folder.
    const missing = await cli(["onload", "web", "--to", "~/elsewhere/web", "--json"]);
    expect([missing.code, envelope(missing.out).error.finding.code]).toEqual([6, "root.path-missing"]);
    box.dir("elsewhere");
    const run = await cli(["onload", "web", "--no-hydrate", "--to", "~/elsewhere/web", "--json"]);
    expect(run.code).toBe(0);
    expect(envelope(run.out).data).toMatchObject({
      dir: join(box.home, "elsewhere/web"),
      hydrate: { status: "skipped" },
    });
    expect(existsSync(join(box.home, "elsewhere/web/src/main.ts"))).toBe(true);
    expect(existsSync(join(box.home, "pm.log"))).toBe(false);
  });

  test("a restore leaves no empty .plainport-staging in the root (C2)", async () => {
    await offloaded();
    const run = await cli(["onload", "work:web", "--json"]);
    expect([run.code, envelope(run.out).data.restored]).toEqual([0, "restore"]);
    expect(existsSync(join(box.home, "work/.plainport-staging"))).toBe(false);
    await expectInvariants();
  });

  test("a project whose offload stripped nothing ends local after --no-hydrate, and status suggests no hydrate (C4)", async () => {
    rmSync(join(dir(), "node_modules"), { recursive: true });
    await offloaded();
    const run = await cli(["onload", "work:web", "--no-hydrate", "--json"]);
    expect(run.code).toBe(0);
    expect(envelope(run.out).data.hydrate).toMatchObject({
      status: "skipped",
      reason:
        "the offload stripped nothing, so the restored files are the whole folder as it was: nothing to install back",
    });
    const status = envelope((await cli(["status", "work:web", "--json"])).out).data;
    expect(status.state).toBe("local");
    expect(status.next).toBeUndefined();
    await expectInvariants();
  });

  /** The store's offloaded event of `snapshot`, edited in place by `edit`. */
  const editEvent = (snapshot: string, edit: (event: { stats: Record<string, unknown> }) => void) => {
    const folder = join(ssd(), "meta/v1/events");
    for (const name of readdirSync(folder)) {
      const event = JSON.parse(readFileSync(join(folder, name), "utf8"));
      if (event.type !== "offloaded" || event.snapshot !== snapshot) continue;
      edit(event);
      writeFileSync(join(folder, name), `${JSON.stringify(event)}\n`);
      return event;
    }
    throw new Error(`no offloaded event of ${snapshot}`);
  };
  const stateAfterNoHydrate = async () => {
    expect((await cli(["onload", "work:web", "--no-hydrate"])).code).toBe(0);
    return envelope((await cli(["status", "work:web", "--json"])).out).data.state;
  };

  test("a fresh offload that stripped nothing records stats.stripped 0 (D73)", async () => {
    rmSync(join(dir(), "node_modules"), { recursive: true });
    const snapshot = await offloaded();
    expect(editEvent(snapshot, () => {}).stats).toMatchObject({ stripped: 0, strippedBytes: 0 });
  });

  test("an event without stats.stripped (an older writer, or recover's rebuilt fork) stays restored-unhydrated (D73)", async () => {
    rmSync(join(dir(), "node_modules"), { recursive: true });
    const snapshot = await offloaded();
    // The shape recover writes for a lost fork event: what was stripped is unknown.
    editEvent(snapshot, (event) => {
      delete event.stats.stripped;
      event.stats.ecosystems = [];
    });
    expect(await stateAfterNoHydrate()).toBe("restored-unhydrated");
  });

  test("a strip set of only empty folders and zero-byte files still counts as stripped: restored-unhydrated (D73)", async () => {
    rmSync(join(dir(), "node_modules"), { recursive: true });
    box.dir("work/web/node_modules/.bin");
    box.file("work/web/node_modules/.package-lock.json", "");
    const snapshot = await offloaded();
    expect(editEvent(snapshot, () => {}).stats).toMatchObject({ stripped: 1, strippedBytes: 0 });
    expect(await stateAfterNoHydrate()).toBe("restored-unhydrated");
  });

  test("a project whose offload stripped its dependencies stays restored-unhydrated after --no-hydrate (C4)", async () => {
    await offloaded();
    expect((await cli(["onload", "work:web", "--no-hydrate"])).code).toBe(0);
    const status = envelope((await cli(["status", "work:web", "--json"])).out).data;
    expect([status.state, status.next?.command]).toEqual([
      "restored-unhydrated",
      "plainport hydrate work:web",
    ]);
  });

  test("an occupied target exits 6 with path.occupied, and the hint names --to", async () => {
    await offloaded();
    box.file("work/web/other.txt", "hello\n");
    const run = await cli(["onload", "work:web", "--json"]);
    expect(run.code).toBe(6);
    expect(envelope(run.out).error).toMatchObject({ code: 6, finding: { code: "path.occupied" } });
    expect(envelope(run.out).error.hint).toContain("--to");
  });

  test("--snapshot names an older snapshot; an unknown one exits 4", async () => {
    await offloaded();
    const run = await cli(["onload", "work:web", "--snapshot", "01M40X7EC1DTXN87AJ4SH74DK6", "--json"]);
    expect(run.code).toBe(4);
    expect(envelope(run.out).error.finding.code).toBe("snapshot.not-found");
  });
});

describe("dehydrate: the command", () => {
  test("removes the installed dependencies and nothing else; hydrate puts them back", async () => {
    const run = await cli(["dehydrate", "work:web", "--json"]);
    expect(run.code).toBe(0);
    expect(envelope(run.out).data).toMatchObject({
      project: "work:web",
      dir: dir(),
      removed: [{ path: "node_modules", bytes: 6000 }],
      freedBytes: 6000,
    });
    expect(existsSync(join(dir(), "node_modules"))).toBe(false);
    expect(existsSync(join(dir(), ".env"))).toBe(true);
    const human = await cli(["hydrate", "work:web"]);
    expect(human.code).toBe(0);
    expect(human.out).toBe("installed the dependencies of work:web (npm ci)\n");
  });

  test("dehydrate and hydrate are safe_write: no --yes needed", () => {
    for (const verb of ["dehydrate", "hydrate"]) {
      const verdict = gate([verb, "work:web"], REGISTRY, { approved: () => false });
      expect(verdict.ok && verdict.command.risk).toBe("safe_write");
    }
  });
});

describeT1("onload with the real restic on a temp external-disk store", () => {
  test("offload then onload is byte-identical minus stripped paths: contents, modes and links, verified by restic's own listing", async () => {
    const host = macosTestHost({
      faults: {
        onStep: (step) => {
          if (step === "offload.release.trash") released = captureTree(dir());
        },
      },
    });
    const env = {
      HOME: box.home,
      PATH: `${bin}:${PATH}`,
      PLAINPORT_STORE_PASSWORD: "t1-pw",
      FAKE_PM_LOG: join(box.home, "pm.log"),
    };
    const real = (): Ports => ({
      ...ports(),
      env,
      system: host,
      io: host,
      stores: localStores(host, env),
    });
    const run = (argv: string[]) => capture(argv, REGISTRY, { ports: real() });
    expect((await run(["init", "--store-path", "~/t1-ssd", "--store", "t1", "--yes", "--json"])).code).toBe(
      0,
    );
    box.file("work/web/bin/run.sh", "#!/bin/sh\necho hi\n");
    chmodSync(join(dir(), "bin/run.sh"), 0o755);
    box.file("work/web/docs/frozen.txt", "read only\n");
    chmodSync(join(dir(), "docs/frozen.txt"), 0o444);
    symlinkSync("src/main.ts", join(dir(), "link"));
    symlinkSync("../outside/target", join(dir(), "dangling"));
    const before = treeOf(dir());
    const rootMode = lstatSync(dir()).mode & 0o7777;
    const off = await run(["offload", "work:web", "--store", "t1", "--yes", "--json"]);
    expect(off.code).toBe(0);
    const op = envelope(off.out).data.op as string;
    for (let i = 0; i < 1200 && existsSync(join(box.home, "work/.plainport-trash", op)); i++)
      await Bun.sleep(25);
    expect(existsSync(dir())).toBe(false);

    const back = await run(["onload", "work:web", "--store", "t1", "--json"]);
    expect(back.err).toBe("");
    expect(back.code).toBe(0);
    expect(envelope(back.out).data).toMatchObject({
      snapshot: op,
      restored: "restore",
      hydrate: { status: "installed" },
    });
    expect(treeOf(dir())).toEqual(before);
    // restic would make the folder it restores into 0700; plainport makes it, with a new folder's mode.
    expect((lstatSync(dir()).mode & 0o7777).toString(8)).toBe(rootMode.toString(8));
    const opened = await localStores(host, env).open(
      "t1",
      { kind: "local", path: join(box.home, "t1-ssd") },
      "t1-pw",
    );
    if (!opened.ok) throw new Error(opened.finding.message);
    const registry = JSON.parse(readFileSync(box.paths.registryFile, "utf8"));
    const id = Object.entries(registry.projects as Record<string, { path: string }>).find(
      ([, e]) => e.path === "web",
    )?.[0];
    expect(
      await invariantViolations({
        now: NOW,
        paths: box.paths,
        device: JSON.parse(readFileSync(box.paths.deviceFile, "utf8")).id,
        project: { id, dir: dir() },
        roots: [join(box.home, "work")],
        store: { name: "t1", blob: fsBlobStore(host, join(box.home, "t1-ssd")), engine: opened.value.engine },
        stripped: ["node_modules"],
      }),
    ).toEqual([]);
  }, 120_000);
});

/** Every entry below a folder: type, mode, link target and content hash; node_modules left out. */
const treeOf = (root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (relative: string) => {
    for (const name of readdirSync(relative === "" ? root : join(root, relative)).sort()) {
      const path = relative === "" ? name : `${relative}/${name}`;
      if (path === "node_modules") continue;
      const full = join(root, path);
      const stat = lstatSync(full);
      const mode = (stat.mode & 0o7777).toString(8);
      if (stat.isSymbolicLink()) out[path] = `link ${readlinkSync(full)}`;
      else if (stat.isDirectory()) {
        out[path] = `dir ${mode}`;
        walk(path);
      } else out[path] = `file ${mode} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
    }
  };
  walk("");
  return out;
};
