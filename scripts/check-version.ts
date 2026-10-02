// Version consistency (ADR-0020): VERSION is the one version source, CHANGELOG.md follows Keep a Changelog,
// and a release commit `release: X.Y.Z` (and any v* tag on it) agrees with VERSION. CI runs this on every push.

export type VersionInput = {
  version: string;
  changelog: string;
  headSubject: string;
  headTags: string[];
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const checkVersion = ({ version, changelog, headSubject, headTags }: VersionInput): string[] => {
  const problems: string[] = [];
  if (!/^\d+\.\d+\.\d+(-dev)?$/.test(version)) {
    problems.push(`VERSION is "${version}"; expected X.Y.Z or X.Y.Z-dev`);
  }
  const dev = version.endsWith("-dev");
  if (dev && !/^## \[Unreleased\]/m.test(changelog)) {
    problems.push("VERSION is a -dev version, but CHANGELOG.md has no ## [Unreleased] section");
  }
  const release = /^release: (\S+)$/.exec(headSubject)?.[1];
  if (release !== undefined) {
    if (release !== version) {
      problems.push(`HEAD is "release: ${release}", but VERSION is ${version}; set VERSION to ${release}`);
    }
    if (!new RegExp(`^## \\[${escapeRegExp(release)}\\] [—-] \\d{4}-\\d{2}-\\d{2}`, "m").test(changelog)) {
      problems.push(
        `HEAD is "release: ${release}", but CHANGELOG.md has no dated ## [${release}] — YYYY-MM-DD section`,
      );
    }
  }
  for (const tag of headTags.filter((name) => name.startsWith("v"))) {
    if (dev)
      problems.push(`HEAD is tagged ${tag}, but VERSION ${version} is a -dev version, which is never tagged`);
    else if (tag !== `v${version}`) problems.push(`HEAD is tagged ${tag}, but VERSION is ${version}`);
  }
  return problems;
};

const git = (...args: string[]): string => {
  const run = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString()}`);
  return run.stdout.toString();
};

if (import.meta.main) {
  const root = git("rev-parse", "--show-toplevel").trim();
  const problems = checkVersion({
    version: (await Bun.file(`${root}/VERSION`).text()).trim(),
    changelog: await Bun.file(`${root}/CHANGELOG.md`).text(),
    headSubject: git("log", "-1", "--format=%s").trim(),
    headTags: git("tag", "--points-at", "HEAD").split("\n").filter(Boolean),
  });
  for (const problem of problems) console.error(`version check: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log("version check: ok");
}
