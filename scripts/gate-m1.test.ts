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
import { describeT1 } from "../test/tiers.ts";
import {
  compareTrees,
  D11_PROJECTS,
  type GateReport,
  hashTree,
  parseProjects,
  parseTimeL,
  runGate,
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

// The gate end to end on a tiny fixture: a local repository stands in for GitHub, the real restic does the work.
describeT1("gate-m1 on a fixture project", () => {
  let report: GateReport;
  let sha: string;
  const work = join(scratch, "t1");

  beforeAll(async () => {
    const remote = join(work, "remote");
    mkdirSync(remote, { recursive: true });
    const git = (...args: string[]) => {
      const ran = Bun.spawnSync(["git", ...args], {
        cwd: remote,
        env: { PATH: "/usr/bin:/bin", HOME: work, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
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
    sha = git("rev-parse", "HEAD");
    report = await runGate({
      projects: [{ name: "fixture", url: `file://${remote}`, sha }],
      tmp: work,
      log: () => {},
    });
  }, 300_000);

  test("round-trips byte-identically, minus the stripped folders", () => {
    expect(report.ok).toBe(true);
    const [result] = report.projects;
    expect(result?.problems).toEqual([]);
    expect(result?.identical).toBe(true);
    expect(result?.stripped).toEqual(expect.arrayContaining([".next", "node_modules"]));
    expect(result?.files).toBeGreaterThan(10);
    // Something was stripped and --no-hydrate installed nothing back (D72, D73).
    expect(result?.stateAfter).toBe("restored-unhydrated");
  });

  test("brings back the stash, the unpushed commit, the index, the edit, the untracked file and .env", () => {
    const git = report.projects[0]?.git;
    expect(git?.after).toEqual(git?.before);
    expect(git?.before.head).not.toBe(sha);
    expect(git?.before.unpushed).toBe(1);
    expect(git?.before.stashes).toHaveLength(1);
    expect(git?.before.staged).toEqual(["gate-staged.txt"]);
    expect(git?.before.modified).toEqual(["README.md"]);
    expect(git?.before.untracked).toEqual(["gate-untracked.txt"]);
  });

  test("records the performance baseline and deletes its temp root", () => {
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
