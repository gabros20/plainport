// Version consistency (ADR-0020): VERSION is the one version source, CHANGELOG.md follows Keep a Changelog,
// and every release commit `release: X.Y.Z` (and every v* tag) agrees with VERSION at that commit. CI runs this
// on every push to main and on every v* tag push.
//
// It checks the whole history, not only HEAD: the release routine pushes `release: X.Y.Z` followed by the next
// -dev commit, so a HEAD-only check would never see the release commit.

export type VersionInput = {
  version: string;
  changelog: string;
  headSubject: string;
  headTags: string[];
  /** HEAD only: a release VERSION there must be the release commit itself. */
  isHead?: boolean;
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Checks one commit: its VERSION, CHANGELOG.md, subject and the v* tags on it. */
export const checkVersion = ({
  version,
  changelog,
  headSubject,
  headTags,
  isHead,
}: VersionInput): string[] => {
  const problems: string[] = [];
  const dev = version.endsWith("-dev");
  if (!SEMVER.test(dev ? version.slice(0, -"-dev".length) : version)) {
    problems.push(`VERSION is "${version}"; expected X.Y.Z or X.Y.Z-dev, without leading zeros`);
  }
  if (dev && !/^## \[Unreleased\]/m.test(changelog)) {
    problems.push("VERSION is a -dev version, but CHANGELOG.md has no ## [Unreleased] section");
  }
  const release = /^release: (\S+)$/.exec(headSubject)?.[1];
  if (headSubject.startsWith("release:") && release === undefined) {
    problems.push(`"${headSubject}" starts with release: but is not of the form release: X.Y.Z`);
  }
  if (release !== undefined) {
    if (!SEMVER.test(release)) {
      problems.push(`"release: ${release}" must name a plain X.Y.Z version; a release commit drops -dev`);
    }
    if (dev)
      problems.push(`"release: ${release}" leaves VERSION at ${version}; a release commit must drop -dev`);
    if (release !== version) {
      problems.push(
        `the commit is "release: ${release}", but VERSION is ${version}; set VERSION to ${release}`,
      );
    }
    if (!new RegExp(`^## \\[${escapeRegExp(release)}\\] [—-] \\d{4}-\\d{2}-\\d{2}`, "m").test(changelog)) {
      problems.push(
        `the commit is "release: ${release}", but CHANGELOG.md has no dated ## [${release}] — YYYY-MM-DD section`,
      );
    }
  }
  // Between releases VERSION carries -dev (ADR-0020); a later commit still at X.Y.Z would build a binary that
  // claims to be the release.
  if (isHead && !dev && release === undefined && !headSubject.startsWith("release:")) {
    problems.push(
      `VERSION ${version} is a release version, but the commit is not "release: ${version}"; set VERSION to the next -dev`,
    );
  }
  for (const tag of headTags.filter((name) => name.startsWith("v"))) {
    if (dev)
      problems.push(
        `the commit is tagged ${tag}, but VERSION ${version} is a -dev version, which is never tagged`,
      );
    else if (tag !== `v${version}`) problems.push(`the commit is tagged ${tag}, but VERSION is ${version}`);
    if (release === undefined)
      problems.push(`the commit is tagged ${tag}, but "${headSubject}" is not a release commit`);
  }
  return problems;
};

const git = (...args: string[]): { ok: boolean; out: string; err: string } => {
  const run = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: run.exitCode === 0, out: run.stdout.toString(), err: run.stderr.toString().trim() };
};

/** For the commands that discover the history: a failure ends the check as a failure, never as a pass. */
const discover = (...args: string[]): string => {
  const run = git(...args);
  if (!run.ok) {
    console.error(`version check: can't read the git history: git ${args.join(" ")} failed: ${run.err}`);
    console.error(
      "version check: run it inside the plainport checkout, with its full history (fetch-depth: 0)",
    );
    process.exit(1);
  }
  return run.out;
};

const lines = (text: string): string[] => text.split("\n").filter(Boolean);

if (import.meta.main) {
  const head = discover("rev-parse", "HEAD").trim();
  const tagsAt = new Map<string, string[]>();
  for (const tag of lines(discover("tag", "-l", "v*"))) {
    const sha = discover("rev-list", "-n", "1", tag).trim();
    tagsAt.set(sha, [...(tagsAt.get(sha) ?? []), tag]);
  }
  // HEAD, every release commit, and every tagged commit (tags need not be reachable from HEAD).
  const subjects = new Map<string, string>();
  for (const line of lines(discover("log", "--format=%H%x1f%s", "HEAD"))) {
    const [sha = "", subject = ""] = line.split("\x1f");
    if (sha === head || subject.startsWith("release:") || tagsAt.has(sha)) subjects.set(sha, subject);
  }
  for (const sha of tagsAt.keys()) {
    if (!subjects.has(sha)) subjects.set(sha, discover("log", "-1", "--format=%s", sha).trim());
  }

  const problems: string[] = [];
  for (const [sha, subject] of subjects) {
    const at = (file: string) => git("show", `${sha}:${file}`);
    const version = at("VERSION");
    if (!version.ok) {
      problems.push(`${sha.slice(0, 7)} (${subject}): no VERSION file`);
      continue;
    }
    const found = checkVersion({
      version: version.out.trim(),
      changelog: at("CHANGELOG.md").out,
      headSubject: subject,
      headTags: tagsAt.get(sha) ?? [],
      isHead: sha === head,
    });
    for (const problem of found) problems.push(`${sha.slice(0, 7)} (${subject}): ${problem}`);
  }
  for (const problem of problems) console.error(`version check: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log("version check: ok");
}
