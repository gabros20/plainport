// T1: the engine against the real pinned restic on a tiny temp repository (ADR-0018). `bun run test:t1` runs it.

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "@plainport/contract";
import { type Engine, toolPath } from "@plainport/core";
import { testHost } from "@plainport/host-macos/testing";
import { describeT1 } from "../../../test/tiers.ts";
import { resticEngine } from "./engine.ts";

const TIMEOUT = 60_000;

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

/** type, permission bits, size, content or link target of every entry below dir, keyed by relative path. */
const tree = (dir: string, prefix = ""): Map<string, string> => {
  const out = new Map<string, string>();
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(path);
    const mode = (stat.mode & 0o7777).toString(8);
    if (stat.isSymbolicLink()) out.set(relative, `link ${mode} -> ${readlinkSync(path)}`);
    else if (stat.isDirectory()) {
      out.set(relative, `dir ${mode}`);
      for (const [key, entry] of tree(path, relative)) out.set(key, entry);
    } else out.set(relative, `file ${mode} ${stat.size} ${readFileSync(path).toString("base64")}`);
  }
  return out;
};

describeT1("restic engine: the real restic on a temp repository", () => {
  const host = testHost();
  let root: string;
  let src: string;
  let engine: Engine;
  const ctx = { op: "t1" };

  const make = (password: string, repository = join(root, "repo")): Engine =>
    resticEngine({
      host,
      restic: resticPath,
      repository,
      password,
      env: { PATH: "/usr/bin:/bin", HOME: join(root, "home"), TMPDIR: join(root, "tmp") },
      cacheDir: join(root, "cache"),
      retryLock: null,
    });
  let resticPath: string;

  beforeAll(async () => {
    // tmpdir() is under /var, a symlink to /private/var: the excludes must still match.
    root = mkdtempSync(join(tmpdir(), "plainport-engine-t1-"));
    mkdirSync(join(root, "home"));
    mkdirSync(join(root, "tmp"));
    src = join(root, "src");
    mkdirSync(join(src, "sub", "deeper"), { recursive: true });
    mkdirSync(join(src, "empty"));
    mkdirSync(join(src, "node_modules", "dep"), { recursive: true });
    mkdirSync(join(src, "w[e]ird*"));
    writeFileSync(join(src, "README.md"), "# demo\n");
    writeFileSync(join(src, ".env"), "TOKEN=op://vault/item\n");
    writeFileSync(join(src, "sub", "deeper", "data.bin"), new Uint8Array([0, 1, 2, 255, 10, 13]));
    writeFileSync(join(src, "run.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(join(src, "run.sh"), 0o755);
    writeFileSync(join(src, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(src, "w[e]ird*", "x"), "stripped too\n");
    writeFileSync(join(src, "weird"), "kept: only the exact path is excluded\n");
    symlinkSync("README.md", join(src, "readme-link"));
    symlinkSync("../README.md", join(src, "sub", "up-link"));
    const found = await toolPath(host, "restic", { env: {} });
    if (!found.ok) throw new Error(found.finding.message);
    resticPath = found.value.path;
    engine = make("t1-password");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test(
    "init, then init again is restic.repo-exists",
    async () => {
      expect(value(await engine.init()).id).toMatch(/^[0-9a-f]{64}$/);
      const again = await engine.init();
      expect(again.ok ? undefined : again.finding.code).toBe("restic.repo-exists");
    },
    TIMEOUT,
  );

  let snapshotId: string;
  const excludes = ["node_modules", "w[e]ird*"];

  test(
    "snapshot, list, entries, restore: a byte-identical tree minus the excluded paths",
    async () => {
      const events: unknown[] = [];
      const taken = value(
        await engine.snapshot(
          { dir: src, excludes, tags: ["plainport", "plainport:path=src"] },
          { op: "t1", emit: (event) => events.push(event) },
        ),
      );
      snapshotId = taken.id;
      expect(taken.stats.totalFilesProcessed).toBe(5);

      const listed = value(await engine.list({ tags: ["plainport", "plainport:path=src"] }));
      expect(listed.map((snapshot) => snapshot.id)).toEqual([snapshotId]);
      expect(listed[0]?.paths).toEqual([src]);
      expect(value(await engine.list({ tags: ["plainport:path=other"] }))).toEqual([]);

      const expected = tree(src);
      for (const key of [...expected.keys()])
        if (excludes.some((path) => key === path || key.startsWith(`${path}/`))) expected.delete(key);

      const entries = value(await engine.entries(snapshotId));
      expect(entries.map((entry) => entry.path).sort()).toEqual([...expected.keys()].sort());
      const link = entries.find((entry) => entry.path === "sub/up-link");
      expect(link?.linkTarget).toBe("../README.md");
      expect(entries.find((entry) => entry.path === "run.sh")?.mode).toBe(0o755);
      expect(entries.find((entry) => entry.path === "sub/deeper/data.bin")?.size).toBe(6);

      const target = join(root, "restored");
      const stats = value(await engine.restore(snapshotId, target, ctx));
      expect(stats.filesRestored).toBeGreaterThan(0);
      expect(tree(target)).toEqual(expected);
    },
    TIMEOUT,
  );

  test(
    "a restore over a partial target with overwrite if-changed rewrites only what differs",
    async () => {
      const target = join(root, "restored");
      writeFileSync(join(target, "README.md"), "# changed\n");
      writeFileSync(join(target, "extra.txt"), "not in the snapshot\n");
      const stats = value(
        await engine.restore(snapshotId, target, ctx, { overwrite: "if-changed", delete: true }),
      );
      // restic counts every file it looked at as restored; the bytes show only README.md was written again.
      expect(stats.bytesRestored).toBe("# demo\n".length);
      expect(stats.filesSkipped).toBe(4);
      expect(stats.filesDeleted).toBe(1);
      expect(readFileSync(join(target, "README.md"), "utf8")).toBe("# demo\n");
    },
    TIMEOUT,
  );

  test(
    "an unreadable file fails the snapshot with restic.unreadable-files (restic exit 3)",
    async () => {
      const secret = join(src, "sub", "locked.txt");
      writeFileSync(secret, "no read\n");
      chmodSync(secret, 0o000);
      try {
        const result = await engine.snapshot(
          { dir: src, excludes, parent: snapshotId, tags: ["plainport"] },
          ctx,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.finding.code).toBe("restic.unreadable-files");
          expect(result.exitCode).toBe(6);
          expect(result.finding.paths).toEqual(["sub/locked.txt"]);
        }
      } finally {
        chmodSync(secret, 0o644);
        rmSync(secret);
      }
    },
    TIMEOUT,
  );

  test(
    "a tag holding , and % round-trips through restic (D26)",
    async () => {
      const tag = "plainport:path=clients/acme,web 100%";
      const taken = value(
        await engine.snapshot({ dir: src, excludes, parent: snapshotId, tags: ["plainport", tag] }, ctx),
      );
      const listed = value(await engine.list({ tags: [tag] }));
      expect(listed.map((snapshot) => snapshot.id)).toEqual([taken.id]);
      expect(listed[0]?.tags).toEqual(["plainport", tag]);
      expect(value(await engine.list({ tags: ["plainport:path=clients/acme"] }))).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "check passes on the healthy repository",
    async () => {
      expect(value(await engine.check())).toEqual({ ok: true, errors: 0, messages: [] });
    },
    TIMEOUT,
  );

  test(
    "a wrong password is restic.wrong-password; a missing repository is restic.repo-missing",
    async () => {
      const wrong = await make("not-the-password").list({});
      expect(wrong.ok ? undefined : [wrong.finding.code, wrong.exitCode]).toEqual([
        "restic.wrong-password",
        5,
      ]);
      const missing = await make("t1-password", join(root, "missing")).list({});
      expect(missing.ok ? undefined : [missing.finding.code, missing.exitCode]).toEqual([
        "restic.repo-missing",
        4,
      ]);
    },
    TIMEOUT,
  );

  test(
    "an unknown snapshot is restic.snapshot-not-found",
    async () => {
      const result = await engine.entries("0".repeat(64));
      expect(result.ok ? undefined : result.finding.code).toBe("restic.snapshot-not-found");
    },
    TIMEOUT,
  );
});
