import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "@plainport/contract";
import { nodeLocalIo } from "../node-io.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { canonicalPath, overlapOf } from "./canonical.ts";

const io = nodeLocalIo;
const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.finding.message);
  return result.value;
};
let box: Sandbox;

beforeEach(() => {
  box = makeSandbox();
});
afterEach(() => box.cleanup());

describe("roots: real paths", () => {
  test("a symlinked folder resolves to its target", async () => {
    const target = box.dir("Developer/Work");
    symlinkSync(target, join(box.home, "work"));
    const canon = unwrap(await canonicalPath(io, join(box.home, "work"), box.home));
    expect(canon.real).toBe(realpathSync.native(target));
  });

  test("a path that does not exist yet resolves through its nearest existing ancestor", async () => {
    const parent = box.dir("code");
    symlinkSync(parent, join(box.home, "link"));
    const canon = unwrap(await canonicalPath(io, join(box.home, "link", "new", "deeper"), box.home));
    expect(canon.real).toBe(join(realpathSync.native(parent), "new", "deeper"));
  });

  test("a relative path resolves against the cwd it is given, never the process's", async () => {
    const base = box.dir("base");
    const canon = unwrap(await canonicalPath(io, "child/x", base));
    expect(canon.path).toBe(join(base, "child/x"));
    expect(canon.real).toBe(join(realpathSync.native(base), "child/x"));
  });

  test("case sensitivity is probed on the volume itself, writing nothing", async () => {
    box.dir("Probe");
    const insensitive = existsSync(join(box.home, "probe"));
    const canon = unwrap(await canonicalPath(io, join(box.home, "Probe"), box.home));
    expect(canon.caseInsensitive).toBe(insensitive);
  });

  test("overlap: the same folder, inside, containing, or apart", () => {
    const at = (real: string, caseInsensitive = false) => ({ path: real, real, caseInsensitive });
    expect(overlapOf(at("/a/work"), at("/a/work"))).toBe("same");
    expect(overlapOf(at("/a/work/personal"), at("/a/work"))).toBe("inside");
    expect(overlapOf(at("/a/work"), at("/a/work/personal"))).toBe("contains");
    expect(overlapOf(at("/a/work"), at("/a/workshop"))).toBeUndefined();
    expect(overlapOf(at("/a/Work"), at("/a/work"))).toBeUndefined();
    expect(overlapOf(at("/a/Work", true), at("/a/work", true))).toBe("same");
    expect(overlapOf(at("/a/Work/x", true), at("/a/work", true))).toBe("inside");
    expect(overlapOf(at("/a/café", true), at("/a/café", true))).toBe("same");
    expect(overlapOf(at("/"), at("/a"))).toBe("contains");
  });
});
