import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type PluginContext, scanTree } from "@plainport/core";
import { testHost } from "../../core/src/testing/host.ts";
import { nodePlugin } from "./plugin.ts";

const host = testHost();
let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-node-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (path: string, text = "x"): void => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const pkg = (path: string, json: Record<string, unknown> = {}) => put(path, JSON.stringify(json));

const context = async (): Promise<PluginContext | null> => {
  const tree = await scanTree(host.fs, dir);
  if (!tree.ok) throw new Error(tree.finding.message);
  const project = { dir, manifest: tree.value.manifest, fs: host.fs };
  const detection = await nodePlugin.detect(project);
  return detection === null ? null : { ...project, detection };
};
const ready = async (): Promise<PluginContext> => {
  const ctx = await context();
  if (ctx === null) throw new Error("not detected");
  return ctx;
};

describe("Node plugin: detection, findings and hydration", () => {
  test("a folder with no package.json is not a Node project", async () => {
    put("main.py");
    put("node_modules/stray/index.js");
    expect(await context()).toBeNull();
  });

  test("no lockfile: deps.no-lockfile with the --keep-deps way out, and a plain install", async () => {
    pkg("package.json", { name: "x" });
    const ctx = await ready();
    expect(ctx.detection.summary).toBe("npm (no lockfile)");
    const [warning] = (await nodePlugin.preflight?.(ctx)) ?? [];
    expect(warning).toMatchObject({ code: "deps.no-lockfile", severity: "warn", paths: ["package.json"] });
    expect(warning?.fix).toContain("--keep-deps");
    expect((await nodePlugin.hydrate(ctx)).steps).toEqual([
      { path: "", command: "npm install", argv: ["npm", "install"] },
    ]);
  });

  test("two lockfiles and no packageManager field: deps.ambiguous naming both", async () => {
    pkg("package.json");
    put("package-lock.json", "{}");
    put("yarn.lock");
    const [warning] = (await nodePlugin.preflight?.(await ready())) ?? [];
    expect(warning).toMatchObject({ code: "deps.ambiguous", paths: ["package-lock.json", "yarn.lock"] });
    expect(warning?.message).toContain("npm (package-lock.json)");
  });

  test("the packageManager field settles two lockfiles without a warning", async () => {
    pkg("package.json", { packageManager: "pnpm@9.12.0" });
    put("package-lock.json", "{}");
    put("pnpm-lock.yaml");
    const ctx = await ready();
    expect(await nodePlugin.preflight?.(ctx)).toEqual([]);
    expect((await nodePlugin.hydrate(ctx)).steps.map((s) => s.command)).toEqual([
      "pnpm install --frozen-lockfile",
    ]);
  });

  test("a package folder with its own lockfile below a non-Node project installs there", async () => {
    put("pyproject.toml");
    pkg("frontend/package.json", { scripts: { build: "vite build" } });
    put("frontend/package-lock.json", "{}");
    put("frontend/node_modules/vite/index.js");
    put("frontend/dist/index.html");
    pkg("examples/demo/package.json");
    const ctx = await ready();
    expect(ctx.detection.summary).toBe("npm (package-lock.json) in frontend");
    expect((await nodePlugin.strip(ctx)).map((c) => [c.path, c.kind])).toEqual([
      ["frontend/node_modules", "deps"],
      ["frontend/dist", "output"],
    ]);
    expect((await nodePlugin.hydrate(ctx)).steps).toEqual([
      { path: "frontend", command: "npm ci", argv: ["npm", "ci"] },
    ]);
  });

  test("package.json files inside node_modules, caches and build output are not packages", async () => {
    pkg("package.json");
    put("package-lock.json", "{}");
    pkg("node_modules/a/package.json", { scripts: { build: "tsc --outDir dist" } });
    put("node_modules/a/dist/index.js");
    pkg("dist/package.json", { scripts: { build: "vite build" } });
    put("dist/build/x");
    const strip = await nodePlugin.strip(await ready());
    expect(strip.map((c) => c.path)).toEqual(["node_modules"]);
  });

  test("dist/ that no script writes is not proposed: it may be hand-made", async () => {
    pkg("package.json", { scripts: { build: "next build" } });
    put("package-lock.json", "{}");
    put("dist/handmade.html");
    put(".next/cache/x");
    expect((await nodePlugin.strip(await ready())).map((c) => c.path)).toEqual([".next"]);
  });

  test("an unreadable or broken package.json proposes nothing from its scripts", async () => {
    put("package.json", "{ not json");
    put("package-lock.json", "{}");
    put("dist/x.js");
    const ctx = await ready();
    expect((await nodePlugin.strip(ctx)).map((c) => c.path)).toEqual([]);
  });

  test("a folder named like an Object method is not a cache; only a real .vercel/output is", async () => {
    pkg("package.json");
    put("package-lock.json", "{}");
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])
      put(`${name}/x`);
    put("foo.vercel/output/x");
    put(".vercel/output/config.json");
    put("apps/site/.vercel/output/config.json");
    const strip = await nodePlugin.strip(await ready());
    expect(strip.map((c) => c.path)).toEqual([".vercel/output", "apps/site/.vercel/output"]);
    for (const c of strip) expect(typeof c.reason).toBe("string");
  });

  test("a stray lockfile in a workspace member does not make a second install root", async () => {
    pkg("package.json", { packageManager: "pnpm@9.12.0" });
    put("pnpm-lock.yaml");
    put("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - \"packages/**\"\n");
    pkg("apps/web/package.json");
    put("apps/web/package-lock.json", "{}");
    pkg("packages/ui/core/package.json");
    put("packages/ui/core/yarn.lock");
    // Not a workspace member: its own lockfile makes it its own install root.
    pkg("tools/script/package.json");
    put("tools/script/package-lock.json", "{}");
    const steps = (await nodePlugin.hydrate(await ready())).steps;
    expect(steps.map((s) => [s.path, s.command])).toEqual([
      ["", "pnpm install --frozen-lockfile"],
      ["tools/script", "npm ci"],
    ]);
  });

  test("package.json workspaces (array or object form) name the members too", async () => {
    pkg("package.json", { workspaces: ["apps/*"] });
    put("package-lock.json", "{}");
    pkg("apps/web/package.json");
    put("apps/web/package-lock.json", "{}");
    expect((await nodePlugin.hydrate(await ready())).steps.map((s) => s.path)).toEqual([""]);
    pkg("package.json", { workspaces: { packages: ["apps/*"] } });
    expect((await nodePlugin.hydrate(await ready())).steps.map((s) => s.path)).toEqual([""]);
  });

  test("node_modules that no install puts back is declined, with why", async () => {
    pkg("package.json");
    put("package-lock.json", "{}");
    put("node_modules/a/index.js");
    // A package with no lockfile of its own, outside any workspace: the root's npm ci never fills it.
    pkg("tools/package.json");
    put("tools/node_modules/b/index.js");
    // No package.json at all beside it.
    put("scratch/node_modules/c/index.js");
    const strip = await nodePlugin.strip(await ready());
    expect(strip.map((c) => [c.path, c.declined === undefined])).toEqual([
      ["node_modules", true],
      ["scratch/node_modules", false],
      ["tools/node_modules", false],
    ]);
    expect(strip.find((c) => c.path === "tools/node_modules")?.declined).toContain("tools has no lockfile");
    expect(strip.find((c) => c.path === "scratch/node_modules")?.declined).toContain("no package.json");
  });

  test("a workspace member's node_modules is covered by the workspace root's install", async () => {
    pkg("package.json", { workspaces: ["packages/*"] });
    put("package-lock.json", "{}");
    pkg("packages/ui/package.json");
    put("packages/ui/node_modules/x/index.js");
    const strip = await nodePlugin.strip(await ready());
    expect(strip).toEqual([
      expect.objectContaining({
        path: "packages/ui/node_modules",
        reason: expect.stringContaining("npm ci"),
      }),
    ]);
    expect(strip[0]?.declined).toBeUndefined();
  });
});
