// status, ls, recover, gc and restore through the CLI: a sandboxed home set up by init, projects offloaded with the
// fake engine (T0), --json output checked against each command's declared schema, crashes made with the host's
// fault seam, and invariants 1–3 checked after every run that changes a project.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fsBlobStore } from "@plainport/blob-fs";
import { parseJsonLines } from "@plainport/contract";
import { nodeLocalIo } from "@plainport/core";
import { fakeEngine } from "../../../core/src/testing/fake-engine.ts";
import { testHost } from "../../../core/src/testing/host.ts";
import { captureTree, invariantViolations, type TreeCapture } from "../../../core/src/testing/invariants.ts";
import { makeSandbox, type Sandbox } from "../../../core/src/testing/sandbox.ts";
import { gate } from "../gate.ts";
import type { Ports } from "../registry.ts";
import { capture, fakeRepositoryAt, STORE_PASSWORD, sandboxPorts } from "../testing.ts";
import { REGISTRY } from "./index.ts";

let box: Sandbox;
/** Each project folder as it stood when a release began, by its path under work/. */
const released = new Map<string, TreeCapture>();
const NOW = new Date("2026-10-03T12:00:00Z");
const PATH = process.env.PATH ?? "/usr/bin:/bin";

const dir = () => join(box.home, "work/web");
const ssd = () => join(box.home, "ssd");

const ports = (faults: { at?: string } = {}, now = NOW): Ports =>
  sandboxPorts(box.home, {
    clock: { now: () => now },
    env: { HOME: box.home, PATH, PLAINPORT_STORE_PASSWORD: STORE_PASSWORD },
    system: testHost({
      faults: {
        ...faults,
        onStep: (step) => {
          if (step !== "offload.release.trash") return;
          for (const path of ["web", "api"]) {
            const folder = join(box.home, "work", path);
            if (existsSync(folder)) released.set(path, captureTree(folder));
          }
        },
      },
    }),
  });
const cli = (argv: string[], faults: { at?: string } = {}, now = NOW) =>
  capture(argv, REGISTRY, { ports: ports(faults, now) });
const envelope = (out: string) => JSON.parse(out.trim().split("\n").at(-1) as string);
const command = (name: string) => REGISTRY.find((c) => c.name === name);

/** The --json output checked against the command's declared output schema. */
const data = (name: string, out: string) => {
  const schema = command(name)?.output;
  if (schema === undefined) throw new Error(`no command ${name}`);
  const parsed = parseJsonLines(out, schema);
  if (!parsed.ok) throw new Error(parsed.finding.message);
  return envelope(out).data;
};

beforeEach(async () => {
  released.clear();
  box = makeSandbox("plainport-status-cli-");
  box.dir("work");
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
  box.file("work/web/src/main.ts", "export const main = 1;\n");
  box.file("work/api/package.json", `${JSON.stringify({ name: "api" })}\n`);
  box.file("work/api/README.md", "# api\n");
});
afterEach(() => box.cleanup());

const projectId = (path: string) => {
  const registry = JSON.parse(readFileSync(box.paths.registryFile, "utf8"));
  return Object.entries(registry.projects as Record<string, { path: string }>).find(
    ([, e]) => e.path === path,
  )?.[0];
};

const expectInvariants = async (path = "web") =>
  expect(
    await invariantViolations({
      paths: box.paths,
      device: JSON.parse(readFileSync(box.paths.deviceFile, "utf8")).id,
      project: { id: projectId(path), dir: join(box.home, "work", path) },
      roots: [join(box.home, "work")],
      store: {
        name: "local",
        blob: fsBlobStore(nodeLocalIo, ssd()),
        engine: fakeEngine(fakeRepositoryAt(ssd())),
      },
      ...(released.has(path) ? { released: released.get(path) } : {}),
      stripped: ["node_modules"],
    }),
  ).toEqual([]);

const settle = async () => {
  for (
    let i = 0;
    i < 400 && existsSync(box.paths.journalDir) && readdirSync(box.paths.journalDir).length > 0;
    i++
  )
    await Bun.sleep(25);
};

const offloaded = async (project = "work:api") => {
  const run = await cli(["offload", project, "--yes", "--json"]);
  if (run.code !== 0) throw new Error(run.err);
  await settle();
  return envelope(run.out).data.op as string;
};

describe("status and ls: the commands", () => {
  test("status and ls are read; recover, gc and restore are safe_write; gc --now is confirm", () => {
    const risk = (argv: string[]) => {
      const verdict = gate(argv, REGISTRY, { approved: () => false });
      return verdict.ok ? verdict.risk : verdict.failure.finding.code;
    };
    expect(risk(["status", "web"])).toBe("read");
    expect(risk(["ls"])).toBe("read");
    expect(risk(["recover"])).toBe("safe_write");
    expect(risk(["gc"])).toBe("safe_write");
    expect(risk(["gc", "--now"])).toBe("risk.needs-yes");
    expect(risk(["gc", "--now", "--yes"])).toBe("confirm");
    expect(risk(["restore", "web", "--to", "/tmp/x"])).toBe("safe_write");
  });
});

describe("ls: every project with its state", () => {
  test("a local and a shelved project, filtered by --local, --shelved and --root, sorted by --sort", async () => {
    await cli(["root", "scan", "work"]);
    const snapshot = await offloaded();
    const all = data("ls", (await cli(["ls", "--json"])).out);
    expect(all.projects.map((p: { address: string; state: string }) => [p.address, p.state])).toEqual([
      ["work:api", "shelved"],
      ["work:web", "local"],
    ]);
    expect(all.projects[0]).toMatchObject({ head: snapshot, stale: false, here: false });
    expect(data("ls", (await cli(["ls", "--shelved", "--json"])).out).projects).toHaveLength(1);
    expect(
      data("ls", (await cli(["ls", "--local", "--json"])).out).projects.map(
        (p: { address: string }) => p.address,
      ),
    ).toEqual(["work:web"]);
    expect(data("ls", (await cli(["ls", "--root", "nope", "--json"])).out).projects).toEqual([]);
    const bySize = data("ls", (await cli(["ls", "--sort", "size", "--json"])).out).projects;
    // A never-offloaded project has its folder's size too (fix wave r2), so every row is sized, largest first.
    const sizes = bySize.map((p: { bytes?: number }) => p.bytes ?? -1);
    expect(sizes.every((b: number) => b > 0)).toBe(true);
    expect(sizes).toEqual([...sizes].sort((a: number, b: number) => b - a));
  });

  test("the human list: one line per project, state and size", async () => {
    await cli(["root", "scan", "work"]);
    await offloaded();
    const run = await cli(["ls"]);
    expect(run.code).toBe(0);
    expect(run.out).toMatch(/^work:api\s+shelved\s+/m);
    expect(run.out).toMatch(/^work:web\s+local\s+/m);
  });

  test("an unknown --sort is a usage error (2)", async () => {
    expect((await cli(["ls", "--sort", "colour"])).code).toBe(2);
  });
});

describe("status: one project in detail", () => {
  test("a shelved project: state, head, stub and catalog freshness (--json)", async () => {
    const snapshot = await offloaded();
    const run = await cli(["status", "work:api", "--json"]);
    expect(run.code).toBe(0);
    expect(data("status", run.out)).toMatchObject({
      address: "work:api",
      state: "shelved",
      head: snapshot,
      stub: `${join(box.home, "work/api")}.plainport`,
      stale: false,
      conditions: [],
    });
  });

  test("by its stub, and in human words", async () => {
    await offloaded();
    const run = await cli(["status", `${join(box.home, "work/api")}.plainport`]);
    expect(run.code).toBe(0);
    expect(run.out).toMatch(/^work:api {2}shelved\n/);
    expect(run.out).toContain("plainport onload work:api");
  });

  test("an unknown project exits 4 (project.not-found)", async () => {
    const run = await cli(["status", "work:nothing", "--json"]);
    expect([run.code, envelope(run.out).error.finding.code]).toEqual([4, "project.not-found"]);
  });
});

describe("recover, through the CLI", () => {
  test("an offload killed after the rename: recover finishes it, status says shelved (ls and status after)", async () => {
    const crashed = await cli(["offload", "work:web", "--yes"], { at: "offload.release.renamed" });
    expect(crashed.code).toBe(1);
    const interrupted = data("status", (await cli(["status", "work:web", "--json"])).out);
    expect([interrupted.state, interrupted.journal?.step]).toEqual(["offloading", "offload.release.trash"]);
    const run = await cli(["recover", "--json"]);
    expect(run.code).toBe(0);
    const report = data("recover", run.out);
    expect(report.operations.map((o: { outcome: string; state: string }) => [o.outcome, o.state])).toEqual([
      ["finished", "shelved"],
    ]);
    await settle();
    expect(data("status", (await cli(["status", "work:web", "--json"])).out).state).toBe("shelved");
    await expectInvariants();
  });

  test("nothing to recover: exit 0, and says so", async () => {
    const run = await cli(["recover"]);
    expect([run.code, run.out]).toEqual([0, "nothing to recover\n"]);
  });

  test("diverged-after-commit exits 8 with the report as data, the operation's kind named", async () => {
    await cli(["offload", "work:web", "--yes"], { at: "offload.committed" });
    writeFileSync(join(dir(), "src/main.ts"), "export const main = 2;\n");
    const run = await cli(["recover", "--json"]);
    expect(run.code).toBe(8);
    const env = envelope(run.out);
    expect(env.error.finding.code).toBe("offload.diverged-after-commit");
    expect(env.data.operations[0]).toMatchObject({
      outcome: "diverged-after-commit",
      conflict: { kind: "diverged-after-commit" },
    });
    expect(data("status", (await cli(["status", "work:web", "--json"])).out).conditions).toEqual([
      "diverged-after-commit",
    ]);
    await expectInvariants();
  });
});

describe("housekeeping at the start of any command (D59)", () => {
  test("an interrupted operation is named on stderr with plainport recover; ls still runs", async () => {
    await cli(["offload", "work:web", "--yes"], { at: "offload.committed" });
    // The injected crash left this live process's pid: a killed one would be gone.
    const [name] = readdirSync(box.paths.journalDir);
    const path = join(box.paths.journalDir, name as string);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), pid: 99_999_999 }));
    const run = await cli(["ls"]);
    expect(run.code).toBe(0);
    expect(run.err).toContain(
      "interrupted at offload.committed; plainport recover finishes or rolls it back",
    );
    expect((await cli(["recover"])).err).not.toContain("interrupted");
  });

  test("a kept trash past its deadline is deleted when a write command starts; a read or a dry run leaves it (D61)", async () => {
    writeFileSync(box.paths.configFile, 'version = 1\n[offload]\nkeepLocalFor = "1h"\n');
    await cli(["offload", "work:api", "--yes"]);
    expect(readdirSync(join(box.home, "work/.plainport-trash"))).toHaveLength(1);
    const later = new Date(NOW.getTime() + 2 * 3_600_000);
    const journal = readdirSync(box.paths.journalDir);
    for (const argv of [["ls"], ["status", "work:api"], ["offload", "work:web", "--dry-run"]]) {
      expect((await cli(argv, {}, later)).code).toBe(0);
      await Bun.sleep(100);
      expect(readdirSync(join(box.home, "work/.plainport-trash"))).toHaveLength(1);
      expect(readdirSync(box.paths.journalDir)).toEqual(journal);
    }
    await cli(["root", "scan", "work"], {}, later);
    for (let i = 0; i < 400 && readdirSync(join(box.home, "work/.plainport-trash")).length > 0; i++)
      await Bun.sleep(25);
    expect(readdirSync(join(box.home, "work/.plainport-trash"))).toEqual([]);
    await settle();
    await expectInvariants("api");
  });
});

describe("gc, through the CLI", () => {
  test("--now needs --yes (3); with it, a kept trash goes and the bytes freed are reported", async () => {
    writeFileSync(box.paths.configFile, 'version = 1\n[offload]\nkeepLocalFor = "1h"\n');
    await cli(["offload", "work:api", "--yes"]);
    const kept = data("gc", (await cli(["gc", "--json"])).out);
    expect([kept.deleted.length, kept.kept.length]).toEqual([0, 1]);
    expect((await cli(["gc", "--now"])).code).toBe(3);
    const run = await cli(["gc", "--now", "--yes", "--json"]);
    expect(run.code).toBe(0);
    const done = data("gc", run.out);
    expect(done.deleted).toHaveLength(1);
    expect(done.freedBytes).toBeGreaterThan(0);
    await expectInvariants("api");
  });

  test("gc deletes a trash past its deadline itself, under the lock: its own housekeeping hands it to no detached delete (D64)", async () => {
    writeFileSync(box.paths.configFile, 'version = 1\n[offload]\nkeepLocalFor = "1h"\n');
    await cli(["offload", "work:api", "--yes"]);
    const run = await cli(["gc", "--json"], {}, new Date(NOW.getTime() + 2 * 3_600_000));
    expect(run.code).toBe(0);
    const done = data("gc", run.out);
    expect([done.deleted.length, done.kept.length]).toEqual([1, 0]);
    expect(done.freedBytes).toBeGreaterThan(0);
    expect(run.err).not.toContain("past its keepLocalFor deadline");
    await expectInvariants("api");
  });
});

describe("restore, through the CLI (D58)", () => {
  test("the head side by side; an occupied path exits 6", async () => {
    const snapshot = await offloaded();
    const run = await cli(["restore", "work:api", "--to", "~/old/api", "--json"]);
    expect(run.code).toBe(0);
    expect(data("restore", run.out)).toMatchObject({
      project: "work:api",
      snapshot,
      dir: join(box.home, "old/api"),
    });
    expect(readFileSync(join(box.home, "old/api/README.md"), "utf8")).toBe("# api\n");
    expect(data("status", (await cli(["status", "work:api", "--json"])).out).state).toBe("shelved");
    const again = await cli(["restore", "work:api", "--snapshot", snapshot, "--to", "~/old/api", "--json"]);
    expect([again.code, envelope(again.out).error.finding.code]).toEqual([6, "path.occupied"]);
    await expectInvariants("api");
  });

  test("--to is required (2)", async () => {
    await offloaded();
    expect((await cli(["restore", "work:api"])).code).toBe(2);
  });
});

describe("status and ls: fix wave r1", () => {
  test("status names a project by the path of a folder that is gone (stub = false), through the registry", async () => {
    writeFileSync(box.paths.configFile, "version = 1\n[offload]\nstub = false\n");
    await offloaded();
    expect(existsSync(join(box.home, "work/api"))).toBe(false);
    expect(existsSync(join(box.home, "work/api.plainport"))).toBe(false);
    const run = await cli(["status", join(box.home, "work/api"), "--json"]);
    expect(run.code).toBe(0);
    expect(data("status", run.out)).toMatchObject({ address: "work:api", state: "shelved" });
  });

  test("status names a project the catalog alone knows by a unique suffix", async () => {
    await offloaded();
    const registry = JSON.parse(readFileSync(box.paths.registryFile, "utf8"));
    const id = projectId("api") as string;
    delete registry.projects[id];
    writeFileSync(box.paths.registryFile, JSON.stringify(registry));
    const run = await cli(["status", "api", "--json"]);
    expect(run.code).toBe(0);
    expect(data("status", run.out)).toMatchObject({ address: "work:api", state: "shelved" });
  });

  test("a local project's status has its git warnings and what an offload would strip now", async () => {
    box.file("work/web/node_modules/dep/index.js", "x".repeat(2000));
    const git = (args: string[]) =>
      Bun.spawnSync(["git", ...args], {
        cwd: dir(),
        env: {
          PATH,
          HOME: box.home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@x",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@x",
        },
      });
    git(["init", "-q"]);
    writeFileSync(join(dir(), ".gitignore"), "node_modules\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
    await cli(["root", "scan", "work"]);
    const run = await cli(["status", "work:web", "--json"]);
    expect(run.code).toBe(0);
    const status = data("status", run.out);
    expect(status.state).toBe("local");
    expect(status.strippableBytes).toBe(2000);
    expect(status.gitWarnings.map((f: { code: string }) => f.code)).toContain("git.unpushed");
  });

  test("ls --local lists every project whose folder is here, an interrupted offload's too", async () => {
    await cli(["root", "scan", "work"]);
    await cli(["offload", "work:web", "--yes"], { at: "offload.committed" });
    const local = data("ls", (await cli(["ls", "--local", "--json"])).out);
    expect(local.projects.map((p: { address: string; state: string }) => [p.address, p.state])).toEqual([
      ["work:api", "local"],
      ["work:web", "offloading"],
    ]);
  });
});

describe("status and restore: fix wave r2 (one resolver)", () => {
  /** work:a/web registered here, work:b/web only in the catalog. */
  const twoWebs = async () => {
    box.file("work/a/web/package.json", `${JSON.stringify({ name: "a" })}\n`);
    box.file("work/b/web/package.json", `${JSON.stringify({ name: "b" })}\n`);
    await cli(["root", "scan", "work"]);
    expect((await cli(["offload", "work:b/web", "--yes"])).code).toBe(0);
    await settle();
    const registry = JSON.parse(readFileSync(box.paths.registryFile, "utf8"));
    delete registry.projects[projectId("b/web") as string];
    writeFileSync(box.paths.registryFile, JSON.stringify(registry));
  };

  test("a suffix that names a registered and a catalog-only project is ambiguous (2), listing both", async () => {
    await twoWebs();
    const run = await cli(["status", "web", "--json"]);
    expect(run.code).toBe(2);
    const env = envelope(run.out);
    expect(env.error.finding.code).toBe("project.ambiguous");
    expect(env.error.message).toContain("work:a/web");
    expect(env.error.message).toContain("work:b/web");
  });

  test("restore names a catalog-only project by its unique suffix", async () => {
    await twoWebs();
    const run = await cli(["restore", "b/web", "--to", "~/old/b", "--json"]);
    expect(run.code).toBe(0);
    expect(data("restore", run.out)).toMatchObject({ project: "work:b/web" });
  });

  test("restore names an offloaded project by the path of its folder that is gone (stub = false)", async () => {
    writeFileSync(box.paths.configFile, "version = 1\n[offload]\nstub = false\n");
    await offloaded();
    const run = await cli(["restore", join(box.home, "work/api"), "--to", "~/old/api", "--json"]);
    expect(run.code).toBe(0);
    expect(data("restore", run.out)).toMatchObject({ project: "work:api" });
  });
});

describe("status and ls: fix wave r3 (unreadable journals)", () => {
  test("a journal this version cannot read is named on stderr, in ls and in its project's status", async () => {
    await offloaded("work:api");
    const id = projectId("api") as string;
    const path = join(box.paths.journalDir, "01JZZZZZZZZZZZZZZZZZZZZZZZ.json");
    writeFileSync(path, JSON.stringify({ v: 2, project: { id, address: "work:api" } }));
    const run = await cli(["ls", "--json"]);
    expect(run.code).toBe(0);
    expect(run.err).toContain(`${path} is a journal of work:api this version of plainport cannot read`);
    const all = data("ls", run.out);
    expect(all.unreadableJournals).toEqual([path]);
    const api = all.projects.find((p: { address: string }) => p.address === "work:api");
    expect([api.conditions, api.unreadableJournals]).toEqual([["journal-unreadable"], [path]]);
    const human = await cli(["status", "work:api"]);
    expect(human.out).toContain(`journal  ${path} cannot be read by this version of plainport`);
    expect(human.out).toContain("next     plainport recover");
    expect((await cli(["ls"])).out).toContain(`${path}: a journal this version of plainport cannot read`);
  });
});

describe("status and ls: fix wave q1 (lazy views, the view model in core)", () => {
  /** Ports whose io and host record every folder listed. */
  const counted = () => {
    const listed: string[] = [];
    const base = ports();
    const wrap = <
      F extends { entries: (p: string) => Promise<unknown>; readdir: (p: string) => Promise<string[]> },
    >(
      fs: F,
    ): F => ({
      ...fs,
      entries: (p: string) => {
        listed.push(p);
        return fs.entries(p);
      },
      readdir: (p: string) => {
        listed.push(p);
        return fs.readdir(p);
      },
    });
    return {
      listed,
      ports: {
        ...base,
        io: { ...base.io, fs: wrap(base.io.fs) },
        system: { ...base.system, fs: wrap(base.system.fs) },
      } as Ports,
    };
  };

  test("status <project> walks only that project's folder; ls never walks a dependency folder", async () => {
    for (let i = 0; i < 50; i++) box.file(`work/api/src/f${i}.ts`, "x");
    box.file("work/api/node_modules/dep/index.js", "x".repeat(4000));
    box.file("work/web/node_modules/dep/index.js", "x".repeat(4000));
    await cli(["root", "scan", "work"]);
    const one = counted();
    const status = await capture(["status", "work:web", "--json"], REGISTRY, { ports: one.ports });
    expect(status.code).toBe(0);
    expect(one.listed.filter((p) => p.startsWith(join(box.home, "work/api")))).toEqual([]);
    const all = counted();
    const ls = await capture(["ls", "--json"], REGISTRY, { ports: all.ports });
    expect(ls.code).toBe(0);
    expect(all.listed.filter((p) => p.includes("/node_modules"))).toEqual([]);
    const api = data("ls", ls.out).projects.find((p: { address: string }) => p.address === "work:api");
    expect(api.bytes).toBeGreaterThan(50);
    expect(api.bytes).toBeLessThan(4000);
  });

  test("the view carries the next step, its local details, typed conditions with details, kept trash and every open journal", async () => {
    writeFileSync(box.paths.configFile, 'version = 1\n[offload]\nkeepLocalFor = "1h"\n');
    await cli(["offload", "work:api", "--yes"]);
    const shelved = data("status", (await cli(["status", "work:api", "--json"])).out);
    expect(shelved.next).toEqual({ command: "plainport onload work:api", reason: expect.any(String) });
    expect(shelved.trash).toEqual([
      {
        op: expect.any(String),
        path: expect.stringContaining(".plainport-trash"),
        keepUntil: expect.any(String),
        deleting: false,
      },
    ]);
    await cli(["root", "scan", "work"]);
    const local = data("status", (await cli(["status", "work:web", "--json"])).out);
    expect(local).toMatchObject({ gitWarnings: expect.any(Array), strippableBytes: expect.any(Number) });
    expect(local.next).toBeUndefined();
    await cli(["offload", "work:web", "--yes"], { at: "offload.committed" });
    const [name] = readdirSync(box.paths.journalDir).filter((n) => {
      const j = JSON.parse(readFileSync(join(box.paths.journalDir, n), "utf8"));
      return j.project.address === "work:web";
    });
    const path = join(box.paths.journalDir, name as string);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), pid: 99_999_999 }));
    const open = data("status", (await cli(["status", "work:web", "--json"])).out);
    expect(open.journals.map((j: { step: string; running: boolean }) => [j.step, j.running])).toEqual([
      ["offload.committed", false],
    ]);
    expect(open.conditionDetails).toEqual([
      { condition: "interrupted", message: expect.stringContaining("offload.committed") },
    ]);
    expect(open.next).toEqual({ command: "plainport recover", reason: expect.any(String) });
  });
});
