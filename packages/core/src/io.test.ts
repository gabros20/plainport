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
import { type LocalIo, makeInHolder, systemErrorCode } from "./io.ts";
import { nodeLocalIo } from "./node-io.ts";
import { removeHolderIfEmpty } from "./recover/staging.ts";
import { removeEmptyTrashHolder } from "./saga/release.ts";

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
   * nodeLocalIo, but mkdirp makes each missing folder in turn (as mkdir -p does) and calls `seam` between the holder
   * and the folder inside it: the window in which another operation's rmdir of the empty holder lands.
   */
  const seamed = (holder: string) => {
    const seam = () => rmdirSync(holder);
    let fired = false;
    const once = () => {
      if (fired) return;
      fired = true;
      seam();
    };
    const io = {
      ...nodeLocalIo,
      fs: {
        ...nodeLocalIo.fs,
        mkdirp: async (path: string) => {
          // mkdir -p's last step: the parent made (or found), then the folder itself, which needs the parent.
          await nodeLocalIo.fs.mkdirp(dirname(path));
          if (dirname(path) === holder) once();
          if (!existsSync(path)) mkdirSync(path);
        },
        writeBytesDurable: async (path: string, data: Uint8Array, options?: { exclusive?: boolean }) => {
          once();
          await nodeLocalIo.fs.writeBytesDurable(path, data, options);
        },
      },
    };
    return io as LocalIo;
  };

  test("the seam reproduces the race: a plain mkdir -p of the child fails with ENOENT", async () => {
    const root = mkdtempSync(join(tmpdir(), "plainport-holder-"));
    try {
      const holder = join(root, ".plainport-staging");
      const io = seamed(holder);
      expect(io.fs.mkdirp(join(holder, "op"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the child is made all the same: the holder is made again and the step retried", async () => {
    const root = mkdtempSync(join(tmpdir(), "plainport-holder-"));
    try {
      const holder = join(root, ".plainport-staging");
      const io = seamed(holder);
      await makeInHolder(io, holder, () => io.fs.mkdirp(join(holder, "op")));
      expect(existsSync(join(holder, "op"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a file written in the holder (the case probe) is written all the same", async () => {
    const root = mkdtempSync(join(tmpdir(), "plainport-holder-"));
    try {
      const holder = join(root, ".plainport-staging");
      mkdirSync(holder);
      const io = seamed(holder);
      await makeInHolder(io, holder, () => io.fs.writeBytesDurable(join(holder, "probe"), new Uint8Array()));
      expect(existsSync(join(holder, "probe"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("any other failure is not retried", async () => {
    let calls = 0;
    const failing = async () => {
      calls++;
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    const root = mkdtempSync(join(tmpdir(), "plainport-holder-"));
    try {
      await expect(makeInHolder(nodeLocalIo, join(root, "h"), failing)).rejects.toMatchObject({
        code: "EACCES",
      });
      expect(calls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("removing a holder never fails: one still in use (ENOTEMPTY) or already gone (ENOENT) is left as it is", async () => {
    const root = mkdtempSync(join(tmpdir(), "plainport-holder-"));
    try {
      const holder = join(root, ".plainport-trash");
      mkdirSync(join(holder, "op"), { recursive: true });
      await removeHolderIfEmpty(nodeLocalIo, holder);
      await removeEmptyTrashHolder(nodeLocalIo, join(holder, "op"));
      expect(existsSync(join(holder, "op"))).toBe(true);
      rmSync(holder, { recursive: true });
      await removeHolderIfEmpty(nodeLocalIo, holder);
      await removeEmptyTrashHolder(nodeLocalIo, join(holder, "op"));
      expect(existsSync(holder)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
