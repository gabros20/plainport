import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVersion } from "./check-version.ts";

const devChangelog = "# Changelog\n\n## [Unreleased]\n\n### Added\n- something\n";
const releaseChangelog =
  "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] — 2026-11-01\n\n### Added\n- something\n";

test("a -dev version with an [Unreleased] section passes", () => {
  expect(
    checkVersion({
      version: "0.1.0-dev",
      changelog: devChangelog,
      headSubject: "m1(task 1): x",
      headTags: [],
    }),
  ).toEqual([]);
});

test("VERSION must be semver, optionally with -dev", () => {
  const problems = checkVersion({ version: "0.1", changelog: devChangelog, headSubject: "x", headTags: [] });
  expect(problems.join("\n")).toContain("VERSION");
});

test("a -dev version needs an [Unreleased] section", () => {
  const problems = checkVersion({
    version: "0.1.0-dev",
    changelog: "# Changelog\n",
    headSubject: "x",
    headTags: [],
  });
  expect(problems.join("\n")).toContain("[Unreleased]");
});

test("a release commit must match VERSION, drop -dev and date its changelog section", () => {
  expect(
    checkVersion({
      version: "0.1.0",
      changelog: releaseChangelog,
      headSubject: "release: 0.1.0",
      headTags: ["v0.1.0"],
    }),
  ).toEqual([]);
  expect(
    checkVersion({
      version: "0.1.0-dev",
      changelog: releaseChangelog,
      headSubject: "release: 0.1.0",
      headTags: [],
    }).join("\n"),
  ).toContain("release: 0.1.0");
  expect(
    checkVersion({
      version: "0.2.0",
      changelog: releaseChangelog,
      headSubject: "release: 0.2.0",
      headTags: [],
    }).join("\n"),
  ).toContain("[0.2.0]");
});

test("a v* tag on HEAD must match VERSION", () => {
  const problems = checkVersion({
    version: "0.1.0",
    changelog: releaseChangelog,
    headSubject: "release: 0.1.0",
    headTags: ["v0.1.1"],
  });
  expect(problems.join("\n")).toContain("v0.1.1");
  expect(
    checkVersion({
      version: "0.1.0-dev",
      changelog: devChangelog,
      headSubject: "x",
      headTags: ["v0.1.0-dev"],
    }).join("\n"),
  ).toContain("-dev");
});

test("VERSION must be strict semver: no leading zeros", () => {
  for (const version of ["01.2.3-dev", "1.02.3", "1.2.03", "1.2.3-rc1", "v1.2.3"]) {
    const problems = checkVersion({ version, changelog: devChangelog, headSubject: "x", headTags: [] });
    expect({ version, flagged: problems.some((p) => p.startsWith("VERSION is")) }).toEqual({
      version,
      flagged: true,
    });
  }
});

test("a release commit must drop -dev even when VERSION and the changelog agree", () => {
  const changelog = "# Changelog\n\n## [0.1.0-dev] — 2026-11-01\n";
  const problems = checkVersion({
    version: "0.1.0-dev",
    changelog,
    headSubject: "release: 0.1.0-dev",
    headTags: [],
  });
  expect(problems.join("\n")).toContain("drop -dev");
});

test("a v* tag must sit on a release commit", () => {
  const problems = checkVersion({
    version: "0.1.0",
    changelog: releaseChangelog,
    headSubject: "fix: x",
    headTags: ["v0.1.0"],
  });
  expect(problems.join("\n")).toContain("not a release commit");
});

// The script checks the whole history, not only HEAD: a bad release commit followed by the next -dev commit,
// or a bad tag on an older commit, must still fail.
describe("bun scripts/check-version.ts over a git history", () => {
  let repo = "";
  const script = join(import.meta.dir, "check-version.ts");
  const git = (...args: string[]) => {
    const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: repo,
      stderr: "pipe",
    });
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  };
  const commit = (subject: string, version: string, changelog: string) => {
    writeFileSync(join(repo, "VERSION"), `${version}\n`);
    writeFileSync(join(repo, "CHANGELOG.md"), changelog);
    git("add", "-A");
    git("commit", "-q", "-m", subject);
  };
  const check = () => {
    const run = Bun.spawnSync([process.execPath, script], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    return { exitCode: run.exitCode, output: run.stdout.toString() + run.stderr.toString() };
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "plainport-version-"));
    git("init", "-q");
    commit("start", "0.1.0-dev", devChangelog);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test("a clean release, its tag and the next -dev commit pass", () => {
    commit("release: 0.1.0", "0.1.0", releaseChangelog);
    git("tag", "v0.1.0");
    commit("next: 0.2.0-dev", "0.2.0-dev", releaseChangelog);
    expect(check()).toEqual({ exitCode: 0, output: "version check: ok\n" });
  });

  test("a bad release commit behind HEAD fails", () => {
    commit("release: 0.1.0", "0.1.1", releaseChangelog);
    commit("next: 0.2.0-dev", "0.2.0-dev", releaseChangelog);
    const result = check();
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('"release: 0.1.0", but VERSION is 0.1.1');
  });

  test("a tag that does not match VERSION at its commit fails, even behind HEAD", () => {
    commit("release: 0.1.0", "0.1.0", releaseChangelog);
    git("tag", "v0.1.1");
    commit("next: 0.2.0-dev", "0.2.0-dev", releaseChangelog);
    const result = check();
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("tagged v0.1.1, but VERSION is 0.1.0");
  });
});
