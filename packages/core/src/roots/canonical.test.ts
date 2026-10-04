import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "@plainport/contract";
import { nodeLocalIo } from "../node-io.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { canonicalPath, overlapByIdentity, overlapOf } from "./canonical.ts";

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

// F3: one folder may have two spellings. On macOS, realpath(3) already folds a firmlink spelling
// (/System/Volumes/Data/private/var/… is /private/var/…), which the first test pins; an alias realpath leaves apart
// (a Linux bind mount, a resolver that does not fold) is simulated by an io whose realpath keeps the firmlink spelling,
// so only (dev, ino) can tell it is the same folder. Skipped where that spelling does not exist (Linux).
describe("roots: overlap by identity (F3)", () => {
  const ALIAS = "/System/Volumes/Data";
  const firm = (path: string) => `${ALIAS}${realpathSync(path)}`;
  /** realpath that leaves the alias spelling as it is, as a bind mount's would. */
  const unfolded: typeof io = {
    ...io,
    fs: {
      ...io.fs,
      realpath: async (path: string) => (path.startsWith(`${ALIAS}/`) ? path : io.fs.realpath(path)),
    },
  };
  const darwin = process.platform === "darwin";

  test.skipIf(!darwin)("macOS realpath folds the firmlink spelling of a temp folder by itself", async () => {
    const work = box.dir("work/web");
    expect(existsSync(firm(work))).toBe(true);
    const linked = unwrap(await canonicalPath(io, firm(work), box.home));
    expect(linked.real).toBe(realpathSync(work));
  });

  test.skipIf(!darwin)(
    "same, inside, contains and apart hold across an alias realpath leaves apart, for folders there or not",
    async () => {
      const work = box.dir("work/web");
      const canon = async (path: string) => unwrap(await canonicalPath(unfolded, path, box.home));
      expect(overlapOf(await canon(firm(work)), await canon(work))).toBeUndefined();
      const by = async (a: string, b: string) =>
        unwrap(await overlapByIdentity(unfolded, await canon(a), await canon(b)));
      expect(await by(firm(work), work)).toBe("same");
      expect(await by(join(firm(work), ".next/archive"), work)).toBe("inside");
      expect(await by(work, join(firm(work), ".next/archive"))).toBe("contains");
      expect(await by(join(firm(box.home), "work"), join(work, "missing/deeper"))).toBe("contains");
      expect(await by(join(firm(work), "a"), join(work, "b"))).toBeUndefined();
      expect(await by(box.dir("other"), firm(work))).toBeUndefined();
    },
  );
});
