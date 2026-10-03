import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { nodeLocalIo } from "../node-io.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { canonicalPath, overlapOf } from "./canonical.ts";

const io = nodeLocalIo;
let box: Sandbox;

beforeEach(() => {
  box = makeSandbox();
});
afterEach(() => box.cleanup());

describe("roots: real paths", () => {
  test("a symlinked folder resolves to its target", async () => {
    const target = box.dir("Developer/Work");
    symlinkSync(target, join(box.home, "work"));
    const canon = await canonicalPath(io, join(box.home, "work"));
    expect(canon.real).toBe(realpathSync.native(target));
  });

  test("a path that does not exist yet resolves through its nearest existing ancestor", async () => {
    const parent = box.dir("code");
    symlinkSync(parent, join(box.home, "link"));
    const canon = await canonicalPath(io, join(box.home, "link", "new", "deeper"));
    expect(canon.real).toBe(join(realpathSync.native(parent), "new", "deeper"));
  });

  test("case sensitivity is probed on the volume itself, writing nothing", async () => {
    box.dir("Probe");
    const insensitive = existsSync(join(box.home, "probe"));
    const canon = await canonicalPath(io, join(box.home, "Probe"));
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
