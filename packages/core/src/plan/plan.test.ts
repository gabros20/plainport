import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ok } from "@plainport/contract";
import { ConfigLoader } from "../config/load.ts";
import { type PlainportPaths, resolvePaths } from "../paths.ts";
import type { EcosystemPlugin, StripCandidate } from "../ports/ecosystem.ts";
import { quietChecks } from "../testing/checks.ts";
import { type GitFixture, makeGitFixture } from "../testing/git-fixture.ts";
import { testHost } from "../testing/host.ts";
import { isUlid } from "../ulid.ts";
import { type OffloadPlanRequest, PLAN_TTL_MS, type Plan, PlanSchema, planOffload } from "./index.ts";

const host = testHost();
const NOW = new Date("2026-10-03T12:00:00.000Z");
let fx: GitFixture;
let paths: PlainportPaths;
let dir: string;

beforeEach(() => {
  fx = makeGitFixture("plainport-plan-");
  const resolved = resolvePaths({ HOME: join(fx.root, ".home") }, { cwd: fx.root });
  if (!resolved.ok) throw new Error(resolved.finding.message);
  paths = resolved.value;
  dir = fx.repo("web");
  fx.origin(dir);
});
afterEach(() => fx.cleanup());

/** Writes `bytes` bytes at a path inside the project. */
const put = (path: string, bytes = 10): void => {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "x".repeat(bytes));
};
const commit = (...files: string[]): void => {
  fx.git(dir, "add", "-f", ...files);
  fx.git(dir, "commit", "-q", "-m", "add");
  fx.git(dir, "push", "-q");
};
const userConfig = (toml: string): void => {
  mkdirSync(dirname(paths.configFile), { recursive: true });
  writeFileSync(paths.configFile, toml);
};

const plugin = (candidates: StripCandidate[]): EcosystemPlugin => ({
  id: "fake",
  detect: async () => ({ plugin: "fake", summary: "fake project" }),
  strip: async () => candidates,
  hydrate: async () => ({
    steps: [{ path: "", command: "fake install --frozen", argv: ["fake", "install"] }],
  }),
});
const deps = (path: string): StripCandidate => ({ path, reason: `${path}: installed`, kind: "deps" });
const output = (path: string): StripCandidate => ({ path, reason: `${path}: built`, kind: "output" });

const plan = async (
  candidates: StripCandidate[],
  over: Partial<OffloadPlanRequest> = {},
  plugins: EcosystemPlugin[] = [plugin(candidates)],
): Promise<Plan> => {
  const result = await planOffload(host, quietChecks, plugins, {
    dir,
    project: { address: "work:web", root: "work", path: "web" },
    loader: new ConfigLoader(host, paths),
    env: fx.env,
    now: NOW,
    ...over,
  });
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  expect(PlanSchema.safeParse(result.value).success).toBe(true);
  return result.value;
};
const stripped = (p: Plan) => p.strip.map((s) => s.path);
const codes = (p: Plan) => p.findings.map((f) => `${f.severity} ${f.code}`);

describe("plan: the strip set", () => {
  test("a path is stripped only if a plugin claims it and git does not track it: a tracked build/ is kept", async () => {
    put("node_modules/left-pad/index.js", 100);
    put("build/app.js", 50);
    commit("build/app.js");
    const p = await plan([deps("node_modules"), output("build")]);
    expect(p.strip).toEqual([
      { path: "node_modules", bytes: 100, plugin: "fake", reason: "node_modules: installed" },
    ]);
  });

  test("one tracked file inside a candidate folder keeps the whole folder", async () => {
    put(".yarn/cache/a.zip", 30);
    put(".yarn/cache/b.zip", 30);
    commit(".yarn/cache/a.zip");
    expect(stripped(await plan([deps(".yarn/cache")]))).toEqual([]);
  });

  test("candidates that are not on disk are dropped, and one inside another collapses into it", async () => {
    put("node_modules/a/index.js");
    put("node_modules/a/node_modules/b/index.js");
    const p = await plan([deps("node_modules"), deps("node_modules/a/node_modules"), output(".next")]);
    expect(stripped(p)).toEqual(["node_modules"]);
    expect(p.strip[0]?.bytes).toBe(20);
  });

  test("strip.keep in .plainport.toml and strip.never in config.toml keep candidates", async () => {
    put("dist/index.js");
    put(".vercel/output/config.json");
    put(".next/cache/x");
    writeFileSync(join(dir, ".plainport.toml"), '[strip]\nkeep = ["dist/"]\n');
    userConfig('[strip]\nnever = [".vercel/output"]\n');
    const p = await plan([output("dist"), output(".vercel/output"), output(".next")]);
    expect(stripped(p)).toEqual([".next"]);
  });

  test("D39: keep and never match the candidates themselves, never something inside one", async () => {
    put("node_modules/react/dist/index.js");
    put("node_modules/a/test/cert.pem");
    put("dist/index.js");
    put("apps/web/.next/x");
    // DESIGN's own example: keep = ["dist/"] keeps the project's dist, not node_modules.
    writeFileSync(join(dir, ".plainport.toml"), '[strip]\nkeep = ["dist/", "apps/"]\nnever = ["*.pem"]\n');
    const p = await plan([deps("node_modules"), output("dist"), output("apps/web/.next")]);
    expect(stripped(p)).toEqual(["node_modules"]);
    const kept = p.findings.find((f) => f.code === "strip.kept");
    // A pattern matching a folder above the candidate keeps it too.
    expect(kept?.paths).toEqual(["apps/web/.next", "dist"]);
  });

  test("D39: a candidate holding a kept candidate is kept too, naming the inner keep", async () => {
    put("out/keep/a.js");
    put("out/b.js");
    put("gen/sub/tools/node_modules/x.js");
    writeFileSync(join(dir, ".plainport.toml"), '[strip]\nkeep = ["out/keep"]\n');
    const declined: StripCandidate = {
      path: "gen/sub/tools/node_modules",
      reason: "installed dependencies",
      kind: "deps",
      declined: "no install puts it back",
    };
    // gen holds gen/sub, which holds the declined node_modules: the keep reaches every candidate around it.
    const p = await plan([output("out"), output("out/keep"), output("gen"), output("gen/sub"), declined]);
    expect(stripped(p)).toEqual([]);
    const kept = p.findings.find((f) => f.code === "strip.kept");
    expect(kept?.paths).toEqual(["gen", "gen/sub", "gen/sub/tools/node_modules", "out", "out/keep"]);
    expect(kept?.message).toContain("out (it holds out/keep, which stays)");
    expect(kept?.message).toContain("gen/sub (it holds gen/sub/tools/node_modules, which stays)");
  });

  test("a kept candidate shows in the plan with why: strip.kept (info)", async () => {
    put("node_modules/a/index.js");
    put("build/app.js");
    commit("build/app.js");
    put("dist/index.js");
    put("certs/dev.pem");
    writeFileSync(join(dir, ".plainport.toml"), '[strip]\nkeep = ["dist/"]\nnever = ["certs"]\n');
    const p = await plan([output("build"), output("dist"), output("certs"), output(".next")], {
      keepDeps: true,
    });
    expect(stripped(p)).toEqual([]);
    const kept = p.findings.find((f) => f.code === "strip.kept");
    expect(kept).toMatchObject({ severity: "info", paths: ["build", "certs", "dist"] });
    expect(kept?.message).toContain("build (git tracks it)");
    expect(kept?.message).toContain("dist (strip.keep matches it)");
    expect(kept?.message).toContain("certs (strip.never matches it)");
    // A candidate that is not on disk is not news.
    expect(kept?.message).not.toContain(".next");
  });

  test("a path a plugin declines stays, with the plugin's reason in strip.kept", async () => {
    put("tools/node_modules/a.js");
    const declined: StripCandidate = {
      path: "tools/node_modules",
      reason: "installed dependencies",
      kind: "deps",
      declined: "no install puts it back: tools has no lockfile",
    };
    const p = await plan([declined]);
    expect(stripped(p)).toEqual([]);
    expect(p.findings.find((f) => f.code === "strip.kept")?.message).toContain(
      "tools/node_modules (no install puts it back: tools has no lockfile)",
    );
  });

  test("strip.extra re-includes inside an excluded folder, which gitignore cannot: dist/ minus dist/keep.txt", async () => {
    put("dist/a.js");
    put("dist/sub/b.js");
    put("dist/keep.txt");
    userConfig('[strip]\nextra = ["dist/", "!dist/keep.txt"]\n');
    // git would ignore dist/keep.txt with its folder; plainport keeps it and strips the rest one by one.
    expect(stripped(await plan([])).sort()).toEqual(["dist/a.js", "dist/sub"]);
  });

  test("D39: strip.extra supports negation; a folder holding a re-included file is not stripped whole", async () => {
    put("a.log");
    put("audit.log");
    put("logs/x.log");
    put("logs/keep.txt");
    put("cache/one");
    put("cache/two");
    userConfig('[strip]\nextra = ["*.log", "!audit.log", "logs/", "cache/", "!cache/two"]\n');
    const p = await plan([]);
    expect(stripped(p).sort()).toEqual(["a.log", "cache/one", "logs"]);
  });

  test("D39: a tracked folder is tracked whichever Unicode form the index and the disk spell it in", async () => {
    const nfc = "caf\u00e9";
    const nfd = "cafe\u0301";
    // Committed under its NFD name: git on macOS precomposes it to NFC in the index (core.precomposeunicode);
    // git on Linux stores the bytes as given.
    put(`${nfd}/dist/a.js`);
    commit(`${nfd}/dist/a.js`);
    const listed = fx.git(dir, "-c", "core.quotePath=false", "ls-files");
    expect(listed).toContain(`${process.platform === "darwin" ? nfc : nfd}/dist/a.js`);
    const onDisk = (prefix: string) => readdirSync(dir).find((name) => name.normalize("NFC") === prefix);
    expect(stripped(await plan([output(`${onDisk(nfc)}/dist`)]))).toEqual([]);

    // Committed as NFC, then renamed on disk to NFD: on Linux a different name to git, on macOS the same one. The
    // fold counts it as tracked on both, so it stays: when unsure, keep.
    put("ma\u00f1ana/build/b.js");
    commit("ma\u00f1ana/build/b.js");
    renameSync(join(dir, "ma\u00f1ana"), join(dir, "tmp-name"));
    renameSync(join(dir, "tmp-name"), join(dir, "man\u0303ana"));
    const renamed = readdirSync(dir).find((name) => name.normalize("NFC") === "ma\u00f1ana");
    expect(renamed).toBeDefined();
    expect(stripped(await plan([output(`${renamed}/build`)]))).toEqual([]);
  });

  test("D39: a tracked folder renamed only in case stays tracked, on a case-insensitive volume or not", async () => {
    put("Build/a.js");
    commit("Build/a.js");
    renameSync(join(dir, "Build"), join(dir, "tmp-build"));
    renameSync(join(dir, "tmp-build"), join(dir, "build"));
    // git sets core.ignorecase from the volume; on a case-sensitive one (Linux) build/ is another name to git,
    // and the fold still counts it as tracked: when unsure, keep.
    const insensitive = existsSync(join(dir, "BUILD"));
    expect(fx.git(dir, "config", "--bool", "--default", "false", "core.ignorecase").trim()).toBe(
      String(insensitive),
    );
    expect(stripped(await plan([output("build")]))).toEqual([]);
  });

  test("case is folded even when core.ignorecase is false (a repository made on a case-sensitive volume)", async () => {
    fx.git(dir, "config", "core.ignorecase", "false");
    put("Build/a.js");
    commit("Build/a.js");
    renameSync(join(dir, "Build"), join(dir, "tmp-build"));
    renameSync(join(dir, "tmp-build"), join(dir, "build"));
    // Kept on a case-insensitive volume (git finds Build/ as build/) and on a case-sensitive one alike.
    expect(stripped(await plan([output("build")]))).toEqual([]);
  });

  test("the tracked check scales: 20,000 candidates in one plan, a tracked one among them kept", async () => {
    // Long names: one pathspec per candidate on git's command line would pass macOS's 1 MiB argument limit.
    const folder = (d: number) => `generated/a-folder-with-a-rather-long-name-${d}`;
    const file = (d: number, f: number) => `${folder(d)}/a-file-with-a-long-name-${f}.tmp`;
    for (let d = 0; d < 200; d++) {
      for (let f = 0; f < 100; f++) put(file(d, f), 1);
    }
    commit(file(7, 7));
    userConfig('[strip]\nextra = ["*.tmp"]\n');
    const p = await plan([]);
    expect(p.strip.length).toBe(19_999);
    expect(stripped(p)).not.toContain(file(7, 7));
  }, 60_000);

  test("strip.extra adds untracked paths, never tracked ones", async () => {
    put("coverage/lcov.info", 40);
    put("apps/web/coverage/lcov.info", 40);
    put("docs/coverage/index.md", 5);
    commit("docs/coverage/index.md");
    userConfig('[strip]\nextra = ["**/coverage"]\n');
    const p = await plan([]);
    expect(p.strip).toEqual([
      { path: "apps/web/coverage", bytes: 40, plugin: "config", reason: "matches strip.extra **/coverage" },
      { path: "coverage", bytes: 40, plugin: "config", reason: "matches strip.extra **/coverage" },
    ]);
  });

  test("deps.mode keep (or --keep-deps) keeps installed dependencies and still strips build output", async () => {
    put("node_modules/a/index.js");
    put(".next/cache/x");
    expect(stripped(await plan([deps("node_modules"), output(".next")], { keepDeps: true }))).toEqual([
      ".next",
    ]);
    userConfig('[deps]\nmode = "keep"\n');
    expect(stripped(await plan([deps("node_modules"), output(".next")]))).toEqual([".next"]);
  });

  test("the root's deps and strip settings apply, and the project file outranks them (D37)", async () => {
    put("node_modules/a/index.js");
    put("tmp/x.log");
    userConfig('[roots.work.deps]\nmode = "keep"\n[roots.work.strip]\nextra = ["tmp/"]\n');
    expect(stripped(await plan([deps("node_modules")]))).toEqual(["tmp"]);
    writeFileSync(join(dir, ".plainport.toml"), '[deps]\nmode = "strip"\n');
    expect(stripped(await plan([deps("node_modules")])).sort()).toEqual(["node_modules", "tmp"]);
  });

  test("a candidate holding a repository is kept, and nested repositories are listed in the plan", async () => {
    put("node_modules/tool/index.js");
    fx.repo(join(dir, "node_modules/tool"));
    fx.repo(join(dir, "vendor/lib"));
    const p = await plan([deps("node_modules")]);
    expect(stripped(p)).toEqual([]);
    const nested = p.findings.find((f) => f.code === "git.nested-repos");
    expect(nested).toMatchObject({ severity: "info", paths: ["node_modules/tool", "vendor/lib"] });
  });

  test("a candidate inside a nested repository is checked against that repository", async () => {
    const lib = fx.repo(join(dir, "vendor/lib"));
    put("vendor/lib/build/out.js");
    put("vendor/lib/dist/out.js");
    fx.git(lib, "add", "-f", "build/out.js");
    fx.git(lib, "commit", "-q", "-m", "build");
    expect(stripped(await plan([output("vendor/lib/build"), output("vendor/lib/dist")]))).toEqual([
      "vendor/lib/dist",
    ]);
  });

  test("a project with no git at all strips what plugins claim", async () => {
    const plain = join(fx.root, "plain");
    mkdirSync(join(plain, "node_modules/a"), { recursive: true });
    writeFileSync(join(plain, "node_modules/a/index.js"), "x");
    expect(stripped(await plan([deps("node_modules")], { dir: plain }))).toEqual(["node_modules"]);
  });
});

describe("plan: totals, findings and the plan's own fields", () => {
  test("include counts what is left after stripping; largest is the ten largest included files", async () => {
    // No repository here, so .git's own files do not count in the totals.
    dir = join(fx.root, "plain");
    put("README.md", 6);
    put("node_modules/big.bin", 10_000);
    for (let i = 1; i <= 12; i++) put(`src/f${String(i).padStart(2, "0")}.ts`, i * 100);
    const p = await plan([deps("node_modules")]);
    // README.md (6 bytes) plus twelve source files of 100 … 1200 bytes.
    expect(p.include.files).toBe(13);
    expect(p.include.bytes).toBe(6 + 7800);
    expect(p.include.largest.map((l) => l.path)).toEqual([
      "src/f12.ts",
      "src/f11.ts",
      "src/f10.ts",
      "src/f09.ts",
      "src/f08.ts",
      "src/f07.ts",
      "src/f06.ts",
      "src/f05.ts",
      "src/f04.ts",
      "src/f03.ts",
    ]);
    expect(p.estimate).toEqual({ uploadBytes: 6 + 7800 });
  });

  test("largest leaves out the files inside .git and shows each repository's .git as one line (D37)", async () => {
    put("big.bin", 50_000);
    fx.repo(join(dir, "vendor/lib"));
    const p = await plan([]);
    const paths = p.include.largest.map((l) => l.path);
    expect(paths.filter((path) => path.includes(".git/"))).toEqual([]);
    // Every file's size under a folder, through node:fs (BSD and GNU stat disagree on their flags).
    const total = (folder: string): number =>
      readdirSync(folder, { recursive: true, encoding: "utf8" })
        .map((name) => lstatSync(join(folder, name)))
        .filter((stat) => stat.isFile())
        .reduce((sum, stat) => sum + stat.size, 0);
    expect(p.include.largest[0]).toEqual({ path: "big.bin", bytes: 50_000 });
    expect(p.include.largest).toContainEqual({ path: ".git", bytes: total(join(dir, ".git")) });
    expect(p.include.largest).toContainEqual({
      path: "vendor/lib/.git",
      bytes: total(join(dir, "vendor/lib/.git")),
    });
  });

  test("id, kind, project, phases, expiry and arrival", async () => {
    const p = await plan([], { store: "ssd" });
    expect(isUlid(p.id)).toBe(true);
    expect(p.kind).toBe("offload");
    expect(p.project).toEqual({ address: "work:web", root: "work", path: "web", dir, store: "ssd" });
    expect(p.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(p.phases).toEqual([
      "resolve",
      "preflight",
      "scan",
      "plan",
      "snapshot",
      "verify",
      "commit",
      "release",
    ]);
    expect(Date.parse(p.expiresAt) - NOW.getTime()).toBe(PLAN_TTL_MS);
    expect(PLAN_TTL_MS).toBe(60 * 60 * 1000);
    expect(p.arrival).toEqual([{ part: "deps", outcome: "hydrate", detail: "fake install --frozen" }]);
  });

  test("the store is --store, else the root's store, else the default store", async () => {
    userConfig('defaultStore = "ssd"\n[roots.work]\nstore = "mini-work"\n');
    expect((await plan([])).project?.store).toBe("mini-work");
    expect((await plan([], { store: "b2" })).project?.store).toBe("b2");
    userConfig('defaultStore = "ssd"\n');
    expect((await plan([])).project?.store).toBe("ssd");
  });

  test("a plugin that does not detect the project proposes nothing and hydrates nothing", async () => {
    put("node_modules/a.js");
    const shy: EcosystemPlugin = { ...plugin([deps("node_modules")]), detect: async () => null };
    const p = await plan([], {}, [shy]);
    expect(stripped(p)).toEqual([]);
    expect(p.arrival).toBeUndefined();
  });

  test("plugin preflight findings join the plan's", async () => {
    const warns: EcosystemPlugin = {
      ...plugin([]),
      preflight: async () => [
        { code: "deps.no-lockfile", severity: "warn", message: "no lockfile", allowable: true },
      ],
    };
    expect(codes(await plan([], {}, [warns]))).toEqual(["warn deps.no-lockfile"]);
  });

  test("unpushed work is a warning; with requirePushed it is the blocker git.unpushed-required", async () => {
    fx.git(dir, "commit", "-q", "--allow-empty", "-m", "local");
    expect(codes(await plan([]))).toEqual(["warn git.unpushed"]);
    userConfig("[offload]\nrequirePushed = true\n");
    const p = await plan([]);
    expect(codes(p)).toEqual(["block git.unpushed-required"]);
    expect(p.findings[0]?.allowable).toBe(false);
    expect(p.findings[0]?.fix).toContain("git push");
  });

  test("preflight blockers stay in the plan; a folder preflight cannot clear for reading fails with its blocker", async () => {
    const busy = {
      ...quietChecks,
      processesUsing: async () =>
        ok([
          {
            pid: 7,
            ppid: 1,
            command: "vim",
            ancestor: false,
            cwd: false,
            files: [join(dir, "README.md")],
            fileCount: 1,
          },
        ]),
    };
    const result = await planOffload(host, busy, [], {
      dir,
      project: { address: "work:web", root: "work", path: "web" },
      loader: new ConfigLoader(host, paths),
      env: fx.env,
      now: NOW,
    });
    expect(result.ok && result.value.findings.map((f) => f.code)).toEqual(["proc.open-files"]);

    const emitted: string[] = [];
    const cloudy = {
      ...quietChecks,
      dataless: async () => ok({ placeholders: ["a.mov"], unsearchable: [] }),
      processesUsing: busy.processesUsing,
    };
    const refused = await planOffload(host, cloudy, [], {
      dir,
      project: { address: "work:web", root: "work", path: "web" },
      loader: new ConfigLoader(host, paths),
      env: fx.env,
      now: NOW,
      onFinding: (f) => emitted.push(f.code),
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.finding.code).toBe("fs.dataless");
    expect(emitted).toEqual(["fs.dataless", "proc.open-files"]);
  });

  test("a broken .plainport.toml fails the plan with config.invalid", async () => {
    put(".plainport.toml");
    writeFileSync(join(dir, ".plainport.toml"), "[strip\n");
    const result = await planOffload(host, quietChecks, [], {
      dir,
      project: { address: "work:web", root: "work", path: "web" },
      loader: new ConfigLoader(host, paths),
      env: fx.env,
      now: NOW,
    });
    expect(!result.ok && result.finding.code).toBe("config.invalid");
  });
});
