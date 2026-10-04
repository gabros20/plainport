import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, type Sandbox } from "../../../core/src/testing/sandbox.ts";
import { findCommand } from "../registry.ts";
import { capture, sandboxPorts } from "../testing.ts";
import { REGISTRY } from "./index.ts";

let box: Sandbox;

beforeEach(() => {
  box = makeSandbox("plainport-root-");
});
afterEach(() => box.cleanup());

const cli = (argv: string[]) => capture(argv, REGISTRY, { ports: sandboxPorts(box.home) });
const envelope = (out: string) => JSON.parse(out.trim().split("\n").at(-1) as string);
const managed = (): Record<string, unknown> =>
  Bun.TOML.parse(readFileSync(box.paths.managedFile, "utf8")) as Record<string, unknown>;

const setUp = async () => {
  box.dir("work");
  const run = await cli(["init", "--root", "work=~/work", "--store-path", "~/A", "--device", "mbp", "--yes"]);
  if (run.code !== 0) throw new Error(run.err);
};

describe("root: commands", () => {
  test("init is confirm; root add, bind and scan are safe_write; list only reads (D23)", () => {
    const risk = (name: string) => findCommand(REGISTRY, name.split(" "))?.command.risk;
    expect(["init", "root add", "root bind", "root list", "root scan"].map(risk)).toEqual([
      "confirm",
      "safe_write",
      "safe_write",
      "read",
      "safe_write",
    ]);
  });

  test("root list --json works before init and shows nothing bound", async () => {
    const run = await cli(["root", "list", "--json"]);
    expect(run.code).toBe(0);
    expect(envelope(run.out)).toMatchObject({
      ok: true,
      verb: "root list",
      data: { roots: [], findings: [] },
    });
  });

  test("root add before init exits 6 with device.none and points at init", async () => {
    box.dir("work");
    const run = await cli(["root", "add", "work", "~/work"]);
    expect(run.code).toBe(6);
    expect(run.err).toContain("device.none");
    expect(run.err).toContain("plainport init");
  });

  test("root add with --label, --create and the global --store", async () => {
    await setUp();
    const run = await cli([
      "root",
      "add",
      "personal",
      "~/personal",
      "--label",
      "Personal",
      "--store",
      "ssd",
      "--create",
      "--json",
    ]);
    expect(run.code).toBe(0);
    expect(envelope(run.out).data.root).toMatchObject({ key: "personal", path: join(box.home, "personal") });
    expect((managed().roots as Record<string, unknown>).personal).toEqual({
      label: "Personal",
      store: "ssd",
      on: { mbp: "~/personal" },
    });
  });

  test("root bind refuses an overlap with exit 6", async () => {
    await setUp();
    box.dir("work/inner");
    expect((await cli(["root", "add", "other"])).code).toBe(0);
    const run = await cli(["root", "bind", "other", "~/work/inner", "--json"]);
    expect(run.code).toBe(6);
    expect(envelope(run.out).error.finding.code).toBe("root.overlap");
  });

  test("root bind --device for another device waits for pairing (M3)", async () => {
    await setUp();
    const run = await cli(["root", "bind", "work", "~/work", "--device", "mini"]);
    expect(run.code).toBe(2);
    expect(run.err).toContain("M3");
    expect((await cli(["root", "bind", "work", "~/work", "--device", "mbp"])).code).toBe(0);
  });

  test("root list with no project registered says offload needs no registering, and root scan lists them (agent smoke)", async () => {
    await setUp();
    const hint =
      "work: no project registered yet; plainport offload work:<folder> works on any project folder under it without registering it first, and plainport root scan work lists and registers them";
    expect((await cli(["root", "list"])).out).toContain(`${hint}\n`);
    box.file("work/tool/package.json", "{}");
    await cli(["root", "scan", "work"]);
    expect((await cli(["root", "list"])).out).not.toContain(hint);
  });

  test("root scan registers projects; root list counts them", async () => {
    await setUp();
    box.repo("work/clients/acme/web");
    box.file("work/tool/package.json", "{}");
    const scan = await cli(["root", "scan", "work", "--json"]);
    expect(scan.code).toBe(0);
    expect(envelope(scan.out).data.projects.map((p: { address: string }) => p.address)).toEqual([
      "work:clients/acme/web",
      "work:tool",
    ]);
    const human = await cli(["root", "scan", "work"]);
    expect(human.out).toContain("work:clients/acme/web");
    const list = await cli(["root", "list", "--json"]);
    expect(envelope(list.out).data.roots[0]).toMatchObject({ key: "work", state: "ok", projects: 2 });
  });

  test("root list says where to edit when config.toml and managed.toml both define a root", async () => {
    await setUp();
    box.file(".config/plainport/config.toml", '[roots.work]\nlabel = "Mine"\n');
    const run = await cli(["root", "list"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("root.defined-twice");
    expect(run.out).toContain(box.paths.configFile);
  });
});
