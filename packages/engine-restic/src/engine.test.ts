import { describe, expect, test } from "bun:test";
import { fail, finding, type PlainportEvent, type Result } from "@plainport/contract";
import type { EntryMeta, RunContext } from "@plainport/core";
import { type ResticEngineOptions, resticEngine } from "./engine.ts";
import { decodeTag, encodeTag, LongListingReader, parseLine, parseTree } from "./parse.ts";
import {
  edited,
  FIXTURE_PASSWORD,
  FIXTURE_PROJECT,
  FIXTURE_ROOT,
  type Fixture,
  fixture,
  fixtureNames,
  PINNED_VERSION,
  replayHost,
  snapshotIdOf,
  stdoutLines,
  summaryOf,
} from "./testing.ts";

// Ids and counts come from the fixtures, so re-recording them (a restic bump) changes no test.
const BACKUP_ID = snapshotIdOf("backup");
const INCOMPLETE_ID = snapshotIdOf("backup-unreadable");
const backupSummary = summaryOf("backup");
const restoreSummary = summaryOf("restore");
const MISSING_ID = "0".repeat(64);
const SRC = `${FIXTURE_ROOT}/src`;
const REPO = `${FIXTURE_ROOT}/repo`;
const TAGS = ["plainport", `plainport:project=${FIXTURE_PROJECT}`];

const setup = (queue: (Fixture | ReturnType<typeof fail>)[], options: Partial<ResticEngineOptions> = {}) => {
  const host = replayHost([fixture("version"), ...queue]);
  const engine = resticEngine({
    host,
    restic: "/opt/plainport/restic",
    repository: REPO,
    password: FIXTURE_PASSWORD,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/home",
      RESTIC_PASSWORD_FILE: "/tmp/leak",
      RESTIC_REPOSITORY: "/x",
    },
    cacheDir: `${FIXTURE_ROOT}/cache`,
    retryLock: null,
    ...options,
  });
  const events: PlainportEvent[] = [];
  const ctx: RunContext = { op: "op-1", emit: (event) => events.push(event) };
  return { host, engine, events, ctx };
};

const failure = <T>(result: Result<T>) => {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
  return result;
};
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.finding)}`);
  return result.value;
};

describe("restic fixtures: every recorded JSON line parses", () => {
  test(`fixtures exist for the pinned restic ${PINNED_VERSION}`, () => {
    expect(fixtureNames()).toContain("backup");
    expect(fixtureNames().length).toBeGreaterThanOrEqual(15);
  });

  for (const name of fixtureNames()) {
    test(name, () => {
      const recorded = fixture(name);
      if (name.startsWith("cat-tree")) {
        expect(parseTree(recorded.stdout).ok).toBe(true);
        return;
      }
      for (const text of `${recorded.stdout}\n${recorded.stderr}`.split("\n")) {
        if (!text.startsWith("{")) continue;
        const line = parseLine(text);
        expect(line.ok).toBe(true);
      }
    });
  }
});

describe("restic engine: the version check", () => {
  test("runs `restic version --json` once, before the first command, in capture mode", async () => {
    const { host, engine } = setup([fixture("snapshots"), fixture("snapshots")]);
    value(await engine.list({}));
    value(await engine.list({}));
    expect(host.calls.map((call) => call.args?.join(" "))[0]).toBe("version --json");
    expect(host.calls[0]?.capture).toBeDefined();
    expect(host.calls.filter((call) => call.args?.includes("version"))).toHaveLength(1);
  });

  test("a restic that is not the pinned version is refused before it touches the repository", async () => {
    const other = edited(fixture("version"), {
      stdout: fixture("version").stdout.replace(`"version":"${PINNED_VERSION}"`, '"version":"0.16.4"'),
    });
    const host = replayHost([other]);
    const engine = resticEngine({ host, restic: "/r", repository: REPO, password: "p", env: {} });
    const result = failure(await engine.list({}));
    expect(result.exitCode).toBe(6);
    expect(result.finding.code).toBe("restic.version-mismatch");
    expect(result.finding.message).toContain("0.16.4");
    expect(result.finding.message).toContain(PINNED_VERSION);
    expect(result.finding.fix).toBeDefined();
    expect(host.calls).toHaveLength(1);
  });

  // restic 0.17 printed `version --json` without message_type. plainport needs 0.18.0 or later (D93), but a line
  // without it must still parse, so an old restic is named as the wrong version rather than as unreadable output.
  const withoutType = (version: string) =>
    edited(fixture("version"), {
      stdout: `${JSON.stringify({ version, go_version: "go1.23.1", go_os: "darwin", go_arch: "arm64" })}\n`,
    });

  test("a version line without message_type, as restic 0.17 printed it, passes the check", async () => {
    const host = replayHost([withoutType(PINNED_VERSION), fixture("snapshots")]);
    const engine = resticEngine({
      host,
      restic: "/r",
      repository: REPO,
      password: "p",
      env: {},
    });
    expect(value(await engine.list({})).length).toBeGreaterThan(0);
  });

  test("restic 0.17.1 is refused as restic.version-mismatch: plainport needs 0.18.0 or later (D93)", async () => {
    const host = replayHost([withoutType("0.17.1")]);
    const engine = resticEngine({ host, restic: "/r", repository: REPO, password: "p", env: {} });
    const result = failure(await engine.list({}));
    expect(result.finding.code).toBe("restic.version-mismatch");
    expect(result.finding.message).toContain("0.17.1");
    expect(host.calls).toHaveLength(1);
  });

  test("the version line is still checked strictly: a missing or malformed version, or another message type, is refused", async () => {
    const base = fixture("version");
    for (const stdout of [
      '{"go_version":"go1.23.1","go_os":"darwin","go_arch":"arm64"}\n',
      '{"version":17,"go_version":"go1.23.1","go_os":"darwin","go_arch":"arm64"}\n',
      `{"version":"${PINNED_VERSION}"}\n`,
      `{"message_type":"summary","version":"${PINNED_VERSION}","go_version":"go1.23.1","go_os":"darwin","go_arch":"arm64"}\n`,
    ]) {
      const host = replayHost([edited(base, { stdout })]);
      const engine = resticEngine({
        host,
        restic: "/r",
        repository: REPO,
        password: "p",
        env: {},
      });
      expect({ stdout, code: failure(await engine.list({})).finding.code }).toEqual({
        stdout,
        code: "restic.output-invalid",
      });
      expect(host.calls).toHaveLength(1);
    }
  });
});

describe("restic engine: how restic is run", () => {
  test("the password reaches restic only through RESTIC_PASSWORD; inherited RESTIC_ variables are dropped", async () => {
    const { host, engine } = setup([fixture("init")]);
    value(await engine.init());
    expect(host.calls).toHaveLength(2);
    for (const call of host.calls) {
      expect(call.command).toBe("/opt/plainport/restic");
      expect(call.args?.join(" ")).not.toContain(FIXTURE_PASSWORD);
      // `restic version` needs no repository, so it gets no password.
      expect(call.env.RESTIC_PASSWORD).toBe(call.args?.[0] === "version" ? undefined : FIXTURE_PASSWORD);
      expect(call.env.RESTIC_PASSWORD_FILE).toBeUndefined();
      expect(call.env.RESTIC_REPOSITORY).toBeUndefined();
      expect(call.env.HOME).toBe("/tmp/home");
    }
    expect(host.calls[1]?.args).toEqual([
      "--repo",
      REPO,
      "--cache-dir",
      `${FIXTURE_ROOT}/cache`,
      "init",
      "--json",
    ]);
  });

  test("--retry-lock is passed when set", async () => {
    const { host, engine } = setup([fixture("snapshots")], { retryLock: "2m" });
    value(await engine.list({}));
    expect(host.calls[1]?.args).toContain("--retry-lock=2m");
  });
});

describe("restic engine: init", () => {
  test("returns the new repository's id", async () => {
    const { engine } = setup([fixture("init")]);
    expect(value(await engine.init())).toEqual({
      id: String(stdoutLines(fixture("init"))[0]?.id),
    });
  });

  test("a repository that already exists is restic.repo-exists", async () => {
    const { engine } = setup([fixture("init-exists")]);
    const result = failure(await engine.init());
    expect(result.finding.code).toBe("restic.repo-exists");
    expect(result.exitCode).toBe(6);
  });
});

describe("restic engine: snapshot", () => {
  test("runs backup of the folder itself, with tags, parent and anchored excludes, and parses the summary", async () => {
    const { host, engine, ctx } = setup([fixture("backup")]);
    const result = value(
      await engine.snapshot({ dir: SRC, excludes: ["node_modules"], parent: INCOMPLETE_ID, tags: TAGS }, ctx),
    );
    expect(result.id).toBe(BACKUP_ID);
    expect(result.stats).toEqual({
      filesNew: backupSummary.files_new,
      filesChanged: backupSummary.files_changed,
      filesUnmodified: backupSummary.files_unmodified,
      dirsNew: backupSummary.dirs_new,
      dirsChanged: backupSummary.dirs_changed,
      dirsUnmodified: backupSummary.dirs_unmodified,
      dataAdded: backupSummary.data_added,
      totalFilesProcessed: backupSummary.total_files_processed,
      totalBytesProcessed: backupSummary.total_bytes_processed,
    });
    const call = host.calls[1];
    expect(call?.cwd).toBe(SRC);
    expect(call?.env.PWD).toBe(SRC);
    expect(call?.args).toEqual([
      "--repo",
      REPO,
      "--cache-dir",
      `${FIXTURE_ROOT}/cache`,
      "backup",
      "--json",
      "--tag",
      "plainport",
      "--tag",
      `plainport:project=${FIXTURE_PROJECT}`,
      `--parent=${INCOMPLETE_ID}`,
      `--exclude=${SRC}/node_modules`,
      ".",
    ]);
    expect(call?.capture).toBeUndefined();
  });

  test("an exclude names one path: glob characters and backslashes are escaped", async () => {
    const { host, engine, ctx } = setup([fixture("backup")]);
    value(await engine.snapshot({ dir: SRC, excludes: ["a/we[ir]d*?\\x"], tags: [] }, ctx));
    expect(host.calls[1]?.args).toContain(`--exclude=${SRC}/a/we\\[ir\\]d\\*\\?\\\\x`);
  });

  test("tag values percent-encode , and % (run decision D26), since restic splits --tag at commas", async () => {
    const { host, engine, ctx } = setup([fixture("backup")]);
    value(await engine.snapshot({ dir: SRC, excludes: [], tags: ["plainport:path=clients/a,b 100%"] }, ctx));
    expect(host.calls[1]?.args).toContain("plainport:path=clients/a%2Cb 100%25");
    expect(host.calls[1]?.args?.join(" ")).not.toContain("a,b");
  });

  test("status lines become progress events of the snapshot phase", async () => {
    const { engine, events, ctx } = setup([fixture("backup")]);
    value(await engine.snapshot({ dir: SRC, excludes: [], tags: [] }, ctx));
    const progress = events.filter((event) => event.type === "progress");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toEqual({
      type: "progress",
      op: "op-1",
      phase: "snapshot",
      bytesDone: backupSummary.total_bytes_processed,
      bytesTotal: backupSummary.total_bytes_processed,
    });
  });

  test("exit 3 (unreadable files) is a hard failure naming the files, never a partial success", async () => {
    const { engine, ctx } = setup([fixture("backup-unreadable")]);
    const result = failure(await engine.snapshot({ dir: SRC, excludes: [], tags: TAGS }, ctx));
    expect(result.finding.code).toBe("restic.unreadable-files");
    expect(result.exitCode).toBe(6);
    expect(result.finding.paths).toEqual(["sub/b"]);
    expect(result.finding.fix).toBeDefined();
  });

  test("exit 3 carries the incomplete snapshot's id as data, for the saga to journal as discarded (D28)", async () => {
    const { engine, ctx } = setup([fixture("backup-unreadable")]);
    const result = await engine.snapshot({ dir: SRC, excludes: [], tags: TAGS }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.incomplete).toEqual({ snapshot: INCOMPLETE_ID });
  });

  test("exit 3 without a summary has no incomplete id: restic wrote no snapshot it named", async () => {
    const recorded = fixture("backup-unreadable");
    const { engine, ctx } = setup([edited(recorded, { stdout: "" })]);
    const result = await engine.snapshot({ dir: SRC, excludes: [], tags: TAGS }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.finding.code).toBe("restic.unreadable-files");
    expect(result.incomplete).toBeUndefined();
  });

  test("exit 0 without a summary line is restic.output-invalid", async () => {
    const { engine, ctx } = setup([edited(fixture("backup"), { stdout: "" })]);
    expect(failure(await engine.snapshot({ dir: SRC, excludes: [], tags: [] }, ctx)).finding.code).toBe(
      "restic.output-invalid",
    );
  });

  test.each([
    ["a relative folder", { dir: "src", excludes: [], tags: [] }],
    ["an exclude outside the folder", { dir: SRC, excludes: ["../x"], tags: [] }],
    ["an absolute exclude", { dir: SRC, excludes: ["/etc"], tags: [] }],
    ["an empty tag", { dir: SRC, excludes: [], tags: [""] }],
    ["a parent that is not a full snapshot id", { dir: SRC, excludes: [], tags: [], parent: "latest" }],
  ])("%s is refused before restic runs", async (_name, input) => {
    const { host, engine, ctx } = setup([]);
    const result = failure(await engine.snapshot(input, ctx));
    expect(result.finding.code).toBe("contract.invalid");
    expect(host.calls).toHaveLength(0);
  });
});

describe("restic engine: list", () => {
  test("parses every snapshot", async () => {
    const { engine } = setup([fixture("snapshots")]);
    const snapshots = value(await engine.list({}));
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toEqual({
      id: BACKUP_ID,
      time: expect.any(String),
      hostname: "fixture-host",
      paths: [SRC],
      tags: TAGS,
    });
    expect(snapshots[1]?.parent).toBe(BACKUP_ID);
  });

  test("a tag filter asks for snapshots carrying every tag, in capture mode", async () => {
    const { host, engine } = setup([fixture("snapshots-tagged")]);
    value(await engine.list({ tags: TAGS }));
    expect(host.calls[1]?.args?.slice(-4)).toEqual(["snapshots", "--json", "--tag", TAGS.join(",")]);
    expect(host.calls[1]?.capture).toBeDefined();
  });

  test("a tag filter is encoded, and the tags read back are decoded (D26)", async () => {
    const encoded = "plainport:path=clients/a%2Cb 100%25";
    const recorded = fixture("snapshots-tagged");
    const stdout = recorded.stdout.replaceAll(`plainport:project=${FIXTURE_PROJECT}`, encoded);
    const { host, engine } = setup([edited(recorded, { stdout })]);
    const snapshots = value(await engine.list({ tags: ["plainport", "plainport:path=clients/a,b 100%"] }));
    expect(host.calls[1]?.args?.slice(-2)).toEqual(["--tag", `plainport,${encoded}`]);
    expect(snapshots[0]?.tags).toEqual(["plainport", "plainport:path=clients/a,b 100%"]);
  });

  test("a tag another tool wrote keeps any percent sequence other than %2C and %25", async () => {
    const recorded = fixture("snapshots");
    const stdout = recorded.stdout.replaceAll(`plainport:project=${FIXTURE_PROJECT}`, "x%41%2c%2525");
    const { engine } = setup([edited(recorded, { stdout })]);
    expect(value(await engine.list({}))[0]?.tags).toEqual(["plainport", "x%41,%25"]);
  });

  test("no match is an empty list", async () => {
    const { engine } = setup([fixture("snapshots-none")]);
    expect(value(await engine.list({ tags: ["plainport:project=none"] }))).toEqual([]);
  });

  test("output that is not the known JSON is restic.output-invalid", async () => {
    const { engine } = setup([edited(fixture("snapshots"), { stdout: '[{"id":1}]\n' })]);
    expect(failure(await engine.list({})).finding.code).toBe("restic.output-invalid");
  });
});

describe("restic engine: entries", () => {
  const collect = () => {
    const seen: EntryMeta[] = [];
    return { seen, onEntry: (entry: EntryMeta) => seen.push(entry) };
  };

  test("streams entries relative to the snapshot root, with POSIX modes, and symlink targets from one ls -l", async () => {
    const { host, engine } = setup([fixture("ls"), fixture("ls-long")]);
    const { seen, onEntry } = collect();
    const listed = value(await engine.entries(BACKUP_ID, onEntry));
    expect(listed.snapshot.id).toBe(BACKUP_ID);
    expect(listed.snapshot.paths).toEqual([SRC]);
    expect(listed.count).toBe(5);
    expect(seen).toEqual([
      { path: "a.txt", type: "file", size: 6, mode: 0o644, mtime: expect.any(String) },
      { path: "sub", type: "dir", mode: 0o755, mtime: expect.any(String) },
      { path: "sub/b", type: "file", size: 1, mode: 0o644, mtime: expect.any(String) },
      // Symlinks come last, once their targets are known; " -> " in a name or target is no problem.
      { path: "link", type: "symlink", mode: 0o755, mtime: expect.any(String), linkTarget: "a.txt" },
      {
        path: "sub/odd -> name",
        type: "symlink",
        mode: 0o755,
        mtime: expect.any(String),
        linkTarget: "x -> y",
      },
    ]);
    expect(host.calls.map((call) => call.args?.slice(4).join(" "))).toEqual([
      "",
      `ls --json ${BACKUP_ID}`,
      `ls -l ${BACKUP_ID}`,
    ]);
    for (const call of host.calls.slice(1)) {
      expect(call.wholeStdout).toBe(true);
      expect(call.capture).toBeUndefined();
    }
  });

  test("a snapshot without symlinks needs no ls -l", async () => {
    const recorded = fixture("ls");
    const stdout = recorded.stdout
      .split("\n")
      .filter((line) => !line.includes('"type":"symlink"'))
      .join("\n");
    const { host, engine } = setup([edited(recorded, { stdout })]);
    expect(value(await engine.entries(BACKUP_ID, () => {})).count).toBe(3);
    expect(host.calls).toHaveLength(2);
  });

  test("a symlink ls -l cannot place is read with one cat tree of its folder", async () => {
    const long = fixture("ls-long");
    // Same number of records, but none names the symlink.
    const stdout = long.stdout.replace("/sub/odd -> name -> x -> y", "/sub/other -> x -> y");
    const { host, engine } = setup([fixture("ls"), edited(long, { stdout }), fixture("cat-tree-sub")]);
    const { seen, onEntry } = collect();
    value(await engine.entries(BACKUP_ID, onEntry));
    expect(seen.find((entry) => entry.path === "sub/odd -> name")?.linkTarget).toBe("x -> y");
    expect(host.calls.at(-1)?.args?.slice(-3)).toEqual(["cat", "tree", `${BACKUP_ID}:/sub`]);
    expect(host.calls).toHaveLength(4);
  });

  test("two ls -l lines that give one symlink different targets fall back to cat tree", async () => {
    const long = fixture("ls-long");
    // The same number of records, one of them forged to give the symlink a second target.
    const forged = long.stdout.replace(
      /-rw-r--r-- .* \/sub\/b\n/,
      "Lrwxr-xr-x   501    20      0 2026-10-03 04:05:49 /sub/odd -> name -> other\n",
    );
    expect(forged).not.toBe(long.stdout);
    const { host, engine } = setup([
      fixture("ls"),
      edited(long, { stdout: forged }),
      fixture("cat-tree-sub"),
    ]);
    const { seen, onEntry } = collect();
    value(await engine.entries(BACKUP_ID, onEntry));
    expect(seen.find((entry) => entry.path === "sub/odd -> name")?.linkTarget).toBe("x -> y");
    expect(host.calls).toHaveLength(4);
  });

  test("symlink lookups are bounded: thousands of symlink folders cost two restic runs, not thousands", async () => {
    const node = (path: string, type: string) =>
      JSON.stringify({
        name: path.split("/").at(-1),
        type,
        path,
        mode: type === "symlink" ? 134218221 : 420,
        mtime: "2026-10-03T04:05:49+02:00",
        message_type: "node",
        struct_type: "node",
        ...(type === "file" ? { size: 1 } : {}),
      });
    const header = fixture("ls").stdout.split("\n")[0];
    const json: string[] = [header ?? ""];
    const long: string[] = ["snapshot x of [/] at … filtered by []:"];
    for (let folder = 0; folder < 2000; folder++) {
      json.push(node(`/d${folder}`, "dir"));
      long.push(`drwxr-xr-x   501    20      0 2026-10-03 04:05:49 /d${folder}`);
      for (let file = 0; file < 50; file++) {
        json.push(node(`/d${folder}/f${file}`, "file"));
        long.push(`-rw-r--r--   501    20      1 2026-10-03 04:05:49 /d${folder}/f${file}`);
      }
      json.push(node(`/d${folder}/.bin`, "symlink"));
      long.push(`Lrwxr-xr-x   501    20      0 2026-10-03 04:05:49 /d${folder}/.bin -> ../t${folder}`);
    }
    const { host, engine } = setup([
      edited(fixture("ls"), { stdout: `${json.join("\n")}\n` }),
      edited(fixture("ls-long"), { stdout: `${long.join("\n")}\n` }),
    ]);
    let count = 0;
    let links = 0;
    const listed = value(
      await engine.entries(BACKUP_ID, (entry) => {
        count++;
        if (entry.linkTarget !== undefined) links++;
      }),
    );
    expect(listed.count).toBe(2000 * 52);
    expect(count).toBe(2000 * 52);
    expect(links).toBe(2000);
    expect(host.calls).toHaveLength(3);
  });

  test("a listing line that is not restic's JSON fails the whole listing", async () => {
    const recorded = fixture("ls");
    const { engine } = setup([edited(recorded, { stdout: `${recorded.stdout}{"message_type":"node"}\n` })]);
    expect(failure(await engine.entries(BACKUP_ID, () => {})).finding.code).toBe("restic.output-invalid");
  });

  test("an unknown snapshot is restic.snapshot-not-found", async () => {
    const { engine } = setup([fixture("ls-missing"), fixture("snapshots-missing")]);
    const result = failure(await engine.entries(MISSING_ID, () => {}));
    expect(result.finding.code).toBe("restic.snapshot-not-found");
    expect(result.exitCode).toBe(4);
  });

  test("an id that is not a full snapshot id is refused", async () => {
    const { host, engine } = setup([]);
    expect(failure(await engine.entries("latest", () => {})).finding.code).toBe("contract.invalid");
    expect(failure(await engine.entries("--help", () => {})).finding.code).toBe("contract.invalid");
    expect(host.calls).toHaveLength(0);
  });
});

describe("restic engine: restore", () => {
  test("restores the snapshot root into the target with the chosen overwrite mode", async () => {
    const { host, engine, ctx } = setup([fixture("restore")]);
    const stats = value(
      await engine.restore(BACKUP_ID, `${FIXTURE_ROOT}/restored`, ctx, {
        overwrite: "if-changed",
        delete: true,
        excludes: ["node_modules"],
      }),
    );
    expect(stats).toEqual({
      totalFiles: restoreSummary.total_files,
      filesRestored: restoreSummary.files_restored,
      filesSkipped: restoreSummary.files_skipped ?? 0,
      filesDeleted: restoreSummary.files_deleted ?? 0,
      totalBytes: restoreSummary.total_bytes,
      bytesRestored: restoreSummary.bytes_restored,
      bytesSkipped: restoreSummary.bytes_skipped ?? 0,
    });
    expect(host.calls[1]?.args?.slice(4)).toEqual([
      "restore",
      BACKUP_ID,
      `--target=${FIXTURE_ROOT}/restored`,
      "--json",
      "--overwrite=if-changed",
      "--delete",
      "--exclude=/node_modules",
    ]);
  });

  test("status lines become progress events of the restore phase", async () => {
    const status =
      '{"message_type":"status","seconds_elapsed":1,"seconds_remaining":4,"percent_done":0.5,"total_bytes":16,"bytes_restored":8}\n';
    const recorded = fixture("restore");
    const { engine, events, ctx } = setup([edited(recorded, { stdout: status + recorded.stdout })]);
    value(await engine.restore(BACKUP_ID, `${FIXTURE_ROOT}/restored`, ctx));
    expect(events.filter((event) => event.type === "progress")).toEqual([
      { type: "progress", op: "op-1", phase: "restore", bytesDone: 8, bytesTotal: 16, etaSeconds: 4 },
    ]);
  });

  test("an unknown snapshot is restic.snapshot-not-found", async () => {
    const missing = edited(fixture("ls-missing"), { args: [] });
    const { engine, ctx } = setup([missing, fixture("snapshots-missing")]);
    expect(failure(await engine.restore(MISSING_ID, "/tmp/t", ctx)).finding.code).toBe(
      "restic.snapshot-not-found",
    );
  });

  test("a relative target is refused", async () => {
    const { engine, ctx } = setup([]);
    expect(failure(await engine.restore(BACKUP_ID, "restored", ctx)).finding.code).toBe("contract.invalid");
  });
});

describe("restic engine: check", () => {
  test("a healthy repository is an ok report", async () => {
    const { host, engine } = setup([fixture("check")]);
    expect(value(await engine.check())).toEqual({ ok: true, errors: 0, messages: [] });
    expect(host.calls[1]?.args?.slice(-2)).toEqual(["check", "--json"]);
  });

  test("a damaged repository is an ok Result whose report lists the errors", async () => {
    const { host, engine } = setup([fixture("check-damaged")]);
    const report = value(await engine.check({ readDataSubset: "100%" }));
    expect(report.ok).toBe(false);
    expect(report.errors).toBe(Number(stdoutLines(fixture("check-damaged"))[0]?.num_errors));
    expect(report.messages.length).toBeGreaterThan(0);
    expect(report.messages[0]).toContain("unexpected file size");
    expect(host.calls[1]?.args?.slice(-3)).toEqual(["check", "--json", "--read-data-subset=100%"]);
  });

  test("a locked repository is restic.locked, not a damaged one, though restic printed a summary", async () => {
    const { engine } = setup([fixture("locked")]);
    const result = failure(await engine.check());
    expect(result.finding.code).toBe("restic.locked");
    expect(result.exitCode).toBe(11);
    expect(result.finding.fix).toContain(`restic --repo ${REPO} unlock`);
  });
});

describe("restic engine: exit codes map to catalogued findings", () => {
  test.each([
    ["wrong-password", "restic.wrong-password", 5],
    ["repo-missing", "restic.repo-missing", 4],
    ["locked", "restic.locked", 11],
    ["interrupted", "restic.interrupted", 130],
    ["ls-missing", "restic.failed", 1],
  ] as const)("%s → %s (exit %d)", async (name, code, exitCode) => {
    const { engine } = setup([fixture(name)]);
    const result = failure(await engine.list({}));
    expect(result.finding.code).toBe(code);
    expect(result.exitCode).toBe(exitCode);
    expect(result.finding.fix).toBeDefined();
    expect(result.finding.message.length).toBeGreaterThan(0);
  });

  test("restic 0.18.1's recorded interrupted backup (exit 1, not 0.19's 130) parses and is restic.failed", async () => {
    const host = replayHost([fixture("version", "0.18.1"), fixture("interrupted", "0.18.1")]);
    const engine = resticEngine({
      host,
      restic: "/r",
      repository: REPO,
      password: "p",
      env: {},
      expectedVersion: "0.18.1",
    });
    const result = failure(await engine.list({}));
    expect(result.finding.code).toBe("restic.failed");
    expect(result.finding.message).toContain("context canceled");
    expect(host.remaining()).toBe(0);
  });

  test("restic's own message is carried, from its exit_error line", async () => {
    const { engine } = setup([fixture("wrong-password")]);
    expect(failure(await engine.list({})).finding.message).toContain("wrong password or no key found");
  });

  test("an exit code plainport does not map is restic.failed and names the code", async () => {
    const { engine } = setup([edited(fixture("snapshots"), { exitCode: 2, stdout: "", stderr: "usage\n" })]);
    const result = failure(await engine.list({}));
    expect(result.finding.code).toBe("restic.failed");
    expect(result.finding.message).toContain("2");
  });

  test("a child ended by a signal is restic.failed naming the signal", async () => {
    const replay = replayHost([fixture("version"), fixture("snapshots")]);
    const engine = resticEngine({
      host: {
        run: async (spec) => {
          const result = await replay.run(spec);
          if (!result.ok || spec.args?.includes("version")) return result;
          return { ok: true, value: { ...result.value, exitCode: null, signal: "SIGSEGV" } };
        },
      },
      restic: "/r",
      repository: REPO,
      password: "p",
      env: {},
    });
    const result = failure(await engine.list({}));
    expect(result.finding.code).toBe("restic.failed");
    expect(result.finding.message).toContain("SIGSEGV");
  });

  test("a runner failure (cancelled, deadline, capture) is passed through", async () => {
    const cancelled = fail(finding("process.cancelled", { message: "restic was cancelled" }));
    const { engine } = setup([cancelled]);
    const result = failure(await engine.list({}));
    expect(result.finding.code).toBe("process.cancelled");
    expect(result.exitCode).toBe(130);
  });
});

describe("restic engine: the password never leaves in a message", () => {
  const leaky = (text: string) =>
    text.replaceAll("wrong password or no key found", `bad key ${FIXTURE_PASSWORD}`);

  test("not in a finding built from restic's output", async () => {
    const recorded = fixture("wrong-password");
    const { engine } = setup([edited(recorded, { stderr: leaky(recorded.stderr) })]);
    const result = failure(await engine.list({}));
    expect(result.finding.message).toContain("bad key");
    expect(result.finding.message).not.toContain(FIXTURE_PASSWORD);
    expect(result.finding.message).toContain("[redacted]");
  });

  test("not in a log event", async () => {
    const recorded = fixture("wrong-password");
    const { engine, events, ctx } = setup([edited(recorded, { stderr: leaky(recorded.stderr) })]);
    failure(await engine.list({}, ctx));
    const logs = events.filter((event) => event.type === "log");
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) expect(JSON.stringify(log)).not.toContain(FIXTURE_PASSWORD);
  });

  test("not in a log line the runner cut short in the middle of the password", async () => {
    const replay = replayHost([fixture("version"), fixture("snapshots")]);
    const engine = resticEngine({
      host: {
        run: async (spec) => {
          spec.log?.emit({
            type: "log",
            op: spec.log.op,
            level: "info",
            message: `restic: ${"x".repeat(10)}${FIXTURE_PASSWORD.slice(0, 7)}…`,
          });
          return replay.run(spec);
        },
      },
      restic: "/r",
      repository: REPO,
      password: FIXTURE_PASSWORD,
      env: {},
    });
    const events: PlainportEvent[] = [];
    value(await engine.list({}, { op: "op-1", emit: (event) => events.push(event) }));
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(JSON.stringify(event)).not.toContain(FIXTURE_PASSWORD.slice(0, 7));
  });

  test("not in a runner failure", async () => {
    const timedOut = fail(
      finding("process.idle-timeout", { message: `restic printed nothing; last: ${FIXTURE_PASSWORD}` }),
    );
    const { engine } = setup([timedOut]);
    const result = failure(await engine.list({}));
    expect(result.finding.code).toBe("process.idle-timeout");
    expect(result.finding.message).not.toContain(FIXTURE_PASSWORD);
  });

  test("not in a check report", async () => {
    const recorded = fixture("check-damaged");
    const stderr = recorded.stderr.replace("unexpected file size", `unexpected ${FIXTURE_PASSWORD}`);
    const { engine } = setup([edited(recorded, { stderr })]);
    const report = value(await engine.check());
    expect(JSON.stringify(report)).not.toContain(FIXTURE_PASSWORD);
  });
});

describe("restic tags: the codec keeps every tag restic would change (D26, fix r1 I4)", () => {
  test("restic trims leading and trailing whitespace, so it is percent-encoded at the ends only", () => {
    expect(encodeTag(" clients/web ")).toBe("%20clients/web%20");
    expect(encodeTag("a b")).toBe("a b");
    expect(encodeTag("\u00a0x\u0085")).toBe("%C2%A0x%C2%85");
    expect(encodeTag("   ")).toBe("%20%20%20");
  });

  test("control characters are encoded anywhere", () => {
    expect(encodeTag("a\tb\nc\u007f")).toBe("a%09b%0Ac%7F");
  });

  test("D26's mappings are unchanged", () => {
    expect(encodeTag("a,b 100%")).toBe("a%2Cb 100%25");
  });

  test.each([
    " lead",
    "trail\t",
    "\u3000wide\u2028",
    "plainport:path=clients/acme,web 100%",
    "%20 literal",
    "é ü",
    "line\nbreak",
    "",
  ])("%j round-trips", (tag) => {
    expect(decodeTag(encodeTag(tag))).toBe(tag);
    expect(encodeTag(tag).trim()).toBe(encodeTag(tag));
  });

  test("a percent sequence that is not one the codec writes stays as it is", () => {
    expect(decodeTag("x%41%2c%2525")).toBe("x%41,%25");
    expect(decodeTag("bad%E2%28")).toBe("bad%E2%28");
  });
});

describe("restic ls -l records", () => {
  const read = (wanted: string[], lines: string[], maxRecordChars?: number) => {
    const reader = new LongListingReader(new Set(wanted), maxRecordChars);
    for (const line of ["snapshot 0 of [/] filtered by []:", ...lines]) reader.line(line);
    return reader.end();
  };
  const entry = (mode: string, path: string) => `${mode}   501    20      0 2026-10-03 04:08:59 ${path}`;

  test("a plain file's line (type written as -) ends the symlink record before it", () => {
    const listing = read(
      ["/l", "/n\nl"],
      [
        entry("Lrwxr-xr-x", "/l -> ../README.md"),
        entry("-rw-r--r--", "/weird"),
        entry("Lrwxr-xr-x", "/n"),
        "l -> t",
        "x ",
        // Go writes setuid as a type letter (u), never as an s in the permission bits.
        entry("urwxr-xr-x", "/setuid"),
      ],
    );
    expect(listing.targets).toEqual(
      new Map([
        ["/l", "../README.md"],
        ["/n\nl", "t\nx "],
      ]),
    );
    expect(listing.records).toBe(4);
    expect(listing.reliable).toBe(true);
  });

  test("a target holding a line break and an entry-like line adds a record: the count exposes it (N1)", () => {
    // The symlink /s points at "x\n-rw-r--r-- … /zz": its record ends early and a forged plain-file record follows.
    const listing = read(["/s"], [entry("Lrwxr-xr-x", "/s -> x"), entry("-rw-r--r--", "/zz")]);
    expect(listing.targets.get("/s")).toBe("x");
    expect(listing.records).toBe(2); // ls --json listed one entry, so the caller distrusts this listing
  });

  test("a line that does not look like an entry (a year that is not four digits) joins the previous record and is counted out (N1)", () => {
    const listing = read(
      ["/s"],
      [entry("Lrwxr-xr-x", "/s -> t"), "-rw-r--r--   501    20      0 10000-01-01 00:00:00 /far"],
    );
    expect(listing.records).toBe(1); // two entries in ls --json: the caller distrusts this listing
  });

  test("a carriage return ending a target is kept (N1, N2)", () => {
    expect(read(["/c"], [entry("Lrwxr-xr-x", "/c -> tar\r")]).targets.get("/c")).toBe("tar\r");
  });

  test("a record that grows past its bound makes the listing unreliable instead of growing on (N4)", () => {
    const listing = read(["/s"], [entry("Lrwxr-xr-x", "/s -> t"), ...Array(50).fill("x".repeat(100))], 1_000);
    expect(listing.reliable).toBe(false);
  });
});

describe("restic engine: entries cross-checks ls -l against ls --json (fix r2 N1, N6)", () => {
  test("a record count that differs from the listing's sends every symlink to cat tree", async () => {
    const long = fixture("ls-long");
    // One extra entry-like line (as a target with a line break could forge) and a wrong target for /link.
    const forged = long.stdout.replace(
      "/link -> a.txt\n",
      "/link -> wrong\n-rw-r--r--   501    20      0 2026-10-03 04:05:49 /forged\n",
    );
    const { host, engine } = setup([
      fixture("ls"),
      edited(long, { stdout: forged }),
      fixture("cat-tree"),
      fixture("cat-tree-sub"),
    ]);
    const seen: EntryMeta[] = [];
    value(await engine.entries(BACKUP_ID, (entry) => seen.push(entry)));
    expect(seen.find((entry) => entry.path === "link")?.linkTarget).toBe("a.txt");
    expect(seen.find((entry) => entry.path === "sub/odd -> name")?.linkTarget).toBe("x -> y");
    expect(host.calls.slice(3).map((call) => call.args?.at(-1))).toEqual([
      `${BACKUP_ID}:/`,
      `${BACKUP_ID}:/sub`,
    ]);
  });

  test("too many unclear symlink folders is restic.symlinks-unclear, naming symlinks and a fix", async () => {
    const recorded = fixture("ls");
    const header = recorded.stdout.split("\n")[0];
    const lines = [header ?? ""];
    for (let folder = 0; folder < 40; folder++)
      lines.push(
        JSON.stringify({
          name: "l",
          type: "symlink",
          path: `/d${folder}/l`,
          mode: 134218221,
          mtime: "2026-10-03T04:05:49+02:00",
          message_type: "node",
          struct_type: "node",
        }),
      );
    const { host, engine } = setup([
      edited(recorded, { stdout: `${lines.join("\n")}\n` }),
      edited(fixture("ls-long"), { stdout: "snapshot x:\n" }),
    ]);
    const result = failure(await engine.entries(BACKUP_ID, () => {}));
    expect(result.finding.code).toBe("restic.symlinks-unclear");
    expect(result.exitCode).toBe(6);
    expect(result.finding.paths?.slice(0, 2)).toEqual(["d0/l", "d1/l"]);
    expect(result.finding.paths?.length).toBeLessThanOrEqual(10);
    expect(result.finding.fix).toContain("rename");
    expect(host.calls).toHaveLength(3);
  });
});
