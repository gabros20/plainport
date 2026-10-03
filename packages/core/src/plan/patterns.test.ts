import { describe, expect, test } from "bun:test";
import { compilePatterns } from "./patterns.ts";

const matches = (patterns: string[], path: string, kind: "file" | "dir" = "file") =>
  compilePatterns(patterns).matches(path, kind);

describe("plan: strip patterns use gitignore syntax, relative to the project", () => {
  test("a pattern without a slash matches a name at any depth", () => {
    expect(matches(["coverage"], "coverage", "dir")).toBe(true);
    expect(matches(["coverage"], "apps/web/coverage", "dir")).toBe(true);
    expect(matches(["*.log"], "logs/today.log")).toBe(true);
    expect(matches(["*.log"], "today.log.txt")).toBe(false);
  });

  test("a pattern with a slash is anchored to the project folder", () => {
    expect(matches(["public/generated/**"], "public/generated/a/b.png")).toBe(true);
    expect(matches(["public/generated/**"], "x/public/generated/a.png")).toBe(false);
    expect(matches(["/dist"], "dist", "dir")).toBe(true);
    expect(matches(["/dist"], "apps/dist", "dir")).toBe(false);
    expect(matches([".vercel/project.json"], ".vercel/project.json")).toBe(true);
  });

  test("a trailing slash matches folders only", () => {
    expect(matches(["dist/"], "dist", "dir")).toBe(true);
    expect(matches(["dist/"], "dist", "file")).toBe(false);
    expect(matches(["dist/"], "packages/ui/dist", "dir")).toBe(true);
  });

  test("** matches any number of folders, * and ? stay inside one name", () => {
    expect(matches(["**/coverage"], "coverage", "dir")).toBe(true);
    expect(matches(["**/coverage"], "a/b/coverage", "dir")).toBe(true);
    expect(matches(["a/**/z"], "a/z", "dir")).toBe(true);
    expect(matches(["a/**/z"], "a/b/c/z", "dir")).toBe(true);
    expect(matches(["a/*"], "a/b/c")).toBe(false);
    expect(matches(["file?.txt"], "file1.txt")).toBe(true);
    expect(matches(["file?.txt"], "file/.txt")).toBe(false);
  });

  test("regex characters in a pattern are literal; blank lines, comments and negations match nothing", () => {
    expect(matches(["a+b(c).txt"], "a+b(c).txt")).toBe(true);
    expect(matches(["a+b(c).txt"], "aab(c).txt")).toBe(false);
    expect(matches(["", "# dist", "!dist"], "dist", "dir")).toBe(false);
  });

  test("covers() is true for a match on the path or on any folder above it", () => {
    const set = compilePatterns(["dist/"]);
    expect(set.covers("dist/a/b.js")).toBe(true);
    expect(set.covers("src/dist.js")).toBe(false);
  });
});
