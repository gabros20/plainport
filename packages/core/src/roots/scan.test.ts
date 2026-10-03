import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeLocalIo } from "../node-io.ts";
import { readRegistry } from "../registry.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { isUlid } from "../ulid.ts";
import { scanRoot } from "./scan.ts";

const io = nodeLocalIo;
let box: Sandbox;
const now = () => new Date("2026-10-03T12:00:00.000Z");

beforeEach(() => {
  box = makeSandbox();
  box.file(
    ".config/plainport/config.toml",
    '[roots.work]\non = { mbp = "~/work" }\n[roots.far]\non = { mini = "~/far" }\n[roots.gone]\non = { mbp = "~/gone" }\n',
  );
  box.repo("work/clients/acme/web");
  box.repo("work/clients/globex/web");
  box.file("work/tool/package.json", "{}");
});
afterEach(() => box.cleanup());

const scan = (key: string) => scanRoot(io, box.paths, { key, device: "mbp", env: {}, now });

describe("roots: scan and the registry", () => {
  test("scan registers every project under the root with a new ULID", async () => {
    const result = await scan("work");
    if (!result.ok) throw new Error(result.finding.message);
    expect(result.value.projects.map((p) => [p.address, p.marker, p.new])).toEqual([
      ["work:clients/acme/web", ".git", true],
      ["work:clients/globex/web", ".git", true],
      ["work:tool", "package.json", true],
    ]);
    expect(result.value.projects[0]?.dir).toBe(join(box.home, "work", "clients/acme/web"));
    const registry = await readRegistry(io, box.paths);
    if (!registry.ok) throw new Error(registry.finding.message);
    const entries = Object.entries(registry.value.projects);
    expect(entries).toHaveLength(3);
    for (const [id, entry] of entries) {
      expect(isUlid(id)).toBe(true);
      expect(entry).toMatchObject({ root: "work", registeredAt: "2026-10-03T12:00:00.000Z" });
    }
  });

  test("a rescan keeps every id and adds only new projects", async () => {
    const first = await scan("work");
    if (!first.ok) throw new Error(first.finding.message);
    box.repo("work/new");
    const second = await scan("work");
    if (!second.ok) throw new Error(second.finding.message);
    const ids = (r: typeof second) =>
      r.ok ? Object.fromEntries(r.value.projects.map((p) => [p.address, p.id])) : {};
    expect(ids(second)).toMatchObject(ids(first));
    expect(second.value.projects.filter((p) => p.new).map((p) => p.address)).toEqual(["work:new"]);
  });

  test("a root not bound here is root.unbound with the bind command as its fix", async () => {
    expect(await scan("far")).toMatchObject({
      ok: false,
      exitCode: 6,
      finding: { code: "root.unbound", fix: "plainport root bind far <path>" },
    });
  });

  test("an unknown root is root.not-found; a missing folder is root.path-missing", async () => {
    expect(await scan("nope")).toMatchObject({ ok: false, exitCode: 4, finding: { code: "root.not-found" } });
    expect(await scan("gone")).toMatchObject({
      ok: false,
      exitCode: 6,
      finding: { code: "root.path-missing" },
    });
  });

  test("a damaged registry.json is reported as registry.invalid and never overwritten", async () => {
    box.file(".local/state/plainport/registry.json", "{ not json");
    expect(await scan("work")).toMatchObject({
      ok: false,
      exitCode: 6,
      finding: { code: "registry.invalid" },
    });
    expect(readFileSync(box.paths.registryFile, "utf8")).toBe("{ not json");
    writeFileSync(box.paths.registryFile, JSON.stringify({ v: 1, projects: { nope: {} } }));
    expect(await readRegistry(io, box.paths)).toMatchObject({
      ok: false,
      finding: { code: "registry.invalid" },
    });
  });
});
