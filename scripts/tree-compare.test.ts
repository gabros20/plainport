// Tree comparison for the gates (M2 Task 3): type, mode, content, link target, hard-link groups, extended attributes
// and BSD flags. Each fixture is built twice, then one side is broken in exactly one way.

import { afterAll, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareTrees, hashTree } from "./tree-compare.ts";

const scratch = mkdtempSync(join(tmpdir(), "plainport-tree-compare-"));
const flagged: string[] = [];
afterAll(() => {
  for (const file of flagged) Bun.spawnSync(["chflags", "nouchg", file]);
  rmSync(scratch, { recursive: true, force: true });
});

const darwin = process.platform === "darwin";

const make = (
  name: string,
  options: { hardLink?: boolean; xattr?: boolean; uchg?: boolean } = {},
): string => {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "doc.md"), "# doc\n");
  if (options.hardLink === false) writeFileSync(join(dir, "src/b.ts"), "export const a = 1;\n");
  else linkSync(join(dir, "src/a.ts"), join(dir, "src/b.ts"));
  symlinkSync("src/a.ts", join(dir, "link"));
  if (options.xattr === true) {
    const set = Bun.spawnSync(["xattr", "-w", "user.plainport.test", "kept", join(dir, "doc.md")]);
    if (set.exitCode !== 0) throw new Error(`xattr -w failed: ${set.stderr.toString()}`);
  }
  if (options.uchg === true) {
    const set = Bun.spawnSync(["chflags", "uchg", join(dir, "doc.md")]);
    if (set.exitCode !== 0) throw new Error(`chflags failed: ${set.stderr.toString()}`);
    flagged.push(join(dir, "doc.md"));
  }
  return dir;
};

describe("tree comparison", () => {
  test("two equal trees compare clean", () => {
    expect(compareTrees(hashTree(make("eq-1"), []), hashTree(make("eq-2"), []))).toEqual([]);
  });

  test("a broken hard link is named, with the files that shared it", () => {
    const problems = compareTrees(
      hashTree(make("hl-1"), []),
      hashTree(make("hl-2", { hardLink: false }), []),
    );
    expect(problems).toEqual([
      "changed src/a.ts: hard links with src/b.ts → none",
      "changed src/b.ts: hard links with src/a.ts → none",
    ]);
  });

  test("hard links to a stripped path do not count", () => {
    const one = make("hs-1");
    linkSync(join(one, "doc.md"), join(one, "src/doc-link.md"));
    const two = make("hs-2");
    writeFileSync(join(two, "doc.md"), "# doc\n");
    expect(compareTrees(hashTree(one, ["src/doc-link.md"]), hashTree(two, []))).toEqual([]);
  });

  test.skipIf(!darwin)("a dropped extended attribute is named", () => {
    const problems = compareTrees(hashTree(make("xa-1", { xattr: true }), []), hashTree(make("xa-2"), []));
    expect(problems).toEqual(["changed doc.md: xattr user.plainport.test dropped"]);
  });

  test.skipIf(!darwin)("a changed extended attribute value is named", () => {
    const one = make("xv-1", { xattr: true });
    const two = make("xv-2", { xattr: true });
    Bun.spawnSync(["xattr", "-w", "user.plainport.test", "other", join(two, "doc.md")]);
    expect(compareTrees(hashTree(one, []), hashTree(two, []))).toEqual([
      "changed doc.md: xattr user.plainport.test value",
    ]);
  });

  test.skipIf(!darwin)("the kernel's own provenance attribute is not compared", () => {
    const one = make("pv-1");
    const two = make("pv-2");
    Bun.spawnSync(["xattr", "-c", join(two, "doc.md")]);
    expect(compareTrees(hashTree(one, []), hashTree(two, []))).toEqual([]);
  });

  test.skipIf(!darwin)("a dropped uchg flag is named", () => {
    const problems = compareTrees(hashTree(make("fl-1", { uchg: true }), []), hashTree(make("fl-2"), []));
    expect(problems).toEqual(["changed doc.md: flags uchg → none"]);
  });

  test("still names a changed type, mode, content, target, and missing and extra paths", () => {
    const one = make("old-1");
    const two = make("old-2");
    writeFileSync(join(two, "doc.md"), "# other\n");
    rmSync(join(two, "link"));
    symlinkSync("doc.md", join(two, "link"));
    writeFileSync(join(two, "extra.txt"), "x");
    rmSync(join(two, "src/b.ts"));
    expect(compareTrees(hashTree(one, []), hashTree(two, []))).toEqual([
      "changed doc.md: content",
      "extra extra.txt",
      "changed link: target src/a.ts → doc.md",
      "changed src/a.ts: hard links with src/b.ts → none",
      "missing src/b.ts",
    ]);
  });
});
