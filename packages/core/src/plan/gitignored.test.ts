import { describe, expect, test } from "bun:test";
import type { LocalFs } from "../io.ts";
import { gitignoredFiles } from "./gitignored.ts";

/** Only readText is used: the .gitignore files, by path under /p. */
const fsWith = (files: Record<string, string>) =>
  ({
    readText: async (path: string) => {
      const text = files[path.slice("/p/".length)];
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    },
  }) as unknown as LocalFs;

describe("plan: included files the project's .gitignore files ignore", () => {
  test("a deeper .gitignore decides over a shallower one; a file in an ignored folder stays ignored", async () => {
    const ignores = {
      ".gitignore": ".env\n*.sqlite\nsecrets/\n!secrets/a.txt\n",
      "db/.gitignore": "!keep.sqlite\n",
    };
    const files = [
      ".gitignore",
      ".env",
      "db/.gitignore",
      "db/dev.sqlite",
      "db/keep.sqlite",
      "secrets/a.txt",
      "src/a.ts",
    ];
    expect(await gitignoredFiles(fsWith(ignores), "/p", files)).toEqual([
      ".env",
      "db/dev.sqlite",
      "secrets/a.txt",
    ]);
  });

  test("no .gitignore, nothing named", async () => {
    expect(await gitignoredFiles(fsWith({}), "/p", [".env", "src/a.ts"])).toEqual([]);
  });
});
