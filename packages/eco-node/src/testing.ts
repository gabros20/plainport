// Golden plans for the Node fixtures (fixtures/node/<name>), shared by golden.test.ts and the script that rewrites
// the golden files. Each case copies a fixture into a temp repository, commits it, adds what an install and a build
// would leave (never by running one), and plans an offload with the Node plugin. Used only by tests and that script.

import { cpSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { ConfigLoader, type Plan, planOffload, resolvePaths } from "@plainport/core";
import { quietChecks } from "../../core/src/testing/checks.ts";
import { type GitFixture, makeGitFixture } from "../../core/src/testing/git-fixture.ts";
import { testHost } from "../../core/src/testing/host.ts";
import { nodePlugin } from "./plugin.ts";

export const FIXTURES = join(import.meta.dir, "../../../fixtures/node");
export const NOW = new Date("2026-10-03T12:00:00.000Z");

export interface GoldenCase {
  /** The fixture folder under fixtures/node, and the golden file's name. */
  name: string;
  /** Files an install or a build would write, untracked: path → size in bytes. */
  generated: Record<string, number>;
  /** Generated files to commit as well, as a project that checks its build output in would. */
  tracked?: string[];
}

export const GOLDEN_CASES: readonly GoldenCase[] = [
  {
    name: "npm",
    generated: {
      "node_modules/left-pad/index.js": 1200,
      "node_modules/left-pad/package.json": 300,
      "node_modules/.package-lock.json": 400,
      "dist/index.js": 800,
      "public/hero.mp4": 40_000,
    },
  },
  {
    name: "pnpm",
    generated: {
      "node_modules/.pnpm/vite@5.4.8/node_modules/vite/index.js": 9000,
      "node_modules/.modules.yaml": 200,
      "dist/assets/index.js": 2500,
      "dist/index.html": 300,
      "public/demo.mp4": 30_000,
    },
  },
  {
    name: "yarn-classic",
    generated: {
      "node_modules/react-scripts/package.json": 900,
      "node_modules/.yarn-integrity": 150,
      "build/static/js/main.js": 4000,
      "build/index.html": 500,
      "src/logo.png": 12_000,
    },
  },
  {
    // Zero-install: .yarn/cache and .pnp.cjs are committed, so only the install state is stripped.
    name: "yarn-berry",
    generated: {
      ".yarn/install-state.gz": 700,
      ".yarn/unplugged/esbuild-npm-0.23.0/node_modules/esbuild/bin/esbuild": 5000,
      "dist/index.js": 600,
      "assets/video.mp4": 25_000,
    },
  },
  {
    name: "bun",
    generated: {
      "node_modules/left-pad/index.js": 1200,
      "dist/index.js": 700,
      "data/sample.db": 20_000,
    },
  },
  {
    name: "monorepo",
    generated: {
      "node_modules/.pnpm/turbo@2.1.3/node_modules/turbo/bin/turbo": 8000,
      "apps/web/node_modules/next/package.json": 600,
      "packages/ui/node_modules/tsup/package.json": 400,
      "apps/web/.next/cache/webpack/client.pack": 6000,
      "apps/web/.next/BUILD_ID": 21,
      ".turbo/cache/abc.tar.zst": 3000,
      "apps/web/.turbo/turbo-build.log": 120,
      "packages/ui/dist/index.js": 500,
      "apps/web/public/hero.webp": 15_000,
    },
  },
];

export interface GoldenRun {
  plan: Plan;
  dir: string;
  fx: GitFixture;
}

const write = (dir: string, path: string, bytes: number) => {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "x".repeat(bytes));
};

/** Plans one case; the caller must call fx.cleanup(). */
export const planCase = async (c: GoldenCase): Promise<GoldenRun> => {
  const fx = makeGitFixture(`plainport-golden-${c.name}-`);
  const dir = join(fx.root, c.name);
  cpSync(join(FIXTURES, c.name), dir, { recursive: true });
  // An empty template: no sample hooks, so .git holds little but the commit.
  fx.git(dir, "init", "-q", "--template=");
  fx.git(dir, "add", "-A");
  fx.git(dir, "commit", "-q", "-m", "fixture");
  fx.origin(dir);
  for (const [path, bytes] of Object.entries(c.generated)) write(dir, path, bytes);
  if (c.tracked !== undefined && c.tracked.length > 0) {
    fx.git(dir, "add", "-f", ...c.tracked);
    fx.git(dir, "commit", "-q", "-m", "build output");
    fx.git(dir, "push", "-q");
  }
  const host = testHost();
  const paths = resolvePaths({ HOME: join(fx.root, ".home") }, { cwd: fx.root });
  if (!paths.ok) throw new Error(paths.finding.message);
  const result = await planOffload(host, quietChecks, [nodePlugin], {
    dir,
    project: { address: `work:${c.name}`, root: "work", path: c.name },
    loader: new ConfigLoader(host, paths.value),
    env: fx.env,
    now: NOW,
  });
  if (!result.ok) {
    fx.cleanup();
    throw new Error(`${c.name}: ${result.finding.code}: ${result.finding.message}`);
  }
  return { plan: result.value, dir, fx };
};

/** Every file under a folder: count and bytes. */
const tally = (folder: string): { files: number; bytes: number } => {
  let files = 0;
  let bytes = 0;
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        files++;
        bytes += stat.size;
      }
    }
  };
  walk(folder);
  return { files, bytes };
};

/**
 * The plan without what differs from run to run: its id, the fingerprint (mtimes), the temp folder, and .git's
 * own files (object sizes depend on the git version); the include totals count the project's other files only, and
 * the estimate, which is the include bytes, is checked by the test instead.
 */
export const normalize = ({ plan, dir }: Pick<GoldenRun, "plan" | "dir">) => {
  const git = tally(join(dir, ".git"));
  const { dir: _dir, ...project } = plan.project ?? { address: "", root: "", path: "" };
  // In the Plan's own key order (DESIGN.md "Core API"), so a golden file reads like a plan.
  return {
    kind: plan.kind,
    project,
    include: {
      files: plan.include.files - git.files,
      bytes: plan.include.bytes - git.bytes,
      largest: plan.include.largest.filter((l) => !l.path.startsWith(".git/")).slice(0, 3),
    },
    strip: plan.strip,
    findings: plan.findings.map((f) => ({ ...f, message: f.message.replaceAll(dir, "<dir>") })),
    phases: plan.phases,
    ...(plan.arrival === undefined ? {} : { arrival: plan.arrival }),
    expiresAt: plan.expiresAt,
  };
};

export const goldenFile = (name: string): string => join(FIXTURES, `${name}.plan.json`);

/** The relative path of a file under the fixtures, for messages. */
export const shown = (path: string): string => relative(join(FIXTURES, "../.."), path);
