import { expect, test } from "bun:test";
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
