import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { macOnlyTests, onMac } from "../test/platform.ts";
import { describeT1 } from "../test/tiers.ts";
import { buildCommand } from "./build.ts";
import {
  compareTrees,
  D11_PROJECTS,
  type GateReport,
  hashTree,
  nulList,
  parseProjects,
  parseTimeL,
  platformProblem,
  runGate,
  stripProblems,
} from "./gate-m1.ts";

const scratch = mkdtempSync(join(tmpdir(), "plainport-gate-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("parseProjects", () => {
  test("defaults to the five D11 projects at full pinned commits", () => {
    const parsed = parseProjects(undefined);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.projects.map((p) => `${p.name}@${p.sha.slice(0, 7)}`)).toEqual([
      "nextjs/saas-starter@6e33e58",
      "t3-oss/create-t3-turbo@8f945b7",
      "Skolaczk/next-starter@5de3b14",
      "planetscale/nextjs-planetscale-starter@4216f41",
      "rajput-hemant/nextjs-template@ff5a6d0",
    ]);
    for (const p of parsed.projects) {
      expect(p.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(p.url).toBe(`https://github.com/${p.name}.git`);
    }
    expect(D11_PROJECTS).toHaveLength(5);
  });

  test("takes D11 names and <url>@<full sha>, and refuses the rest", () => {
    const sha = "a".repeat(40);
    const parsed = parseProjects(`t3-oss/create-t3-turbo,file:///tmp/src.git@${sha}`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.projects.map((p) => p.name)).toEqual(["t3-oss/create-t3-turbo", "src"]);
      expect(parsed.projects[1]).toMatchObject({ url: "file:///tmp/src.git", sha });
    }
    expect(parseProjects("someone/unknown").ok).toBe(false);
    expect(parseProjects("file:///tmp/src.git@abc1234").ok).toBe(false);
  });
});

test("parseTimeL reads wall time and peak RSS from macOS /usr/bin/time -l", () => {
  const text = [
    "warn: something else on stderr",
    "        2.99 real         1.81 user         0.34 sys",
    "           108134400  maximum resident set size",
    "                   0  average shared memory size",
  ].join("\n");
  expect(parseTimeL(text)).toEqual({ wallMs: 2990, maxRssBytes: 108134400 });
  expect(parseTimeL("no timing here")).toBeUndefined();
});

describe("hashTree and compareTrees", () => {
  const make = (name: string): string => {
    const dir = join(scratch, name);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, ".env"), "GATE=1\n");
    writeFileSync(join(dir, "node_modules/pkg/index.js"), "x");
    symlinkSync("src/a.ts", join(dir, "link"));
    return dir;
  };

  test("two equal trees compare clean, and stripped paths are left out", () => {
    const one = make("equal-1");
    const two = make("equal-2");
    rmSync(join(two, "node_modules"), { recursive: true });
    const before = hashTree(one, ["node_modules"]);
    expect([...before.keys()].some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(before.has(".env")).toBe(true);
    expect(compareTrees(before, hashTree(two, ["node_modules"]))).toEqual([]);
  });

  test("names every changed, missing and extra path", () => {
    const one = make("diff-1");
    const two = make("diff-2");
    writeFileSync(join(two, "src/a.ts"), "export const a = 2;\n");
    chmodSync(join(two, ".env"), 0o600);
    rmSync(join(two, "link"));
    symlinkSync(".env", join(two, "link"));
    writeFileSync(join(two, "extra.txt"), "new");
    rmSync(join(two, "node_modules"), { recursive: true });
    const problems = compareTrees(hashTree(one, []), hashTree(two, []));
    expect(problems).toEqual([
      "changed .env: mode 644 → 600",
      "extra extra.txt",
      "changed link: target src/a.ts → .env",
      "missing node_modules",
      "missing node_modules/pkg",
      "missing node_modules/pkg/index.js",
      "changed src/a.ts: content",
    ]);
  });
});

test("nulList reads git's -z output, so names git would quote (é, newlines) come through as they are", () => {
  expect(nulList("src/caf\u00e9.ts\0a\nb.txt\0README.md\0")).toEqual([
    "README.md",
    "a\nb.txt",
    "src/caf\u00e9.ts",
  ]);
  expect(nulList("")).toEqual([]);
});

test("the gate refuses to run off macOS in M1, naming why and when that changes", () => {
  expect(platformProblem("darwin")).toBeUndefined();
  const linux = platformProblem("linux");
  expect(linux).toContain("macOS only");
  expect(linux).toContain("M3");
});

describe("stripProblems: the gate checks plainport's strip set itself (I1)", () => {
  const facts = {
    tracked: ["README.md", "package.json", "src/a.ts", "gate-commit.txt", "gate-staged.txt"],
    sentinels: [".env", "README.md", "gate-commit.txt", "gate-staged.txt", "gate-untracked.txt"],
    planted: ["node_modules", ".next"],
  };

  test("the planted folders alone pass", () => {
    expect(stripProblems([".next", "node_modules"], facts)).toEqual([]);
  });

  test("a tracked file, .git, a sentinel or a folder holding one fails the project", () => {
    expect(stripProblems([".next", "node_modules", "src"], facts)).toEqual([
      "strip set holds src, which holds src/a.ts that git tracks",
    ]);
    expect(stripProblems([".git/objects", ".next", "node_modules"], facts)).toEqual([
      "strip set holds .git/objects, inside .git",
    ]);
    expect(stripProblems([".env", ".next", "node_modules"], facts)).toEqual([
      "strip set holds .env, which holds .env the gate added as work that must travel",
    ]);
    expect(stripProblems([".", ".next", "node_modules"], facts)).toContain(
      "strip set holds ., which holds README.md that git tracks",
    );
  });

  test("a planted regenerable folder that was not stripped fails the project", () => {
    expect(stripProblems(["node_modules"], facts)).toEqual([
      "strip set lacks .next, which the gate planted as regenerable",
    ]);
    expect(stripProblems([], facts)).toHaveLength(2);
  });
});

// The gate end to end on a tiny fixture: a local repository stands in for GitHub, the real restic does the work.
const fixtureEnv = (home: string) => ({
  PATH: "/usr/bin:/bin",
  HOME: home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
});

/** A repository to clone from, which serves any commit by its id. Returns its URL and HEAD. */
const makeRemote = (work: string): { url: string; sha: string } => {
  const remote = join(work, "remote");
  mkdirSync(remote, { recursive: true });
  const git = (...args: string[]) => {
    const ran = Bun.spawnSync(["git", ...args], { cwd: remote, env: fixtureEnv(work) });
    if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
    return ran.stdout.toString().trim();
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(remote, "README.md"), "# fixture\n");
  writeFileSync(
    join(remote, "package.json"),
    `${JSON.stringify({ name: "fixture", packageManager: "npm@10.9.0" }, null, 2)}\n`,
  );
  writeFileSync(join(remote, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  writeFileSync(join(remote, ".gitignore"), "node_modules\n.next\n.env\n");
  git("add", "-A");
  git("-c", "user.name=f", "-c", "user.email=f@example.invalid", "commit", "-qm", "fixture");
  git("config", "uploadpack.allowAnySHA1InWant", "true");
  return { url: `file://${remote}`, sha: git("rev-parse", "HEAD") };
};

// macOS only in M1: the binary has only the macOS host, whose preflight refuses on Linux (no BSD find -flags, no
// lsof), and the gate refuses to run there; host-linux arrives with M3 (Machines) and lifts this, as for the crash
// matrix's SIGKILL variant.
describeT1("gate-m1 on a fixture project", () => {
  const macTest = macOnlyTests();
  let report: GateReport;
  let sha: string;
  const work = join(scratch, "t1");

  beforeAll(async () => {
    if (!onMac) return;
    const remote = makeRemote(work);
    sha = remote.sha;
    report = await runGate({
      projects: [{ name: "fixture", url: remote.url, sha }],
      tmp: work,
      log: () => {},
    });
  }, 300_000);

  macTest("round-trips byte-identically, minus the stripped folders", () => {
    expect(report.ok).toBe(true);
    const [result] = report.projects;
    expect(result?.problems).toEqual([]);
    expect(result?.identical).toBe(true);
    expect(result?.stripped).toEqual(expect.arrayContaining([".next", "node_modules"]));
    expect(result?.files).toBeGreaterThan(10);
    // Something was stripped and --no-hydrate installed nothing back (D72, D73).
    expect(result?.stateAfter).toBe("restored-unhydrated");
  });

  macTest(
    "brings back the stash, the unpushed commit, the index, the edit, the untracked file and .env",
    () => {
      const git = report.projects[0]?.git;
      expect(git?.after).toEqual(git?.before);
      expect(git?.before.head).not.toBe(sha);
      expect(git?.before.unpushed).toBe(1);
      expect(git?.before.stashes).toHaveLength(1);
      expect(git?.before.staged).toEqual(["gate-staged.txt"]);
      expect(git?.before.modified).toEqual(["README.md"]);
      expect(git?.before.untracked).toEqual(["gate-untracked.txt"]);
    },
  );

  macTest("records the performance baseline and deletes its temp root", () => {
    const result = report.projects[0];
    for (const run of [result?.offload, result?.onload]) {
      expect(run?.wallMs).toBeGreaterThan(0);
      expect(run?.maxRssBytes).toBeGreaterThan(0);
      expect(run?.resticMaxRssBytes).toBeGreaterThan(0);
    }
    expect(result?.snapshotBytes).toBeGreaterThan(0);
    expect(result?.peakDiskBytes).toBeGreaterThan(0);
    expect(readdirSync(work).filter((name) => name.startsWith("plainport-gate-"))).toEqual([]);
    expect(existsSync(report.root)).toBe(false);
  });
});

// The gate's FAIL side (I2): a plainport that loses work after a good onload, a commit that does not exist, a Ctrl-C.
// macOS only in M1, for the same reason (host-linux arrives with M3).
describeT1("gate-m1 fails when work is lost, and cleans up after itself", () => {
  const macTest = macOnlyTests();
  const work = join(scratch, "t1-fail");
  let remote: { url: string; sha: string };
  let real: string;

  beforeAll(() => {
    if (!onMac) return;
    remote = makeRemote(work);
    real = join(work, "real", "plainport");
    const built = Bun.spawnSync(
      buildCommand(process.execPath, join(import.meta.dir, ".."), { outfile: real }),
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (built.exitCode !== 0) throw new Error(built.stderr.toString());
  }, 120_000);

  /** A plainport that runs the real one, then does `after` in the project folder when an onload succeeded. */
  const shim = (name: string, after: string): string => {
    const path = join(work, `${name}.sh`);
    writeFileSync(
      path,
      [
        "#!/bin/sh",
        `PLAINPORT_TOOLS_DIR="$(dirname "$0")" '${real}' "$@"`,
        "code=$?",
        `if [ "$1" = onload ] && [ $code -eq 0 ]; then cd "$PWD"/work/* && ${after}; fi`,
        "exit $code",
        "",
      ].join("\n"),
    );
    chmodSync(path, 0o755);
    return path;
  };
  const gate = (binary: string, sha = remote.sha) =>
    runGate({ projects: [{ name: "fixture", url: remote.url, sha }], tmp: work, binary, log: () => {} });
  const leftovers = () => readdirSync(work).filter((n) => n.startsWith("plainport-gate-"));

  macTest(
    "a .env lost after the onload fails the gate",
    async () => {
      const report = await gate(shim("drop-env", "rm .env"));
      expect(report.ok).toBe(false);
      expect(report.projects[0]?.problems).toContain("missing .env");
      expect(leftovers()).toEqual([]);
    },
    180_000,
  );

  macTest(
    "a stash lost after the onload fails the gate",
    async () => {
      const report = await gate(
        shim("drop-stash", "GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git update-ref -d refs/stash"),
      );
      expect(report.ok).toBe(false);
      expect(report.projects[0]?.problems.some((p) => p.startsWith("git differs"))).toBe(true);
      expect(leftovers()).toEqual([]);
    },
    180_000,
  );

  macTest(
    "a commit the remote does not have fails the clone cleanly and removes the temp root",
    async () => {
      const report = await gate(real, "0".repeat(40));
      expect(report.ok).toBe(false);
      expect(report.projects[0]?.problems[0]).toStartWith("git fetch");
      expect(existsSync(report.root)).toBe(false);
      expect(leftovers()).toEqual([]);
    },
    60_000,
  );

  macTest(
    "Ctrl-C removes the temp root and exits 130",
    async () => {
      const tmp = join(work, "sigint");
      mkdirSync(tmp, { recursive: true });
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "gate-m1.ts"),
          "--projects",
          `${remote.url}@${remote.sha}`,
          "--binary",
          real,
          "--min-free-gb",
          "0",
        ],
        { env: { ...process.env, TMPDIR: tmp }, stdout: "pipe", stderr: "pipe" },
      );
      const deadline = Date.now() + 60_000;
      while (readdirSync(tmp).length === 0 && Date.now() < deadline) await Bun.sleep(20);
      expect(readdirSync(tmp)).toHaveLength(1);
      await Bun.sleep(300);
      child.kill("SIGINT");
      expect(await child.exited).toBe(130);
      expect(readdirSync(tmp)).toEqual([]);
    },
    120_000,
  );
});
