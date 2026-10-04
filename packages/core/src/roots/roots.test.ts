import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ok } from "@plainport/contract";
import { parse } from "smol-toml";
import { nodeLocalIo } from "../node-io.ts";
import { updateRegistry } from "../registry.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { listRoots, type RootChange, writeRoots } from "./roots.ts";

const io = nodeLocalIo;
let box: Sandbox;

beforeEach(() => {
  box = makeSandbox();
});
afterEach(() => box.cleanup());

const write = (
  changes: RootChange[],
  extra: { create?: boolean; store?: { name: string; path: string } } = {},
) => writeRoots(io, box.paths, { device: "mbp", cwd: box.home, changes, ...extra });

const managed = (): Record<string, unknown> =>
  existsSync(box.paths.managedFile) ? parse(readFileSync(box.paths.managedFile, "utf8")) : {};

const list = async () => {
  const result = await listRoots(io, box.paths, { env: {}, device: "mbp" });
  if (!result.ok) throw new Error(result.finding.message);
  return result.value;
};

describe("roots: add and bind", () => {
  test("add writes the root and this device's binding to managed.toml, home paths as ~", async () => {
    box.dir("work");
    const result = await write([{ kind: "add", key: "work", label: "Work", store: "mini", path: "~/work" }]);
    expect(result.ok).toBe(true);
    expect(managed().roots).toEqual({ work: { label: "Work", store: "mini", on: { mbp: "~/work" } } });
    const listed = await list();
    expect(listed.roots).toEqual([
      expect.objectContaining({
        key: "work",
        label: "Work",
        store: "mini",
        path: join(box.home, "work"),
        state: "ok",
        source: "managed",
        bindings: { mbp: "~/work" },
      }),
    ]);
  });

  test("a root inside another root is rejected with root.overlap, and nothing is written", async () => {
    box.dir("work/personal");
    expect((await write([{ kind: "add", key: "work", path: "~/work" }])).ok).toBe(true);
    const before = readFileSync(box.paths.managedFile, "utf8");
    const result = await write([{ kind: "add", key: "personal", path: "~/work/personal" }]);
    expect(result).toMatchObject({ ok: false, exitCode: 6, finding: { code: "root.overlap" } });
    if (result.ok) return;
    expect(result.finding.message).toContain("work");
    expect(result.finding.fix).toBeDefined();
    expect(readFileSync(box.paths.managedFile, "utf8")).toBe(before);
  });

  test("a root containing another root is rejected", async () => {
    box.dir("code/work");
    expect((await write([{ kind: "add", key: "work", path: "~/code/work" }])).ok).toBe(true);
    const result = await write([{ kind: "add", key: "code", path: "~/code" }]);
    expect(result).toMatchObject({ ok: false, finding: { code: "root.overlap" } });
  });

  test("two roots that resolve to the same real path through a symlink are rejected", async () => {
    const target = box.dir("Developer/Work");
    symlinkSync(target, join(box.home, "work"));
    expect((await write([{ kind: "add", key: "work", path: "~/work" }])).ok).toBe(true);
    const result = await write([{ kind: "add", key: "studio", path: "~/Developer/Work" }]);
    expect(result).toMatchObject({ ok: false, exitCode: 6, finding: { code: "root.overlap" } });
  });

  test("a symlink into another root is rejected", async () => {
    box.dir("work/clients");
    symlinkSync(join(box.home, "work", "clients"), join(box.home, "clients"));
    expect((await write([{ kind: "add", key: "work", path: "~/work" }])).ok).toBe(true);
    const result = await write([{ kind: "add", key: "clients", path: "~/clients" }]);
    expect(result).toMatchObject({ ok: false, finding: { code: "root.overlap" } });
  });

  test("on a case-insensitive volume, a path differing only by case is the same folder", async () => {
    box.dir("Work");
    if (!existsSync(join(box.home, "work"))) return; // a case-sensitive volume: nothing to check
    expect((await write([{ kind: "add", key: "work", path: "~/Work" }])).ok).toBe(true);
    const result = await write([{ kind: "add", key: "other", path: "~/work" }]);
    expect(result).toMatchObject({ ok: false, finding: { code: "root.overlap" } });
  });

  test("two overlapping roots in one change are rejected together", async () => {
    box.dir("a/b");
    const result = await write([
      { kind: "add", key: "a", path: "~/a" },
      { kind: "add", key: "b", path: "~/a/b" },
    ]);
    expect(result).toMatchObject({ ok: false, finding: { code: "root.overlap" } });
    expect(existsSync(box.paths.managedFile)).toBe(false);
  });

  test("bind points an existing root at a new folder; its own old path is no overlap", async () => {
    box.dir("work");
    box.dir("work2");
    expect((await write([{ kind: "add", key: "work", path: "~/work" }])).ok).toBe(true);
    expect((await write([{ kind: "bind", key: "work", path: "~/work/../work2" }])).ok).toBe(true);
    expect((managed().roots as Record<string, { on: unknown }>).work?.on).toEqual({ mbp: "~/work2" });
    expect((await write([{ kind: "bind", key: "work", path: "~/work2/sub" }])).ok).toBe(false);
  });

  test("bind keeps other devices' bindings", async () => {
    box.file(".config/plainport/managed.toml", '[roots.work]\non = { mini = "~/Developer/Work" }\n');
    box.dir("work");
    expect((await write([{ kind: "bind", key: "work", path: "~/work" }])).ok).toBe(true);
    expect((managed().roots as Record<string, { on: unknown }>).work?.on).toEqual({
      mini: "~/Developer/Work",
      mbp: "~/work",
    });
  });

  test("bind of an unknown root is root.not-found (4); add of an existing one is root.exists (6)", async () => {
    box.dir("work");
    expect(await write([{ kind: "bind", key: "nope", path: "~/work" }])).toMatchObject({
      ok: false,
      exitCode: 4,
      finding: { code: "root.not-found" },
    });
    expect((await write([{ kind: "add", key: "work" }])).ok).toBe(true);
    expect(await write([{ kind: "add", key: "work" }])).toMatchObject({
      ok: false,
      exitCode: 6,
      finding: { code: "root.exists", fix: expect.stringContaining("plainport root bind work") },
    });
  });

  test("a root key must be a lower-case word", async () => {
    expect(await write([{ kind: "add", key: "Work Stuff" }])).toMatchObject({
      ok: false,
      exitCode: 2,
      finding: { code: "usage.invalid" },
    });
  });

  test("a missing folder is root.path-missing unless create is set; a file is not a folder", async () => {
    expect(await write([{ kind: "add", key: "work", path: "~/work" }])).toMatchObject({
      ok: false,
      exitCode: 6,
      finding: { code: "root.path-missing" },
    });
    expect(existsSync(join(box.home, "work"))).toBe(false);
    expect((await write([{ kind: "add", key: "work", path: "~/work" }], { create: true })).ok).toBe(true);
    expect(existsSync(join(box.home, "work"))).toBe(true);
    box.file("afile");
    expect(await write([{ kind: "add", key: "f", path: "~/afile" }])).toMatchObject({
      ok: false,
      finding: { code: "root.path-missing" },
    });
  });

  test("a folder plainport cannot write to is root.not-writable", async () => {
    if (process.getuid?.() === 0) return; // root can write anywhere
    const dir = box.dir("locked");
    chmodSync(dir, 0o555);
    try {
      expect(await write([{ kind: "add", key: "locked", path: "~/locked" }])).toMatchObject({
        ok: false,
        exitCode: 6,
        finding: { code: "root.not-writable" },
      });
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test("a root in a synced folder is written with a root.synced-folder warning", async () => {
    box.dir("Library/Mobile Documents/com~apple~CloudDocs/work");
    const result = await write([
      { kind: "add", key: "work", path: "~/Library/Mobile Documents/com~apple~CloudDocs/work" },
    ]);
    if (!result.ok) throw new Error(result.finding.message);
    expect(result.value.findings.map((f) => f.code)).toEqual(["root.synced-folder"]);
  });

  test("a store is recorded as a local store and becomes the default and each new root's store", async () => {
    box.dir("work");
    const result = await write([{ kind: "add", key: "work", path: "~/work" }], {
      store: { name: "local", path: "/Volumes/Archive/plainport" },
    });
    expect(result.ok).toBe(true);
    expect(managed()).toMatchObject({
      defaultStore: "local",
      stores: { local: { kind: "local", path: "/Volumes/Archive/plainport" } },
      roots: { work: { store: "local", on: { mbp: "~/work" } } },
    });
  });
});

describe("roots: config.toml wins", () => {
  test("a binding config.toml sets is not shadowed: config.owned (5) names the file to edit", async () => {
    box.dir("work");
    box.dir("elsewhere");
    box.file(".config/plainport/config.toml", '[roots.work]\non = { mbp = "~/work" }\n');
    const result = await write([{ kind: "bind", key: "work", path: "~/elsewhere" }]);
    expect(result).toMatchObject({ ok: false, exitCode: 5, finding: { code: "config.owned" } });
    if (result.ok) return;
    expect(result.finding.fix).toContain(box.paths.configFile);
    expect(result.finding.fix).toContain("roots.work.on.mbp");
    expect(existsSync(box.paths.managedFile)).toBe(false);
  });

  test("a root config.toml defines cannot be added again", async () => {
    box.file(".config/plainport/config.toml", '[roots.work]\nlabel = "Work"\n');
    expect(await write([{ kind: "add", key: "work" }])).toMatchObject({
      ok: false,
      finding: { code: "root.exists" },
    });
  });

  test("overlap counts roots from both files", async () => {
    box.dir("work/x");
    box.file(".config/plainport/config.toml", '[roots.work]\non = { mbp = "~/work" }\n');
    expect(await write([{ kind: "add", key: "x", path: "~/work/x" }])).toMatchObject({
      ok: false,
      finding: { code: "root.overlap" },
    });
  });

  test("list says when both files define a root and which one to edit", async () => {
    box.dir("work");
    box.file(".config/plainport/config.toml", '[roots.work]\nlabel = "Mine"\n');
    box.file(".config/plainport/managed.toml", '[roots.work]\nlabel = "Theirs"\non = { mbp = "~/work" }\n');
    const listed = await list();
    expect(listed.roots[0]).toMatchObject({ key: "work", label: "Mine", source: "both", state: "ok" });
    expect(listed.findings).toEqual([
      expect.objectContaining({
        code: "root.defined-twice",
        severity: "warn",
        paths: [box.paths.configFile, box.paths.managedFile],
        fix: `edit root work in ${box.paths.configFile}, or remove it there to let plainport manage it in managed.toml`,
      }),
    ]);
  });
});

describe("roots: unreadable paths are findings, not crashes", () => {
  test("a symlink loop as the folder is root.path-missing", async () => {
    symlinkSync(join(box.home, "loop"), join(box.home, "loop"));
    const result = await write([{ kind: "add", key: "work", path: "~/loop/x" }]);
    expect(result).toMatchObject({ ok: false, exitCode: 6, finding: { code: "root.path-missing" } });
    if (result.ok) return;
    expect(result.finding.fix).toBeDefined();
  });

  test("another root whose folder cannot be resolved stops the overlap check with its name", async () => {
    symlinkSync(join(box.home, "loop"), join(box.home, "loop"));
    box.file(".config/plainport/config.toml", '[roots.old]\non = { mbp = "~/loop/x" }\n');
    box.dir("work");
    const result = await write([{ kind: "add", key: "work", path: "~/work" }]);
    expect(result).toMatchObject({ ok: false, exitCode: 6, finding: { code: "root.path-missing" } });
    if (result.ok) return;
    expect(result.finding.message).toContain("old");
  });

  test("a folder behind an unreadable parent is root.not-writable", async () => {
    if (process.getuid?.() === 0) return; // root reads anything
    const parent = box.dir("sealed");
    box.dir("sealed/inside");
    chmodSync(parent, 0o000);
    try {
      expect(await write([{ kind: "add", key: "work", path: "~/sealed/inside" }])).toMatchObject({
        ok: false,
        exitCode: 6,
        finding: { code: "root.not-writable" },
      });
    } finally {
      chmodSync(parent, 0o755);
    }
  });
});

describe("roots: list", () => {
  test("states: unbound without a binding here, missing when the folder is gone, unavailable on an unmounted volume", async () => {
    box.file(
      ".config/plainport/config.toml",
      [
        '[roots.a]\non = { mini = "~/a" }',
        '[roots.b]\non = { mbp = "~/gone" }',
        '[roots.c]\non = { mbp = "/Volumes/plainport-test-not-mounted-volume/c" }',
        "",
      ].join("\n"),
    );
    const states = Object.fromEntries((await list()).roots.map((r) => [r.key, r.state]));
    expect(states).toEqual({ a: "unbound", b: "missing", c: "unavailable" });
  });

  test("without a device name every root lists, none bound here", async () => {
    box.file(".config/plainport/config.toml", '[roots.a]\non = { mbp = "~/a" }\n');
    const result = await listRoots(io, box.paths, { env: {} });
    if (!result.ok) throw new Error(result.finding.message);
    expect(result.value.roots).toEqual([expect.objectContaining({ key: "a", state: "unbound" })]);
  });

  test("a broken config.toml fails with config.invalid", async () => {
    writeFileSync(box.file(".config/plainport/config.toml"), "[roots.a\n");
    expect(await listRoots(io, box.paths, { env: {} })).toMatchObject({
      ok: false,
      finding: { code: "config.invalid" },
    });
  });
});

describe("roots: plainport's reserved holders are never a root (D84)", () => {
  test("a root in .plainport-staging, or reached through a symlink into .plainport-trash, is path.reserved", async () => {
    box.dir("work/.plainport-staging/inner");
    const direct = await write([{ kind: "add", key: "inner", path: "~/work/.plainport-staging/inner" }]);
    expect(direct).toMatchObject({ ok: false, exitCode: 6, finding: { code: "path.reserved" } });
    const trash = box.dir("work/.plainport-trash/x");
    symlinkSync(trash, join(box.home, "alias"));
    const aliased = await write([{ kind: "add", key: "alias", path: "~/alias" }]);
    expect(aliased).toMatchObject({ ok: false, finding: { code: "path.reserved" } });
    expect(existsSync(box.paths.managedFile)).toBe(false);
  });
});

describe("roots: a root never puts a project and a local store together (D83)", () => {
  const storeAt = (path: string) =>
    box.file(".config/plainport/config.toml", `[stores.vault]\nkind = "local"\npath = "${path}"\n`);

  test("a root inside a local store is store.inside-project; a store beside a root's projects is fine", async () => {
    box.dir("vault/work");
    storeAt("~/vault");
    const inside = await write([{ kind: "add", key: "work", path: "~/vault/work" }]);
    expect(inside).toMatchObject({ ok: false, exitCode: 6, finding: { code: "store.inside-project" } });
    box.dir("code/archive");
    storeAt("~/code/archive");
    expect((await write([{ kind: "add", key: "code", path: "~/code" }])).ok).toBe(true);
  });

  test("binding a root where a registered project of it would hold a store is store.inside-project", async () => {
    box.dir("old");
    expect((await write([{ kind: "add", key: "work", path: "~/old" }])).ok).toBe(true);
    const updated = await updateRegistry(io, box.paths, (registry) =>
      ok({
        ...registry,
        projects: {
          ...registry.projects,
          "01ARYZ6S410000000000000000": {
            root: "work",
            path: "web",
            registeredAt: "2026-10-04T12:00:00.000Z",
          },
        },
      }),
    );
    expect(updated.ok).toBe(true);
    box.dir("new/web/.next/archive");
    storeAt("~/new/web/.next/archive");
    const bound = await write([{ kind: "bind", key: "work", path: "~/new" }]);
    expect(bound).toMatchObject({ ok: false, exitCode: 6, finding: { code: "store.inside-project" } });
  });
});
