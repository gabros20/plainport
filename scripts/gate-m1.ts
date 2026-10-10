// `bun scripts/gate-m1.ts`: the M1 gate (ROADMAP M1, ADR-0017, run decisions D11 and D13). Each project is cloned
// shallowly at its pinned commit into a temp root, given work that must never be lost (an unpushed commit, a stash,
// a staged file, an uncommitted edit, an untracked file, a .env with a dummy value) and a regenerable node_modules
// and .next to strip, then offloaded and onloaded (--no-hydrate: nothing is ever installed) by a binary built from
// this checkout, against a temp store under a sandboxed HOME. The restored tree must match the one offloaded byte
// for byte (content, type, mode, symlink target, hard links, xattrs, flags) minus the stripped paths, and git must report the same facts.
// The strip set is checked by the gate itself before it is trusted (stripProblems); the project must end
// restored-unhydrated, and the offload must warn git.unpushed. The comparison is scripts/tree-compare.ts, which also
// checks hard-link groups, extended attributes and BSD flags (not ACLs). The report written by --out is the gate's raw
// result; it is attached to the release notes.
//
// Flags: --projects <list> (comma-separated D11 names or <url>@<40-hex sha>; default all five D11 projects),
// --out <file> (the report as JSON), --binary <path> (a built plainport; default: build one), --tools <dir> (restic
// and rclone; default .tools/<os>-<arch>/ in the checkout), --min-free-gb <n> (stop when less is free; default 10).
//
// One project at a time: its clone, restore and store are deleted before the next starts, and the temp root when the
// run ends, also on SIGINT or SIGTERM (exit 130). The originals are never touched; the binary refuses every path under the real home
// (PLAINPORT_TRIPWIRE_REAL_HOME), and git runs with no global or system config, so no credential helper is asked.
// Measured per project: offload and onload wall time and peak RSS (/usr/bin/time -l; the plainport process with its
// children, and restic alone through a wrapper), the store's size after the offload, and the temp root's peak size.
// macOS only in M1: plainport has only the macOS host, so the gate refuses elsewhere (platformProblem) until host-linux
// arrives with M3. Scripts may spawn directly and report failures as messages (run decisions D8 and D10).

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { hostTarget } from "../packages/core/src/tools.ts";
import { buildCommand } from "./build.ts";
import { compareTrees, hashTree, mtimeChanges, type Tree, type TreeEntry } from "./tree-compare.ts";

const CHECKOUT = resolve(import.meta.dir, "..");

export type GateProject = { name: string; url: string; sha: string; manager?: string };

/** The owner's choice for the M1 gate (D11): public demo projects of different shapes, at pinned commits. */
export const D11_PROJECTS: GateProject[] = [
  ["nextjs/saas-starter", "6e33e58b1e553a41fe22e6b941a7229a002de361", "pnpm"],
  ["t3-oss/create-t3-turbo", "8f945b7bb3bfb3ca8358d48b1ff0214079bc11ee", "pnpm + turbo monorepo"],
  ["Skolaczk/next-starter", "5de3b14ad471feb06300a5e9e92570c9668729f1", "npm"],
  ["planetscale/nextjs-planetscale-starter", "4216f41dbd0a6c7374753f794a084d346ed713fe", "Yarn Classic"],
  ["rajput-hemant/nextjs-template", "ff5a6d090f58a0b1628d68fbfa56df9436e35337", "Bun"],
].map(([name, sha, manager]) => ({
  name: name as string,
  url: `https://github.com/${name}.git`,
  sha: sha as string,
  manager: manager as string,
}));

export const parseProjects = (
  list: string | undefined,
): { ok: true; projects: GateProject[] } | { ok: false; message: string } => {
  if (list === undefined || list.trim() === "") return { ok: true, projects: D11_PROJECTS };
  const projects: GateProject[] = [];
  for (const item of list.split(",").map((s) => s.trim())) {
    const known = D11_PROJECTS.find((p) => p.name === item);
    if (known !== undefined) {
      projects.push(known);
      continue;
    }
    const at = item.lastIndexOf("@");
    const url = item.slice(0, at);
    const sha = item.slice(at + 1);
    if (at <= 0 || !/^[0-9a-f]{40}$/.test(sha))
      return {
        ok: false,
        message: `${item}: name one of ${D11_PROJECTS.map((p) => p.name).join(", ")}, or give <url>@<40-hex commit>`,
      };
    const name = (url.split("/").at(-1) ?? "project").replace(/\.git$/, "");
    projects.push({ name, url, sha });
  }
  return { ok: true, projects };
};

export type Timing = { wallMs: number; maxRssBytes: number };

/** Every run /usr/bin/time -l reported in `text` (macOS: "<s> real", "<bytes>  maximum resident set size"). */
export const parseTimeLAll = (text: string): Timing[] => {
  const walls = [...text.matchAll(/([\d.]+) real/g)].map((m) => Math.round(Number(m[1]) * 1000));
  const rss = [...text.matchAll(/(\d+)\s+maximum resident set size/g)].map((m) => Number(m[1]));
  return walls.slice(0, rss.length).map((wallMs, i) => ({ wallMs, maxRssBytes: rss[i] ?? 0 }));
};

export const parseTimeL = (text: string): Timing | undefined => parseTimeLAll(text)[0];

export { compareTrees, hashTree, type Tree, type TreeEntry };

/**
 * The strip set checked by the gate itself, not taken on plainport's word (AGENTS rule 2, DESIGN "Strip set"): nothing
 * stripped may be .git or inside it, be or hold a file git tracks, or be or hold work the gate added; and every folder
 * the gate planted as regenerable must be stripped. One line per violation.
 */
export const stripProblems = (
  strip: readonly string[],
  facts: { tracked: readonly string[]; sentinels: readonly string[]; planted: readonly string[] },
): string[] => {
  const holds = (folder: string, path: string) =>
    folder === "." || path === folder || path.startsWith(`${folder}/`);
  const problems: string[] = [];
  for (const path of strip) {
    if (path === ".git" || path.startsWith(".git/")) {
      problems.push(`strip set holds ${path}, inside .git`);
      continue;
    }
    const tracked = facts.tracked.find((file) => holds(path, file));
    if (tracked !== undefined)
      problems.push(`strip set holds ${path}, which holds ${tracked} that git tracks`);
    const sentinel = facts.sentinels.find((file) => holds(path, file));
    if (sentinel !== undefined)
      problems.push(
        `strip set holds ${path}, which holds ${sentinel} the gate added as work that must travel`,
      );
  }
  for (const folder of facts.planted)
    if (!strip.includes(folder))
      problems.push(`strip set lacks ${folder}, which the gate planted as regenerable`);
  return problems;
};

export type GitFacts = {
  head: string;
  unpushed: number;
  stashes: string[];
  staged: string[];
  modified: string[];
  untracked: string[];
};

export type RunMeasure = Timing & { exitCode: number; resticCalls: number; resticMaxRssBytes: number };

export type ProjectResult = {
  name: string;
  url: string;
  sha: string;
  manager?: string;
  ok: boolean;
  identical: boolean;
  problems: string[];
  files: number;
  bytes: number;
  stripped: string[];
  strippedBytes: number;
  mtimeChanges: number;
  git?: { before: GitFacts; after: GitFacts; fsck: boolean };
  offload?: RunMeasure;
  onload?: RunMeasure;
  offloadSettleMs?: number;
  snapshot?: string;
  /** The project's state after the onload (plainport status). */
  stateAfter?: string;
  snapshotBytes: number;
  peakDiskBytes: number;
  findings: string[];
};

export type GateReport = {
  ok: boolean;
  root: string;
  binary: string;
  projects: ProjectResult[];
  stopped?: string;
};

export type GateOptions = {
  projects: GateProject[];
  /** The folder the temp root is made in. Default: the OS temp folder. */
  tmp?: string;
  binary?: string;
  tools?: string;
  minFreeBytes?: number;
  log?: (line: string) => void;
};

const PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** Removes a tree, making its folders writable first (restic and installs leave read-only ones). */
const removeTree = (path: string): void => {
  const writable = (dir: string): void => {
    try {
      chmodSync(dir, 0o755);
      for (const entry of readdirSync(dir, { withFileTypes: true }))
        if (entry.isDirectory()) writable(join(dir, entry.name));
    } catch {}
  };
  if (!existsSync(path)) return;
  writable(path);
  rmSync(path, { recursive: true, force: true });
};

const freeBytes = (path: string): number => {
  const ran = Bun.spawnSync(["df", "-k", path], { stdout: "pipe" });
  const fields = ran.stdout.toString().trim().split("\n").at(-1)?.split(/\s+/) ?? [];
  return Number(fields[3] ?? 0) * 1024;
};

const duBytes = async (path: string): Promise<number> => {
  const child = Bun.spawn(["du", "-sk", path], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(child.stdout).text();
  await child.exited;
  return Number(out.split(/\s+/)[0] ?? 0) * 1024;
};

/** Samples a folder's size until stopped; the peak is what the gate reports as peak disk. */
const diskSampler = (path: string) => {
  let peak = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      peak = Math.max(peak, await duBytes(path));
      await Bun.sleep(200);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      peak = Math.max(peak, await duBytes(path));
      return peak;
    },
  };
};

type Ran = { code: number; out: string; err: string };

const sh = (argv: string[], cwd: string, env: Record<string, string>): Ran => {
  const ran = Bun.spawnSync(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: ran.exitCode ?? -1, out: ran.stdout.toString(), err: ran.stderr.toString() };
};

/** The last line of a --json run: its envelope. */
const envelope = (out: string): { ok?: boolean; data?: Record<string, unknown>; error?: unknown } => {
  try {
    return JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
  } catch {
    return {};
  }
};

const findingLines = (out: string): string[] =>
  out
    .trim()
    .split("\n")
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed.type === "finding"
          ? [`${parsed.finding.severity} ${parsed.finding.code}: ${parsed.finding.message}`]
          : [];
      } catch {
        return [];
      }
    });

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .sort();

/** The names in git's -z output, sorted: unquoted, whatever characters they hold. */
export const nulList = (out: string): string[] =>
  out
    .split("\0")
    .filter((name) => name !== "")
    .sort();

const gitFacts = (git: (...args: string[]) => Ran): GitFacts => ({
  head: git("rev-parse", "HEAD").out.trim(),
  unpushed: Number(git("rev-list", "--count", "@{upstream}..HEAD").out.trim() || -1),
  stashes: lines(git("stash", "list", "--format=%H %gs").out),
  staged: nulList(git("diff", "-z", "--cached", "--name-only").out),
  modified: nulList(git("diff", "-z", "--name-only").out),
  untracked: nulList(git("ls-files", "-z", "--others", "--exclude-standard").out),
});

const slug = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();

const runProject = async (
  project: GateProject,
  root: string,
  bin: string,
  realHome: string,
  log: (line: string) => void,
): Promise<ProjectResult> => {
  const result: ProjectResult = {
    ...project,
    ok: false,
    identical: false,
    problems: [],
    files: 0,
    bytes: 0,
    stripped: [],
    strippedBytes: 0,
    mtimeChanges: 0,
    snapshotBytes: 0,
    peakDiskBytes: 0,
    findings: [],
  };
  const area = join(root, slug(project.name));
  const home = join(area, "home");
  const work = join(area, "work");
  const folder = slug(project.name.split("/").at(-1) ?? "project");
  const dir = join(work, folder);
  for (const d of [home, work, join(area, "tmp"), dir]) mkdirSync(d, { recursive: true });
  const sampler = diskSampler(area);
  const fail = (problem: string): ProjectResult => {
    result.problems.push(problem);
    return result;
  };
  try {
    const gitEnv = {
      PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "plainport gate",
      GIT_AUTHOR_EMAIL: "gate@example.invalid",
      GIT_COMMITTER_NAME: "plainport gate",
      GIT_COMMITTER_EMAIL: "gate@example.invalid",
    };
    const git = (...args: string[]): Ran => sh(["git", ...args], dir, gitEnv);
    const must = (...args: string[]): string => {
      const ran = git(...args);
      if (ran.code !== 0) throw new Error(`git ${args.join(" ")}: ${ran.err.trim()}`);
      return ran.out;
    };

    // A shallow clone at the pinned commit, on a branch whose upstream is that commit.
    log(`${project.name}: cloning ${project.sha.slice(0, 7)}`);
    must("init", "-q", "-b", "gate");
    must("remote", "add", "origin", project.url);
    must("fetch", "-q", "--depth", "1", "origin", project.sha);
    must("checkout", "-q", "-B", "gate", "FETCH_HEAD");
    must("update-ref", "refs/remotes/origin/gate", project.sha);
    must("branch", "-q", "--set-upstream-to=origin/gate", "gate");

    // The work that must survive: an unpushed commit, a stash, a staged file, an edit, an untracked file and .env.
    const tracked = nulList(must("ls-files", "-z"));
    const edited =
      ["README.md", "readme.md", "Readme.md"].find((f) => tracked.includes(f)) ??
      tracked.find((f) => f.endsWith(".md")) ??
      "package.json";
    writeFileSync(join(dir, "gate-commit.txt"), "a commit that exists only on this device\n");
    must("add", "gate-commit.txt");
    must("commit", "-q", "-m", "gate: an unpushed commit");
    writeFileSync(join(dir, edited), `${readFileSync(join(dir, edited), "utf8")}\ngate: a stashed change\n`);
    must("stash", "push", "-q", "-m", "gate stash");
    writeFileSync(join(dir, "gate-staged.txt"), "staged, not committed\n");
    must("add", "gate-staged.txt");
    writeFileSync(
      join(dir, edited),
      `${readFileSync(join(dir, edited), "utf8")}\ngate: an uncommitted edit\n`,
    );
    writeFileSync(join(dir, "gate-untracked.txt"), "untracked\n");
    const envFile = join(dir, ".env");
    writeFileSync(
      envFile,
      `${existsSync(envFile) ? readFileSync(envFile, "utf8") : ""}GATE_DUMMY=not-a-secret-gate-value\n`,
    );
    // Regenerable folders a plugin claims: stand-ins, never an install (D13).
    mkdirSync(join(dir, "node_modules/gate-placeholder"), { recursive: true });
    writeFileSync(join(dir, "node_modules/gate-placeholder/index.js"), "module.exports = 1;\n");
    mkdirSync(join(dir, ".next/cache"), { recursive: true });
    writeFileSync(join(dir, ".next/cache/gate.txt"), "cache\n");
    git("update-index", "-q", "--refresh");
    git("status", "--porcelain");
    const before = gitFacts(git);
    const sentinels = [".env", edited, "gate-commit.txt", "gate-staged.txt", "gate-untracked.txt"];
    const planted = ["node_modules", ".next"];

    // plainport in a sandbox: its own HOME and store, the real home refused, no global git config.
    const env: Record<string, string> = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local/share"),
      TMPDIR: join(area, "tmp"),
      PATH,
      LANG: "en_US.UTF-8",
      PLAINPORT_STORE_PASSWORD: randomBytes(16).toString("hex"),
      PLAINPORT_TRIPWIRE_REAL_HOME: realHome,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const plainport = (...args: string[]): Ran => sh([join(bin, "plainport"), ...args], area, env);
    const timeFile = join(area, "time.txt");
    const resticLog = join(bin, "restic-time.txt");
    const timed = async (...args: string[]): Promise<{ ran: Ran; measure: RunMeasure }> => {
      rmSync(timeFile, { force: true });
      writeFileSync(resticLog, "");
      const child = Bun.spawn(["/usr/bin/time", "-l", "-o", timeFile, join(bin, "plainport"), ...args], {
        cwd: area,
        env,
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
      active.child = child;
      const [out, err] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      await child.exited;
      active.child = undefined;
      const timing = parseTimeL(readFileSync(timeFile, "utf8")) ?? { wallMs: 0, maxRssBytes: 0 };
      const restic = parseTimeLAll(readFileSync(resticLog, "utf8"));
      return {
        ran: { code: child.exitCode ?? -1, out, err },
        measure: {
          ...timing,
          exitCode: child.exitCode ?? -1,
          resticCalls: restic.length,
          resticMaxRssBytes: Math.max(0, ...restic.map((r) => r.maxRssBytes)),
        },
      };
    };
    const journal = join(home, ".local/state/plainport/journal");
    const settle = async (): Promise<number> => {
      const start = Date.now();
      const open = () => (existsSync(journal) ? readdirSync(journal).filter((n) => n.endsWith(".json")) : []);
      while (open().length > 0 && Date.now() - start < 600_000) await Bun.sleep(50);
      if (open().length > 0) throw new Error(`journals still open after 10 minutes: ${open().join(", ")}`);
      return Date.now() - start;
    };

    const init = plainport(
      "init",
      "--root",
      `work=${work}`,
      "--store-path",
      "~/store",
      "--device",
      "gate",
      "--yes",
      "--json",
    );
    if (init.code !== 0) return fail(`init exited ${init.code}: ${init.err.trim()} ${init.out.trim()}`);

    // The plan names the strip set; the offload runs that very plan.
    const target = `work:${folder}`;
    const dry = plainport("offload", target, "--dry-run", "--json");
    const plan = envelope(dry.out).data as
      | {
          id?: string;
          strip?: { path: string; bytes?: number }[];
          include?: { files: number; bytes: number };
        }
      | undefined;
    if (dry.code !== 0 || plan === undefined)
      return fail(`offload --dry-run exited ${dry.code}: ${dry.out.trim()}`);
    // A dry run must save its plan, so the offload runs the strip set the gate checked and left out.
    if (plan.id === undefined) return fail("offload --dry-run returned no plan id");
    result.stripped = (plan.strip ?? []).map((s) => s.path).sort();
    result.strippedBytes = (plan.strip ?? []).reduce((sum, s) => sum + (s.bytes ?? 0), 0);
    result.files = plan.include?.files ?? 0;
    result.bytes = plan.include?.bytes ?? 0;
    const badStrip = stripProblems(result.stripped, {
      tracked: nulList(must("ls-files", "-z")),
      sentinels,
      planted,
    });
    if (badStrip.length > 0) {
      result.problems.push(...badStrip);
      return result;
    }
    const reference = hashTree(dir, result.stripped);

    log(`${project.name}: offload (${result.files} files, strip ${result.stripped.join(", ") || "nothing"})`);
    const off = await timed("offload", target, "--plan", plan.id, "--json");
    result.offload = off.measure;
    result.findings.push(...findingLines(off.ran.out));
    const offEnvelope = envelope(off.ran.out);
    if (off.ran.code !== 0 || offEnvelope.ok !== true)
      return fail(
        `offload exited ${off.ran.code}: ${off.ran.out.trim().split("\n").at(-1)} ${off.ran.err.trim()}`,
      );
    result.snapshot = String(offEnvelope.data?.snapshot ?? "");
    result.offloadSettleMs = await settle();
    if (existsSync(dir)) return fail(`the offload left ${dir} in place`);
    result.snapshotBytes = await duBytes(join(home, "store"));

    log(`${project.name}: onload --no-hydrate`);
    const on = await timed("onload", target, "--no-hydrate", "--json");
    result.onload = on.measure;
    result.findings.push(...findingLines(on.ran.out));
    if (![0, 10].includes(on.ran.code) || envelope(on.ran.out).data === undefined)
      return fail(
        `onload exited ${on.ran.code}: ${on.ran.out.trim().split("\n").at(-1)} ${on.ran.err.trim()}`,
      );
    await settle();
    const status = envelope(plainport("status", target, "--json").out).data as { state?: string } | undefined;
    result.stateAfter = status?.state ?? "unknown";
    // Something was stripped and --no-hydrate installs nothing back, so the project waits for its install (D72, D73).
    const expected = result.stripped.length > 0 ? "restored-unhydrated" : "local";
    if (result.stateAfter !== expected)
      result.problems.push(`state after the onload is ${result.stateAfter}, not ${expected}`);
    // The unpushed commit and the stash are the snapshot's alone: offload must say so.
    if (!result.findings.some((f) => f.startsWith("warn git.unpushed:")))
      result.problems.push("offload raised no git.unpushed warning for the unpushed commit and the stash");

    const restored = hashTree(dir, []);
    for (const path of result.stripped)
      if (restored.has(path)) result.problems.push(`stripped ${path} came back without an install`);
    const problems = compareTrees(reference, hashTree(dir, result.stripped));
    result.problems.push(...problems);
    result.identical = problems.length === 0;
    result.mtimeChanges = mtimeChanges(reference, restored);
    const after = gitFacts(git);
    const fsck = git("fsck", "--no-progress", "--connectivity-only").code === 0;
    result.git = { before, after, fsck };
    if (JSON.stringify(before) !== JSON.stringify(after))
      result.problems.push(`git differs: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    if (!fsck) result.problems.push("git fsck failed on the restored repository");
    result.ok = result.problems.length === 0;
    return result;
  } catch (error) {
    return fail((error as Error).message);
  } finally {
    result.peakDiskBytes = await sampler.stop();
    removeTree(area);
  }
};

/** What a Ctrl-C must clean up: the temp root, and the plainport run in progress (main's signal handlers). */
const active: { root?: string; child?: Bun.Subprocess } = {};

/**
 * Stops the run in progress and removes the temp root; main calls it on SIGINT and SIGTERM. The plainport run has its
 * own process group (detached), so it gets SIGTERM and stops its restic itself, then whatever is left is killed.
 */
export const abandon = async (): Promise<void> => {
  const child = active.child;
  if (child !== undefined && child.exitCode === null) {
    const group = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid, signal);
      } catch {}
    };
    group("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(10_000)]);
    group("SIGKILL");
  }
  if (active.root !== undefined) removeTree(active.root);
};

/** Why the gate can't run on this platform, if it can't: in M1 plainport has only the macOS host, whose preflight
 * refuses on Linux (no BSD find -flags, no lsof), so every row would be a false FAIL. host-linux arrives with M3. */
export const platformProblem = (platform: string = process.platform): string | undefined =>
  platform === "darwin"
    ? undefined
    : `the M1 gate runs on macOS only: plainport has only the macOS host until host-linux arrives with M3, so on ${platform} its preflight refuses every offload; run it on a Mac`;

/** Why the gate can't start with these tools, if it can't (D10: a message with its fix). */
export const toolsProblem = (tools: string): string | undefined => {
  const missing = ["restic", "rclone"].filter((name) => !existsSync(join(tools, name)));
  return missing.length === 0
    ? undefined
    : `${missing.join(" and ")} not found in ${tools}; run \`bun scripts/fetch-tools.ts\` first, or pass --tools <dir>`;
};

/** A restic that runs the real one under /usr/bin/time -l, appending each call's figures to restic-time.txt. */
const resticWrapper = (real: string, log: string): string =>
  `#!/bin/sh\nexec /usr/bin/time -l -a -o '${log}' '${real}' "$@"\n`;

/** An expected failure the gate reports as a message, not a stack trace (D10). */
export class GateError extends Error {}

export const runGate = async (options: GateOptions): Promise<GateReport> => {
  const log = options.log ?? ((line: string) => console.error(line));
  const realHome = resolve(process.env.PLAINPORT_TRIPWIRE_REAL_HOME ?? homedir());
  const unsupported = platformProblem();
  if (unsupported !== undefined) throw new GateError(unsupported);
  const tools = options.tools ?? join(CHECKOUT, ".tools", hostTarget() ?? "unsupported");
  const problem = toolsProblem(tools);
  if (problem !== undefined) throw new GateError(problem);
  const root = mkdtempSync(join(options.tmp ?? tmpdir(), "plainport-gate-"));
  active.root = root;
  const report: GateReport = { ok: false, root, binary: "", projects: [] };
  try {
    const bin = join(root, "bin");
    mkdirSync(join(bin, "real"), { recursive: true });
    if (options.binary !== undefined) copyFileSync(options.binary, join(bin, "plainport"));
    else {
      const built = Bun.spawnSync(
        buildCommand(process.execPath, CHECKOUT, { outfile: join(bin, "plainport") }),
        {
          cwd: CHECKOUT,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      if (built.exitCode !== 0) throw new Error(`build failed: ${built.stderr.toString()}`);
    }
    chmodSync(join(bin, "plainport"), 0o755);
    report.binary = sh([join(bin, "plainport"), "--version"], root, { PATH }).out.trim();
    copyFileSync(join(tools, "restic"), join(bin, "real/restic"));
    copyFileSync(join(tools, "rclone"), join(bin, "rclone"));
    chmodSync(join(bin, "real/restic"), 0o755);
    chmodSync(join(bin, "rclone"), 0o755);
    writeFileSync(join(bin, "restic"), resticWrapper(join(bin, "real/restic"), join(bin, "restic-time.txt")));
    chmodSync(join(bin, "restic"), 0o755);

    for (const project of options.projects) {
      const free = freeBytes(root);
      if (free < (options.minFreeBytes ?? 10 * 1024 ** 3)) {
        report.stopped = `only ${(free / 1024 ** 3).toFixed(1)} GB free before ${project.name}; stopped`;
        log(report.stopped);
        break;
      }
      const result = await runProject(project, root, bin, realHome, log);
      report.projects.push(result);
      log(`${project.name}: ${result.ok ? "PASS" : `FAIL\n  ${result.problems.join("\n  ")}`}`);
    }
    report.ok =
      report.stopped === undefined &&
      report.projects.length === options.projects.length &&
      report.projects.every((p) => p.ok);
    return report;
  } finally {
    removeTree(root);
    active.root = undefined;
  }
};

const mb = (bytes: number | undefined): string => `${((bytes ?? 0) / 1024 ** 2).toFixed(1)} MB`;
const sec = (ms: number | undefined): string => `${((ms ?? 0) / 1000).toFixed(2)} s`;

const USAGE =
  "usage: bun scripts/gate-m1.ts [--projects <list>] [--out <file>] [--binary <path>] [--tools <dir>] [--min-free-gb <n>]";

function stop(message: string, code = 1): never {
  console.error(`gate-m1: ${message}`);
  process.exit(code);
}

const main = async (): Promise<void> => {
  let values: { projects?: string; out?: string; binary?: string; tools?: string; "min-free-gb"?: string };
  try {
    values = parseArgs({
      args: Bun.argv.slice(2),
      options: {
        projects: { type: "string" },
        out: { type: "string" },
        binary: { type: "string" },
        tools: { type: "string" },
        "min-free-gb": { type: "string" },
      },
    }).values;
  } catch (error) {
    stop(`${(error as Error).message}\n${USAGE}`, 2);
  }
  const parsed = parseProjects(values.projects);
  if (!parsed.ok) stop(parsed.message, 2);
  const minFree = Number(values["min-free-gb"] ?? 10);
  if (!Number.isFinite(minFree) || minFree < 0)
    stop(`--min-free-gb takes a number of GB, not ${values["min-free-gb"]}`, 2);
  if (values.binary !== undefined && !existsSync(values.binary))
    stop(`--binary ${values.binary} does not exist`, 2);
  // Ctrl-C or a kill must not leave a clone, a restore and a store behind (D13).
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, async () => {
      await abandon();
      console.error(`gate-m1: stopped by ${signal}; the temp root is removed`);
      process.exit(130);
    });
  let report: GateReport;
  try {
    report = await runGate({
      projects: parsed.projects,
      ...(values.binary === undefined ? {} : { binary: resolve(values.binary) }),
      ...(values.tools === undefined ? {} : { tools: resolve(values.tools) }),
      minFreeBytes: minFree * 1024 ** 3,
    });
  } catch (error) {
    if (error instanceof GateError) stop(error.message);
    stop(`unexpected failure: ${(error as Error).message}`);
  }
  if (values.out !== undefined) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`gate-m1 with ${report.binary}`);
  for (const p of report.projects) {
    console.log(
      [
        `${p.ok ? "PASS" : "FAIL"} ${p.name}@${p.sha.slice(0, 7)} (${p.manager ?? "?"})`,
        `  ${p.files} files, ${mb(p.bytes)}; identical ${p.identical}; stripped ${p.stripped.join(", ") || "nothing"} (${mb(p.strippedBytes)}); mtimes changed ${p.mtimeChanges}`,
        `  git: unpushed ${p.git?.after.unpushed}, stashes ${p.git?.after.stashes.length}, staged ${p.git?.after.staged.join(" ")}, modified ${p.git?.after.modified.join(" ")}, untracked ${p.git?.after.untracked.join(" ")}, fsck ${p.git?.fsck}`,
        `  offload ${sec(p.offload?.wallMs)} rss ${mb(p.offload?.maxRssBytes)} (restic ${mb(p.offload?.resticMaxRssBytes)}, ${p.offload?.resticCalls} calls), detached delete ${sec(p.offloadSettleMs)}`,
        `  onload  ${sec(p.onload?.wallMs)} rss ${mb(p.onload?.maxRssBytes)} (restic ${mb(p.onload?.resticMaxRssBytes)}, ${p.onload?.resticCalls} calls), exit ${p.onload?.exitCode}, then ${p.stateAfter}`,
        `  store ${mb(p.snapshotBytes)}; peak disk ${mb(p.peakDiskBytes)}`,
        ...p.findings.map((f) => `  finding: ${f}`),
        ...p.problems.map((problem) => `  problem: ${problem}`),
      ].join("\n"),
    );
  }
  if (report.stopped !== undefined) console.log(report.stopped);
  console.log(report.ok ? "gate-m1: PASS" : "gate-m1: FAIL");
  process.exit(report.ok ? 0 : 1);
};

if (import.meta.main) await main();
