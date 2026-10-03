import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { testHost } from "../testing/host.ts";
import { scanTree, type TreeScan } from "./walk.ts";

const { fs } = testHost();
let dir: string;
let servers: Server[];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-walk-")));
  servers = [];
});
afterEach(async () => {
  for (const server of servers) await new Promise((done) => server.close(done));
  // Restore permissions so cleanup can remove what a test locked.
  Bun.spawnSync(["/bin/chmod", "-R", "u+rwx", dir]);
  rmSync(dir, { recursive: true, force: true });
});

const write = (relative: string, text = ""): string => {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};

const scan = async (): Promise<TreeScan> => {
  const result = await scanTree(fs, dir);
  if (!result.ok) throw new Error(result.finding.message);
  return result.value;
};

describe("scan: one walk records the manifest", () => {
  test("path, type, size, mode, mtime and link target, below the folder, '/'-separated", async () => {
    const file = write("src/index.ts", "export {};\n");
    chmodSync(file, 0o640);
    mkdirSync(join(dir, "empty"));
    // Set explicitly: the process umask (022 on a Mac, 002 in some Linux containers) would decide it otherwise.
    chmodSync(join(dir, "src"), 0o755);
    symlinkSync("src/index.ts", join(dir, "entry"));
    const tree = await scan();
    expect([...tree.manifest].map((e) => e.path).sort()).toEqual(["empty", "entry", "src", "src/index.ts"]);
    const entry = tree.manifest.get("src/index.ts");
    expect(entry).toMatchObject({ type: "file", size: 11, mode: 0o640 });
    const ns = lstatSync(file, { bigint: true }).mtimeNs;
    expect(entry?.mtime).toEndWith(`.${(ns % 1_000_000_000n).toString().padStart(9, "0")}Z`);
    expect(tree.manifest.get("entry")).toMatchObject({ type: "symlink", linkTarget: "src/index.ts" });
    expect(tree.manifest.get("entry")?.size).toBeUndefined();
    expect(tree.manifest.get("src")).toMatchObject({ type: "dir", mode: 0o755 });
    expect(tree).toMatchObject({ files: 1, dirs: 2, symlinks: 1, bytes: 11 });
  });

  test("sockets and FIFOs are skipped and listed", async () => {
    write("keep.txt", "x");
    mkdirSync(join(dir, "run"));
    Bun.spawnSync(["/usr/bin/mkfifo", join(dir, "run", "pipe")]);
    const server = createServer();
    servers.push(server);
    await new Promise<void>((done) => server.listen(join(dir, "run", "dev.sock"), done));
    const tree = await scan();
    expect(tree.skipped).toEqual([
      { path: "run/dev.sock", kind: "socket" },
      { path: "run/pipe", kind: "fifo" },
    ]);
    expect(tree.manifest.get("run/pipe")).toBeUndefined();
    expect(tree.manifest.get("run/dev.sock")).toBeUndefined();
    expect(tree.manifest.get("keep.txt")).toBeDefined();
  });

  test("the ten largest files are listed, largest first", async () => {
    for (let i = 1; i <= 12; i++) write(`f${i}.bin`, "x".repeat(i * 10));
    const tree = await scan();
    expect(tree.largest.map((p) => p.path)).toEqual(
      [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((i) => `f${i}.bin`),
    );
    expect(tree.largest[0]).toEqual({ path: "f12.bin", bytes: 120 });
  });

  test("unreadable files and folders are listed, and the walk does not enter a folder it cannot read", async () => {
    chmodSync(write("secret.key", "k"), 0o000);
    write("locked/inside.txt", "i");
    chmodSync(join(dir, "locked"), 0o000);
    write("fine.txt", "f");
    const tree = await scan();
    expect(tree.unreadable).toEqual(["locked", "secret.key"]);
    expect(tree.manifest.get("locked/inside.txt")).toBeUndefined();
    expect(tree.manifest.get("fine.txt")).toBeDefined();
  });

  test("symlinks pointing outside the folder are listed, absolute or relative; links inside are not", async () => {
    write("a/b.txt", "b");
    symlinkSync("/etc/hosts", join(dir, "abs-out"));
    symlinkSync("../../elsewhere", join(dir, "a", "rel-out"));
    symlinkSync("../a/b.txt", join(dir, "a", "rel-in"));
    symlinkSync(join(dir, "a", "b.txt"), join(dir, "abs-in"));
    const tree = await scan();
    expect(tree.linksOutside).toEqual([
      { path: "a/rel-out", target: "../../elsewhere" },
      { path: "abs-out", target: "/etc/hosts" },
    ]);
  });

  test("a missing folder is project.not-found", async () => {
    const result = await scanTree(fs, join(dir, "nope"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.finding.code).toBe("project.not-found");
  });
});

describe("scan: manifest order", () => {
  test("iteration yields every folder before anything inside it (the planner's strip.extra relies on it)", async () => {
    for (const path of ["b/z/y/x.txt", "a/c.txt", "a/b/c/d.txt", "a/b/e.txt", "z.txt", "m/n/o/p/q.txt"])
      write(path);
    const seen = new Set<string>();
    for (const entry of (await scan()).manifest) {
      const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
      expect({ entry: entry.path, parentSeen: parent === "" || seen.has(parent) }).toEqual({
        entry: entry.path,
        parentSeen: true,
      });
      seen.add(entry.path);
    }
    expect(seen.size).toBe(16);
  });
});

describe("scan: the fingerprint", () => {
  test("is stable across runs", async () => {
    write("a.txt", "one");
    write("b/c.txt", "two");
    symlinkSync("a.txt", join(dir, "l"));
    const first = (await scan()).fingerprint;
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await scan()).fingerprint).toBe(first);
    expect((await scan()).fingerprint).toBe(first);
  });

  test("changes with any edit: content, a new file, a chmod, a link target, even an edit that restores the mtime", async () => {
    const a = write("a.txt", "one");
    write("b/c.txt", "two");
    symlinkSync("a.txt", join(dir, "l"));
    const seen = new Set<string>([(await scan()).fingerprint]);
    const changed = async (what: string) => {
      const next = (await scan()).fingerprint;
      expect({ what, fresh: !seen.has(next) }).toEqual({ what, fresh: true });
      seen.add(next);
    };

    writeFileSync(a, "two");
    await changed("same-size content edit");

    const { atime, mtime } = lstatSync(a);
    writeFileSync(a, "six");
    utimesSync(a, atime, mtime);
    await changed("edit with the mtime put back");

    write("b/new.txt");
    await changed("new file");

    chmodSync(a, 0o600);
    await changed("chmod");

    rmSync(join(dir, "l"));
    symlinkSync("b/c.txt", join(dir, "l"));
    await changed("link retargeted");
  });
});

describe("scan: expected failures carry a fix", () => {
  test("project.not-found says how to find the project again", async () => {
    const result = await scanTree(fs, join(dir, "nope"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.finding.code).toBe("project.not-found");
      expect(result.finding.fix).toBeDefined();
    }
  });
});

describe("scan: exceptions mean bugs", () => {
  test("a lstat that throws something other than a system error is not an unreadable file: it propagates", async () => {
    const broken = {
      ...fs,
      lstat: async (path: string) => {
        if (path.endsWith("/boom.txt")) throw new TypeError("a fake went wrong");
        return fs.lstat(path);
      },
    };
    write("boom.txt", "x");
    await expect(scanTree(broken, dir)).rejects.toThrow(TypeError);
  });
});
