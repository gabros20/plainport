import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeInHolder, removeEmptyHolder } from "./holder.ts";
import { type LocalIo, systemErrorCode } from "./io.ts";
import { nodeLocalIo } from "./node-io.ts";

describe("io: systemErrorCode", () => {
  test("gives the errno code of a system error", () => {
    expect(systemErrorCode(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }))).toBe(
      "ENOENT",
    );
    expect(systemErrorCode(Object.assign(new Error("EACCES"), { code: "EACCES", errno: -13 }))).toBe(
      "EACCES",
    );
  });

  test("rethrows anything that is not one: a bug stays an exception", () => {
    expect(() => systemErrorCode(new TypeError("undefined is not a function"))).toThrow(TypeError);
    const refused = Object.assign(new Error("refused"), { code: "ERR_PLAINPORT_PATH_REFUSED" });
    expect(() => systemErrorCode(refused)).toThrow(refused);
    expect(() => systemErrorCode("a string")).toThrow();
    expect(() => systemErrorCode(undefined)).toThrow();
  });
});

describe("io: nodeLocalIo's removeTree and freeBytes", () => {
  test("removeTree empties read-only folders, removes links without following them, and accepts nothing there", async () => {
    const root = mkdtempSync(join(tmpdir(), "plainport-io-"));
    try {
      const kept = join(root, "kept");
      mkdirSync(kept);
      writeFileSync(join(kept, "file"), "stays\n");
      const tree = join(root, "tree");
      mkdirSync(join(tree, "locked/deeper"), { recursive: true });
      writeFileSync(join(tree, "locked/deeper/file"), "x");
      symlinkSync(kept, join(tree, "link"));
      chmodSync(join(tree, "locked/deeper"), 0o500);
      chmodSync(join(tree, "locked"), 0o500);
      await nodeLocalIo.fs.removeTree(tree);
      expect(existsSync(tree)).toBe(false);
      expect(existsSync(join(kept, "file"))).toBe(true);
      await nodeLocalIo.fs.removeTree(join(root, "nothing-here"));
      expect(await nodeLocalIo.fs.freeBytes(root)).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("io: nodeLocalIo's rmdir", () => {
  test("removes an empty folder only: one that holds anything stays (ENOTEMPTY), and a missing one is ENOENT", async () => {
    const root = mkdtempSync(join(tmpdir(), "plainport-io-"));
    try {
      mkdirSync(join(root, "empty"));
      await nodeLocalIo.fs.rmdir(join(root, "empty"));
      expect(existsSync(join(root, "empty"))).toBe(false);
      mkdirSync(join(root, "full/inner"), { recursive: true });
      await expect(nodeLocalIo.fs.rmdir(join(root, "full"))).rejects.toMatchObject({ code: "ENOTEMPTY" });
      expect(existsSync(join(root, "full/inner"))).toBe(true);
      await expect(nodeLocalIo.fs.rmdir(join(root, "nothing"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("io: nodeLocalIo's mkdir", () => {
  test("makes one folder, and refuses when anything is there (EEXIST)", async () => {
    const root = mkdtempSync(join(tmpdir(), "plainport-io-"));
    try {
      await nodeLocalIo.fs.mkdir(join(root, "one"));
      expect(existsSync(join(root, "one"))).toBe(true);
      await expect(nodeLocalIo.fs.mkdir(join(root, "one"))).rejects.toMatchObject({ code: "EEXIST" });
      await expect(nodeLocalIo.fs.mkdir(join(root, "no/parent"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("io: makeInHolder, against an empty holder removed by another operation (C2, D72)", () => {
  /**
   * nodeLocalIo, but mkdirp makes the parent, then the folder itself without -p (mkdir -p's last step), and between
   * them, for a folder inside the holder, runs another operation's rmdir of the empty holder; writing a file in the
   * holder does the same first. `times` is how often that rmdir lands; `fired` counts it.
   */
  const seamed = (holder: string, times = 1) => {
    let fired = 0;
    const seam = () => {
      if (fired >= times) return;
      fired++;
      rmdirSync(holder);
    };
    const io = {
      ...nodeLocalIo,
      fs: {
        ...nodeLocalIo.fs,
        mkdirp: async (path: string) => {
          await nodeLocalIo.fs.mkdirp(dirname(path));
          if (dirname(path) === holder) seam();
          if (!existsSync(path)) mkdirSync(path);
        },
        writeBytesDurable: async (path: string, data: Uint8Array, options?: { exclusive?: boolean }) => {
          if (dirname(path) === holder) seam();
          await nodeLocalIo.fs.writeBytesDurable(path, data, options);
        },
      },
    } as LocalIo;
    return { io, fired: () => fired };
  };

  const inRoot = async (run: (root: string) => Promise<void>) => {
    const root = mkdtempSync(join(tmpdir(), "plainport-holder-"));
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test("the seam reproduces the race: a plain mkdir -p of the child fails with ENOENT", () =>
    inRoot(async (root) => {
      const holder = join(root, ".plainport-staging");
      const { io, fired } = seamed(holder);
      await expect(io.fs.mkdirp(join(holder, "op"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(fired()).toBe(1);
    }));

  test("the child is made all the same: the holder is made again and the step retried", () =>
    inRoot(async (root) => {
      const holder = join(root, ".plainport-staging");
      const { io, fired } = seamed(holder);
      const made = await makeInHolder(io, holder, join(holder, "op"), () => io.fs.mkdirp(join(holder, "op")));
      expect(made.ok).toBe(true);
      expect(fired()).toBe(1);
      expect(existsSync(join(holder, "op"))).toBe(true);
    }));

  test("a file written in the holder (the case probe) is written all the same", () =>
    inRoot(async (root) => {
      const holder = join(root, ".plainport-staging");
      mkdirSync(holder);
      const { io, fired } = seamed(holder);
      const made = await makeInHolder(io, holder, join(holder, "probe"), () =>
        io.fs.writeBytesDurable(join(holder, "probe"), new Uint8Array()),
      );
      expect(made.ok).toBe(true);
      expect(fired()).toBe(1);
      expect(existsSync(join(holder, "probe"))).toBe(true);
    }));

  test("a holder removed on every try ends in fs.write-failed with a fix, not a bare ENOENT", () =>
    inRoot(async (root) => {
      const holder = join(root, ".plainport-staging");
      const { io, fired } = seamed(holder, 100);
      const made = await makeInHolder(io, holder, join(holder, "op"), () => io.fs.mkdirp(join(holder, "op")));
      expect(fired()).toBe(3);
      expect(!made.ok && made.finding).toMatchObject({
        code: "fs.write-failed",
        message: `${join(holder, "op")} could not be made: another plainport operation in the same root removed ${holder} 3 times while it was made`,
        fix: "re-run once the other plainport operations in this root have finished",
        paths: [holder],
      });
    }));

  test("any other failure is not retried", () =>
    inRoot(async (root) => {
      let calls = 0;
      const failing = async () => {
        calls++;
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      };
      await expect(
        makeInHolder(nodeLocalIo, join(root, "h"), join(root, "h/x"), failing),
      ).rejects.toMatchObject({
        code: "EACCES",
      });
      expect(calls).toBe(1);
    }));
});

describe("io: removeEmptyHolder, one helper for both holders", () => {
  test("never fails: a holder still in use (ENOTEMPTY) or already gone (ENOENT) is left as it is", async () => {
    const root = mkdtempSync(join(tmpdir(), "plainport-holder-"));
    try {
      const holder = join(root, ".plainport-trash");
      mkdirSync(join(holder, "op"), { recursive: true });
      await removeEmptyHolder(nodeLocalIo, holder, ".plainport-trash");
      expect(existsSync(join(holder, "op"))).toBe(true);
      rmSync(holder, { recursive: true });
      await removeEmptyHolder(nodeLocalIo, holder, ".plainport-trash");
      expect(existsSync(holder)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("removes only a folder with the holder's own name", async () => {
    const root = mkdtempSync(join(tmpdir(), "plainport-holder-"));
    try {
      mkdirSync(join(root, "work"));
      mkdirSync(join(root, ".plainport-staging"));
      await removeEmptyHolder(nodeLocalIo, join(root, "work"), ".plainport-staging");
      await removeEmptyHolder(nodeLocalIo, join(root, ".plainport-staging"), ".plainport-trash");
      expect(existsSync(join(root, "work"))).toBe(true);
      expect(existsSync(join(root, ".plainport-staging"))).toBe(true);
      await removeEmptyHolder(nodeLocalIo, join(root, ".plainport-staging"), ".plainport-staging");
      expect(existsSync(join(root, ".plainport-staging"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
