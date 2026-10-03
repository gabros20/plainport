import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemErrorCode } from "./io.ts";
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
