import { describe, expect, test } from "bun:test";
import { choosePackageManager } from "./detect.ts";

const choose = (lockfiles: string[], over: { packageManager?: string; yarnrc?: boolean } = {}) =>
  choosePackageManager({ lockfiles: new Set(lockfiles), yarnrc: over.yarnrc ?? false, ...over });

describe("Node plugin: package manager detection (DESIGN.md table)", () => {
  test("each lockfile names its package manager and frozen install", () => {
    expect(choose(["pnpm-lock.yaml"])).toEqual({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      argv: ["pnpm", "install", "--frozen-lockfile"],
    });
    expect(choose(["package-lock.json"])).toEqual({
      manager: "npm",
      lockfile: "package-lock.json",
      argv: ["npm", "ci"],
    });
    expect(choose(["npm-shrinkwrap.json"])).toMatchObject({ manager: "npm", argv: ["npm", "ci"] });
    expect(choose(["yarn.lock"], { yarnrc: true })).toEqual({
      manager: "yarn-berry",
      lockfile: "yarn.lock",
      argv: ["yarn", "install", "--immutable"],
    });
    expect(choose(["yarn.lock"])).toEqual({
      manager: "yarn-classic",
      lockfile: "yarn.lock",
      argv: ["yarn", "install", "--frozen-lockfile"],
    });
    expect(choose(["bun.lock"])).toEqual({
      manager: "bun",
      lockfile: "bun.lock",
      argv: ["bun", "install", "--frozen-lockfile"],
    });
    expect(choose(["bun.lockb"])).toMatchObject({ manager: "bun", lockfile: "bun.lockb" });
  });

  test("the packageManager field overrides lockfile detection", () => {
    expect(choose(["package-lock.json", "pnpm-lock.yaml"], { packageManager: "pnpm@9.12.0" })).toEqual({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      argv: ["pnpm", "install", "--frozen-lockfile"],
    });
    expect(choose(["yarn.lock"], { packageManager: "yarn@1.22.22" })).toMatchObject({
      manager: "yarn-classic",
    });
    expect(choose(["yarn.lock"], { packageManager: "yarn@4.5.0" })).toMatchObject({ manager: "yarn-berry" });
    expect(choose(["bun.lock"], { packageManager: "bun@1.1.30+sha512.abc" })).toMatchObject({
      manager: "bun",
    });
  });

  test("two lockfiles and no packageManager field: the first in the table, with deps.ambiguous", () => {
    expect(choose(["yarn.lock", "package-lock.json"])).toEqual({
      manager: "npm",
      lockfile: "package-lock.json",
      argv: ["npm", "ci"],
      problem: { kind: "ambiguous", lockfiles: ["package-lock.json", "yarn.lock"] },
    });
  });

  test("no lockfile: a plain install that resolves fresh versions, with deps.no-lockfile", () => {
    expect(choose([])).toEqual({
      manager: "npm",
      argv: ["npm", "install"],
      problem: { kind: "no-lockfile" },
    });
    expect(choose(["package-lock.json"], { packageManager: "pnpm@9.0.0" })).toEqual({
      manager: "pnpm",
      argv: ["pnpm", "install"],
      problem: { kind: "no-lockfile" },
    });
  });

  test("a packageManager field naming no known manager falls back to the lockfiles", () => {
    expect(choose(["pnpm-lock.yaml"], { packageManager: "deno@2" })).toMatchObject({ manager: "pnpm" });
    expect(choose(["pnpm-lock.yaml"], { packageManager: "yarn" })).toMatchObject({ manager: "pnpm" });
  });
});
