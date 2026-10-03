// Hydration with the Node plugin: the toolchain it reads, how the core meets it (a version manager on PATH, or a
// warning), and real frozen installs. The installs run offline against fixtures/hydrate/<manager>, whose one
// dependency is a vendored tarball (file:vendor/plainport-tiny-1.0.0.tgz): npm, pnpm, Yarn Classic and Bun run for
// real with a sandboxed HOME and caches, so nothing reaches a registry or the real home (D13). Yarn Berry needs
// Yarn 4, which only a download provides, so it runs through a fake `yarn` that records the call.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamEvent } from "@plainport/contract";
import { hydrateProject, resolveToolchain, scanTree, type ToolRequirement } from "@plainport/core";
import { testHost } from "../../core/src/testing/host.ts";
import { nodePlugin } from "./plugin.ts";
import { FIXTURES } from "./testing.ts";

const HYDRATE_FIXTURES = join(FIXTURES, "../hydrate");

let root: string;
let home: string;
let bin: string;
let events: StreamEvent[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plainport-hydrate-"));
  home = join(root, "home");
  bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  events = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The user's PATH (the real package managers), with the test's fake binaries first. */
const PATH = `${process.env.PATH ?? "/usr/bin:/bin"}`;

/** Offline, sandboxed: every cache and config the managers read lives under the test's home. */
const offlineEnv = (path = PATH): Record<string, string> => ({
  HOME: home,
  PATH: path,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local/share"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_STATE_HOME: join(home, ".local/state"),
  npm_config_offline: "true",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  YARN_CACHE_FOLDER: join(home, ".yarn-cache"),
  YARN_DISABLE_SELF_UPDATE_CHECK: "true",
  BUN_INSTALL_CACHE_DIR: join(home, ".bun-cache"),
  COREPACK_ENABLE_STRICT: "0",
});

const fake = (name: string, script: string) => {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
};

const project = (name: string): string => {
  const dir = join(root, "work", name);
  cpSync(join(HYDRATE_FIXTURES, name), dir, { recursive: true });
  return dir;
};

const hydrate = (dir: string, env = offlineEnv()) =>
  hydrateProject(
    {
      host: testHost(),
      plugins: [nodePlugin],
      env,
      op: "01M40X7EC1DTXN87AJ4SH74DK6",
      emit: (event) => events.push(event),
      log: () => {},
    },
    dir,
    "work:web",
  );

const requirements = async (dir: string): Promise<ToolRequirement[]> => {
  const host = testHost();
  const scanned = await scanTree(host.fs, dir);
  if (!scanned.ok) throw new Error(scanned.finding.message);
  const ctx = { dir, manifest: scanned.value.manifest, fs: host.fs };
  const detection = await nodePlugin.detect(ctx);
  if (detection === null) throw new Error("not detected");
  return (await nodePlugin.toolchain?.({ ...ctx, detection })) ?? [];
};

describe("hydrate: the toolchain the Node plugin reads", () => {
  const files = (dir: string, entries: Record<string, string>) => {
    for (const [path, text] of Object.entries(entries)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };

  test("version files are pinned; engines and packageManager are compared only", async () => {
    const dir = join(root, "web");
    files(dir, {
      "package.json": JSON.stringify({
        name: "web",
        engines: { node: ">=18", pnpm: ">=9" },
        packageManager: "pnpm@9.12.0+sha512.abc",
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      ".nvmrc": "v20.11.0\n",
      ".node-version": "20.11.0\n",
      ".tool-versions": "# pinned\nnodejs 20.11.0\npnpm 9.12.0\n",
      "mise.toml": '[tools]\nnode = "20"\n',
    });
    expect(await requirements(dir)).toEqual([
      { tool: "node", version: "v20.11.0", source: ".nvmrc", pinned: true },
      { tool: "node", version: "20.11.0", source: ".node-version", pinned: true },
      { tool: "node", version: "20.11.0", source: ".tool-versions", pinned: true },
      { tool: "pnpm", version: "9.12.0", source: ".tool-versions", pinned: true },
      { tool: "node", version: "20", source: "mise.toml", pinned: true },
      { tool: "node", version: ">=18", source: "package.json engines.node", pinned: false },
      { tool: "pnpm", version: ">=9", source: "package.json engines.pnpm", pinned: false },
      { tool: "pnpm", version: "9.12.0", source: "package.json packageManager", pinned: false },
    ]);
  });

  test("a project that names no version asks for nothing", async () => {
    expect(await requirements(project("npm"))).toEqual([]);
  });
});

describe("hydrate: the core meets the toolchain", () => {
  const node18 = () => fake("node", 'echo "v18.20.0"');
  const nvmrc: ToolRequirement[] = [{ tool: "node", version: "20.11.0", source: ".nvmrc", pinned: true }];

  test("fnm on PATH activates a pinned node version around the install", async () => {
    fake("fnm", "exit 0");
    const toolchain = await resolveToolchain(testHost(), offlineEnv(`${bin}:/usr/bin:/bin`), nvmrc);
    expect(toolchain.manager).toBe("fnm");
    expect(toolchain.wrap(["npm", "ci"])).toEqual(["fnm", "exec", "--using=20.11.0", "--", "npm", "ci"]);
    expect(toolchain.findings).toEqual([]);
  });

  test("mise comes before fnm, and Volta is used when it is the only one", async () => {
    fake("fnm", "exit 0");
    fake("mise", "exit 0");
    const both = await resolveToolchain(testHost(), offlineEnv(`${bin}:/usr/bin:/bin`), nvmrc);
    expect(both.wrap(["pnpm", "install"])).toEqual(["mise", "exec", "node@20.11.0", "--", "pnpm", "install"]);
    rmSync(join(bin, "fnm"));
    rmSync(join(bin, "mise"));
    fake("volta", "exit 0");
    const volta = await resolveToolchain(testHost(), offlineEnv(`${bin}:/usr/bin:/bin`), nvmrc);
    expect(volta.wrap(["npm", "ci"])).toEqual(["volta", "run", "--node", "20.11.0", "npm", "ci"]);
  });

  test("without a manager, an active version that does not fit warns with toolchain.mismatch", async () => {
    node18();
    const toolchain = await resolveToolchain(testHost(), offlineEnv(`${bin}:/usr/bin:/bin`), [
      ...nvmrc,
      { tool: "node", version: ">=18", source: "package.json engines.node", pinned: false },
    ]);
    expect(toolchain.manager).toBeUndefined();
    expect(toolchain.wrap(["npm", "ci"])).toEqual(["npm", "ci"]);
    expect(toolchain.findings.map((f) => [f.code, f.severity])).toEqual([["toolchain.mismatch", "warn"]]);
    expect(toolchain.findings[0]?.message).toContain(
      ".nvmrc asks for node 20.11.0, but node 18.20.0 is active",
    );
  });

  test("a tool that is not on PATH warns too; an alias such as lts/* is not compared", async () => {
    const toolchain = await resolveToolchain(testHost(), offlineEnv(`${bin}:/usr/bin:/bin`), [
      { tool: "pnpm", version: "9.12.0", source: "package.json packageManager", pinned: false },
      { tool: "node", version: "lts/*", source: ".nvmrc", pinned: true },
    ]);
    expect(toolchain.findings.map((f) => f.message)).toEqual([
      "package.json packageManager asks for pnpm 9.12.0, but pnpm is not on PATH; the install runs with what is there",
    ]);
  });

  test("versions are asked in the project folder, where a shim (corepack, mise, asdf) reads its pin (M2)", async () => {
    const dir = join(root, "web");
    mkdirSync(dir);
    fake("pnpm", `case "$PWD" in *web) echo 9.12.0;; *) echo 8.0.0;; esac`);
    const toolchain = await resolveToolchain(
      testHost(),
      offlineEnv(`${bin}:/usr/bin:/bin`),
      [{ tool: "pnpm", version: "9.12.0", source: "package.json packageManager", pinned: false }],
      undefined,
      dir,
    );
    expect(toolchain.findings).toEqual([]);
  });

  test("a range in a version file is compared, never handed to a manager as a version (M2)", async () => {
    fake("fnm", "exit 0");
    fake("node", 'echo "v20.11.0"');
    const toolchain = await resolveToolchain(testHost(), offlineEnv(`${bin}:/usr/bin:/bin`), [
      { tool: "node", version: ">=18", source: "mise.toml", pinned: true },
    ]);
    expect(toolchain.manager).toBeUndefined();
    expect(toolchain.wrap(["npm", "ci"])).toEqual(["npm", "ci"]);
    expect(toolchain.findings).toEqual([]);
  });

  test("the toolchain step's warning reaches the event stream, and the install runs through the manager", async () => {
    const dir = project("npm");
    writeFileSync(join(dir, ".nvmrc"), "20.11.0\n");
    fake("fnm", 'echo "$*" > "$FAKE_LOG"; shift 2; exec "$@"');
    fake("npm", "mkdir -p node_modules; echo ok > node_modules/.marker");
    const done = await hydrate(dir, {
      ...offlineEnv(`${bin}:/usr/bin:/bin`),
      FAKE_LOG: join(root, "fnm.log"),
    });
    expect(done.failure).toBeUndefined();
    expect(readFileSync(join(root, "fnm.log"), "utf8").trim()).toBe("exec --using=20.11.0 -- npm ci");
    expect(existsSync(join(dir, "node_modules/.marker"))).toBe(true);
    expect(
      events.filter((e) => e.type === "phase").map((e) => e.type === "phase" && `${e.phase} ${e.status}`),
    ).toEqual(["toolchain start", "toolchain end", "hydrate start", "hydrate end"]);
  });
});

describe("hydrate: real frozen installs, offline", () => {
  for (const [name, command] of [
    ["npm", "npm ci"],
    ["pnpm", "pnpm install --frozen-lockfile"],
    ["yarn-classic", "yarn install --frozen-lockfile"],
    ["bun", "bun install --frozen-lockfile"],
  ] as const) {
    // CI installs every manager and must never skip these (scripts/ci-workflow.test.ts pins the step); a laptop
    // without one skips its test.
    const manager = command.split(" ")[0] as string;
    test.skipIf(!Bun.which(manager) && !process.env.CI)(
      `${name}: ${command} brings the vendored dependency back`,
      async () => {
        expect(Bun.which(manager)).not.toBeNull();
        const dir = project(name);
        const done = await hydrate(dir);
        expect(done.failure?.finding.message).toBeUndefined();
        expect(done.report).toEqual({
          status: "installed",
          steps: [{ path: "", command, ok: true }],
          untrusted: [],
        });
        // The vendored package's one file, byte for byte (the same bytes as the tarball's).
        expect(readFileSync(join(dir, "node_modules/plainport-tiny/index.js"), "utf8")).toStartWith(
          "module.exports = (s) => `tiny:",
        );
      },
      60_000,
    );
  }

  test.skipIf(!Bun.which("npm") && !process.env.CI)(
    "npm: a lockfile that no longer fits fails frozen (hydrate.failed), and a retry succeeds once it fits",
    async () => {
      expect(Bun.which("npm")).not.toBeNull();
      const dir = project("npm");
      // package.json now asks for a dependency the lockfile lacks: npm ci refuses before it fetches anything.
      const manifest = readFileSync(join(dir, "package.json"), "utf8");
      const pkg = JSON.parse(manifest);
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, "left-pad": "1.3.0" } }),
      );
      const failed = await hydrate(dir);
      expect(failed.report.status).toBe("failed");
      expect(failed.report.steps).toEqual([
        { path: "", command: "npm ci", ok: false, exitCode: expect.any(Number) },
      ]);
      expect(failed.failure?.exitCode).toBe(10);
      expect(failed.failure?.finding).toMatchObject({
        code: "hydrate.failed",
        fix: "plainport hydrate work:web",
      });
      expect(existsSync(join(dir, "package.json"))).toBe(true);
      writeFileSync(join(dir, "package.json"), manifest);
      const retried = await hydrate(dir);
      expect(retried.report.status).toBe("installed");
    },
    60_000,
  );

  test("yarn-berry (faked: Yarn 4 needs a download): yarn install --immutable runs in the project", async () => {
    const dir = join(root, "work", "yarn-berry");
    cpSync(join(FIXTURES, "yarn-berry"), dir, { recursive: true });
    fake("yarn", 'echo "$PWD|$*" > "$FAKE_LOG"');
    const done = await hydrate(dir, {
      ...offlineEnv(`${bin}:/usr/bin:/bin`),
      FAKE_LOG: join(root, "yarn.log"),
    });
    expect(done.report.status).toBe("installed");
    expect(readFileSync(join(root, "yarn.log"), "utf8").trim()).toEndWith("|install --immutable");
  });
});
