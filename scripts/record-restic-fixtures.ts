// `bun scripts/record-restic-fixtures.ts`: records the restic JSON-lines fixtures that @plainport/engine-restic's
// parsing and exit-code tests replay (DESIGN.md "Testing": recorded fixtures per supported restic version). It runs
// the pinned restic from .tools/ against a tiny temp repository and writes fixtures/restic/<version>/<name>.json,
// each {args, exitCode, stdout, stderr}. The temp folder, this machine's host name and user name are replaced by
// placeholders, so fixtures carry nothing of the machine that recorded them. Everything temporary is deleted at the
// end. Scripts may spawn directly (run decision D8).

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "bun";
import { hostTarget } from "../packages/core/src/tools.ts";
import lock from "../tools.lock.json" with { type: "json" };

const checkout = resolve(import.meta.dir, "..");
const version = lock.tools.restic.version;
const restic = join(checkout, ".tools", `${hostTarget()}`, "restic");
const out = join(checkout, "fixtures", "restic", version);

export const FIXTURE_ROOT = "/tmp/restic-fixture";
export const FIXTURE_PASSWORD = "fixture-password";
export const FIXTURE_PROJECT = "01K6ZB7Q3M8XWJ5N2T4R6Y8VCD";

const root = mkdtempSync(join(tmpdir(), "plainport-restic-record-"));
const src = join(root, "src");
const repo = join(root, "repo");
const cache = join(root, "cache");

const scrub = (text: string): string =>
  text
    .replaceAll(`/private${root}`, FIXTURE_ROOT)
    .replaceAll(root, FIXTURE_ROOT)
    .replaceAll(`"hostname":"${hostname()}"`, '"hostname":"fixture-host"')
    .replaceAll(` by ${userInfo().username}@${hostname()} `, " by fixture-user@fixture-host ")
    .replaceAll(` on ${hostname()} by ${userInfo().username} `, " on fixture-host by fixture-user ")
    .replaceAll(`"username":"${userInfo().username}"`, '"username":"fixture-user"')
    .replaceAll(`"user":"${userInfo().username}"`, '"user":"fixture-user"');

const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: "/usr/bin:/bin",
  HOME: root,
  TMPDIR: root,
  RESTIC_PASSWORD: FIXTURE_PASSWORD,
  ...extra,
});

type Recorded = { args: string[]; exitCode: number | null; stdout: string; stderr: string };

const save = (name: string, recorded: Recorded): Recorded => {
  const fixture = {
    args: recorded.args.map(scrub),
    exitCode: recorded.exitCode,
    stdout: scrub(recorded.stdout),
    stderr: scrub(recorded.stderr),
  };
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  return recorded;
};

const run = (name: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) => {
  const child = spawnSync([restic, ...args], { cwd: options.cwd ?? root, env: options.env ?? env() });
  return save(name, {
    args,
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  });
};

const global = ["--repo", repo, "--cache-dir", cache];
const snapshotId = (recorded: Recorded): string => {
  const summary = recorded.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { message_type: string; snapshot_id?: string })
    .find((line) => line.message_type === "summary");
  if (summary?.snapshot_id === undefined) throw new Error(`no snapshot id in ${recorded.stdout}`);
  return summary.snapshot_id;
};

// A backup of a command's output holds a lock while the command runs. (Restic ignores SIGINT and SIGTERM while it
// blocks reading a plain --stdin, so the command form is the one that can also be interrupted.)
const holdArgs = [
  ...global,
  "backup",
  "--json",
  "--stdin-from-command",
  "--stdin-filename",
  "held",
  "--",
  "sleep",
  "30",
];
/** Starts a backup that holds a lock on the repository until it is stopped. */
const holdLock = async () => {
  const child = spawn([restic, ...holdArgs], {
    cwd: root,
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let i = 0; i < 100 && readdirSync(join(repo, "locks")).length === 0; i++) await Bun.sleep(50);
  if (readdirSync(join(repo, "locks")).length === 0)
    throw new Error("the lock holder took no lock within 5 s");
  return child;
};

try {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  mkdirSync(join(src, "sub"), { recursive: true });
  mkdirSync(join(src, "node_modules"), { recursive: true });
  writeFileSync(join(src, "a.txt"), "hello\n");
  writeFileSync(join(src, "sub", "b"), "x");
  writeFileSync(join(src, "node_modules", "dep.js"), "stripped\n");
  symlinkSync("a.txt", join(src, "link"));
  // A name and a target that both hold " -> ", the separator of `ls -l`.
  symlinkSync("x -> y", join(src, "sub", "odd -> name"));

  run("version", ["version", "--json"]);
  run("init", [...global, "init", "--json"]);
  run("init-exists", [...global, "init", "--json"]);
  const tags = ["--tag", "plainport", "--tag", `plainport:project=${FIXTURE_PROJECT}`];
  const exclude = `--exclude=${join(src, "node_modules")}`;
  const backup = run("backup", [...global, "backup", "--json", ...tags, exclude, "."], {
    cwd: src,
    // restic takes the absolute path of "." from PWD when PWD names it; otherwise from getcwd, which resolves the
    // /var -> /private/var symlink of macOS temp folders, so the exclude, anchored on src, would not match.
    env: env({ RESTIC_PROGRESS_FPS: "1000", PWD: src }),
  });
  const id = snapshotId(backup);

  chmodSync(join(src, "sub", "b"), 0o000);
  run("backup-unreadable", [...global, "backup", "--json", ...tags, `--parent=${id}`, exclude, "."], {
    cwd: src,
    env: env({ PWD: src }),
  });
  chmodSync(join(src, "sub", "b"), 0o644);

  run("snapshots", [...global, "snapshots", "--json"]);
  run("snapshots-tagged", [
    ...global,
    "snapshots",
    "--json",
    "--tag",
    `plainport,plainport:project=${FIXTURE_PROJECT}`,
  ]);
  run("snapshots-none", [...global, "snapshots", "--json", "--tag", "plainport:project=none"]);
  run("ls", [...global, "ls", "--json", id]);
  run("ls-missing", [...global, "ls", "--json", "0".repeat(64)]);
  run("snapshots-missing", [...global, "snapshots", "--json", "0".repeat(64)]);
  run("ls-long", [...global, "ls", "-l", id]);
  run("cat-tree", [...global, "cat", "tree", `${id}:/`]);
  run("cat-tree-sub", [...global, "cat", "tree", `${id}:/sub`]);
  run("restore", [...global, "restore", id, `--target=${join(root, "restored")}`, "--json"], {
    env: env({ RESTIC_PROGRESS_FPS: "1000" }),
  });
  run("check", [...global, "check", "--json"]);
  run("wrong-password", [...global, "snapshots", "--json"], {
    env: env({ RESTIC_PASSWORD: "not-the-password" }),
  });
  run("repo-missing", ["--repo", join(root, "missing"), "--cache-dir", cache, "snapshots", "--json"]);

  const holder = await holdLock();
  run("locked", [...global, "check", "--json"]);
  holder.kill("SIGINT");
  save("interrupted", {
    args: holdArgs,
    exitCode: await holder.exited,
    stdout: await new Response(holder.stdout).text(),
    stderr: await new Response(holder.stderr).text(),
  });

  // Last, since it damages the repository for good: every data pack gets garbage in place of its contents.
  for (const dir of readdirSync(join(repo, "data"))) {
    for (const pack of readdirSync(join(repo, "data", dir))) {
      chmodSync(join(repo, "data", dir, pack), 0o644);
      writeFileSync(join(repo, "data", dir, pack), "damaged");
    }
  }
  run("check-damaged", [...global, "--no-cache", "check", "--json", "--read-data-subset=100%"]);
  console.log(`recorded restic ${version} fixtures in ${out}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
