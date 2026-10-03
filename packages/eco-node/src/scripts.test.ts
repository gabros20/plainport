import { describe, expect, test } from "bun:test";
import { scriptWriting } from "./scripts.ts";

const writes = (script: string, folder: "dist" | "build") => scriptWriting({ build: script }, folder);

describe("Node plugin: dist/ and build/ are proposed only when a package script writes them", () => {
  test("an output flag naming the folder", () => {
    for (const script of [
      "tsc --outDir dist",
      "tsc --outDir ./dist",
      "esbuild src/index.ts --bundle --outdir=dist",
      "bun build ./src/index.ts --outdir dist",
      "babel src --out-dir dist",
      "ncc build index.js -o dist",
      "parcel build index.html --dist-dir dist",
      "esbuild src/a.ts --outfile=dist/a.js",
      "cp -r public dist/",
    ]) {
      expect({ script, by: writes(script, "dist") }).toEqual({ script, by: "build" });
      expect({ script, by: writes(script, "build") }).toEqual({ script, by: undefined });
    }
    expect(writes("vite build --outDir build", "build")).toBe("build");
  });

  test("a tool whose default output is the folder", () => {
    for (const script of [
      "vite build",
      "tsup src/index.ts --format esm",
      "parcel build index.html",
      "webpack --mode production",
      "ng build",
      "vue-cli-service build",
      "astro build",
      "unbuild",
      "microbundle",
    ]) {
      expect({ script, by: writes(script, "dist") }).toEqual({ script, by: "build" });
    }
    for (const script of ["react-scripts build", "docusaurus build", "remix build"]) {
      expect({ script, by: writes(script, "build") }).toEqual({ script, by: "build" });
      expect({ script, by: writes(script, "dist") }).toEqual({ script, by: undefined });
    }
  });

  test("a flag naming another folder overrides the tool's default", () => {
    expect(writes("vite build --outDir build", "dist")).toBeUndefined();
    expect(writes("tsup src/index.ts -d lib", "dist")).toBeUndefined();
  });

  test("a script name, a subcommand or a deletion is not a write", () => {
    for (const script of [
      "npm run build",
      "pnpm build",
      "turbo run build",
      "next build",
      "rm -rf dist build",
      "rimraf dist",
      "tsc",
      "tsc -p tsconfig.build.json",
      "echo distance",
    ]) {
      expect({ script, dist: writes(script, "dist"), build: writes(script, "build") }).toEqual({
        script,
        dist: undefined,
        build: undefined,
      });
    }
  });

  test("every script is looked at; the first that writes the folder is named", () => {
    expect(scriptWriting({ clean: "rimraf dist", compile: "tsup", build: "pnpm compile" }, "dist")).toBe(
      "compile",
    );
    expect(scriptWriting({}, "dist")).toBeUndefined();
  });

  test("commands joined by && or ; are read one by one", () => {
    expect(writes("rimraf dist && tsc --outDir dist", "dist")).toBe("build");
    expect(writes("vite build; cp -r static out", "dist")).toBe("build");
    expect(writes("vite build --outDir out && echo dist", "dist")).toBeUndefined();
  });
});
