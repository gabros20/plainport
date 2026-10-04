// The one guard before every recursive delete (D87): the tree itself decides, whatever config or spelling say.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ok } from "@plainport/contract";
import { deleteGuard } from "./delete-guard.ts";
import { ensureDevice } from "./device.ts";
import type { LocalIo } from "./io.ts";
import { updateRegistry } from "./registry.ts";
import { testHost } from "./testing/host.ts";
import { makeSandbox, type Sandbox } from "./testing/sandbox.ts";

let box: Sandbox;
let io: LocalIo;
let tree: string;
const ID = "01ARYZ6S410000000000000000";

const config = (extra = "") =>
  box.file(
    ".config/plainport/config.toml",
    ["version = 1", "[roots.work]", 'on = { mbp = "~/work" }', extra].join("\n"),
  );

beforeEach(async () => {
  box = makeSandbox("plainport-guard-");
  io = testHost();
  config();
  const made = await ensureDevice(io, box.paths, { role: "owner", name: "mbp" });
  if (!made.ok) throw new Error(made.finding.message);
  tree = box.dir("work/.plainport-trash/01ARYZ6S430000000000000000");
  box.file("work/.plainport-trash/01ARYZ6S430000000000000000/web/src/main.ts", "x");
});
afterEach(() => {
  for (const d of ["aliases"]) {
    try {
      chmodSync(join(box.home, d), 0o755);
    } catch {}
  }
  box.cleanup();
});

const guard = (path = tree, options = {}) =>
  deleteGuard({ io, paths: box.paths, env: { HOME: box.home } }, path, options);
const refusal = async (path = tree, options = {}) => {
  const result = await guard(path, options);
  return result.ok ? "allowed" : `${result.finding.code}: ${result.finding.message}`;
};
const register = (entry: { path: string; override?: string }) =>
  updateRegistry(io, box.paths, (registry) =>
    ok({
      ...registry,
      projects: {
        ...registry.projects,
        [ID]: { root: "work", registeredAt: "2026-10-04T12:00:00.000Z", ...entry },
      },
    }),
  );

describe("delete guard (D87)", () => {
  test("an ordinary tree, or nothing at all, may go", async () => {
    expect(await refusal()).toBe("allowed");
    expect(await refusal(join(box.home, "nothing-here"))).toBe("allowed");
  });

  test("(b) a store marker anywhere, a stripped folder included, refuses", async () => {
    box.file(
      "work/.plainport-trash/01ARYZ6S430000000000000000/web/node_modules/.cache/x/meta/v1/store.json",
      "{}",
    );
    expect(await refusal()).toContain("delete.guard-refused");
    expect(await refusal()).toContain("meta/v1/store.json");
  });

  test("(b) a restic repository layout (config beside keys/ and data/) refuses", async () => {
    const repo = join(tree, "web/.next/archive");
    mkdirSync(join(repo, "keys"), { recursive: true });
    mkdirSync(join(repo, "data"), { recursive: true });
    writeFileSync(join(repo, "config"), "x");
    expect(await refusal()).toContain("a restic repository");
  });

  test("(a) a link is never followed: a symlink to a store outside is no refusal, and the store is not reached", async () => {
    box.file("elsewhere/store/meta/v1/store.json", "{}");
    symlinkSync(join(box.home, "elsewhere/store"), join(tree, "web/link-to-store"));
    expect(await refusal()).toBe("allowed");
  });

  test("(a) a folder on another device than the tree (a mount point) refuses", async () => {
    const mounted = join(tree, "web/.next");
    mkdirSync(mounted, { recursive: true });
    const real = testHost();
    io = {
      ...real,
      fs: {
        ...real.fs,
        stat: async (path) => {
          const st = await real.fs.stat(path);
          return path === mounted ? { ...st, dev: st.dev + 1 } : st;
        },
      },
    };
    expect(await refusal()).toContain("is a mount point");
  });

  test("(a) a folder that cannot be read refuses: what it holds is unknown", async () => {
    const closed = join(tree, "web/closed");
    mkdirSync(closed);
    chmodSync(closed, 0o000);
    try {
      expect(await refusal()).toContain("cannot be read");
    } finally {
      chmodSync(closed, 0o755);
    }
  });

  test("(c) a tree that is, holds or lies inside a registered project's folder refuses; dehydrate may lie inside", async () => {
    box.dir("work/web/node_modules/dep");
    expect((await register({ path: "web" })).ok).toBe(true);
    expect(await refusal(join(box.home, "work/web"))).toContain("is work:web's folder");
    expect(await refusal(join(box.home, "work"))).toContain("holds work:web's folder");
    expect(await refusal(join(box.home, "work/web/node_modules"))).toContain("lies inside work:web's folder");
    expect(await refusal(join(box.home, "work/web/node_modules"), { insideProject: true })).toBe("allowed");
    expect(await refusal(join(box.home, "work"), { insideProject: true })).toContain("holds");
  });

  test("(c) a registered folder that cannot be resolved refuses rather than drops out (astra r2 finding 4)", async () => {
    const real = box.dir("work/.plainport-staging/01ARYZ6S440000000000000000");
    box.dir("aliases");
    symlinkSync(real, join(box.home, "aliases/web"));
    expect((await register({ path: "web", override: join(box.home, "aliases/web/inner") })).ok).toBe(true);
    chmodSync(join(box.home, "aliases"), 0o000);
    expect(await refusal(real)).toContain("cannot all be checked");
  });

  test("(d) a configuration that does not read cleanly refuses; a store it names around the tree refuses", async () => {
    box.file(".config/plainport/config.toml", "[roots.work\n");
    expect(await refusal()).toContain("cannot be read cleanly");
    config(`[stores.ssd]\nkind = "local"\npath = "${join(tree, "web/.next/archive")}"`);
    expect(await refusal()).toContain("store ssd");
  });

  test("a 100k-file tree is walked in a bounded time", async () => {
    // node_modules-like: 2,000 packages of 50 files in a few levels.
    const big = box.dir("work/.plainport-trash/01ARYZ6S450000000000000000");
    for (let p = 0; p < 2000; p++) {
      const pkg = join(big, "node_modules", `pkg-${p}`, "lib");
      mkdirSync(pkg, { recursive: true });
      for (let f = 0; f < 50; f++) writeFileSync(join(pkg, `f${f}.js`), "");
    }
    const started = performance.now();
    expect(await refusal(big)).toBe("allowed");
    const ms = Math.round(performance.now() - started);
    console.log(`delete guard: 100,000 files in 4,001 folders walked in ${ms} ms`);
    expect(ms).toBeLessThan(30_000);
    expect(existsSync(big)).toBe(true);
  }, 120_000);
});
