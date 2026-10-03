import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ok } from "@plainport/contract";
import { nodeLocalIo } from "./node-io.ts";
import { readRegistry, updateRegistry } from "./registry.ts";
import { makeSandbox, type Sandbox } from "./testing/sandbox.ts";

const io = nodeLocalIo;
let box: Sandbox;

beforeEach(() => {
  box = makeSandbox();
});
afterEach(() => box.cleanup());

const entry = { root: "work", path: "web", registeredAt: "2026-10-03T12:00:00.000Z" };

describe("roots: registry.json", () => {
  test("an update writes atomically and cleans up a temp file a crashed writer left", async () => {
    const orphan = box.file(".local/state/plainport/registry.json.4242.abcdef.tmp", "half");
    const result = await updateRegistry(io, box.paths, (registry) => {
      registry.projects["01ARYZ6S410000000000000000"] = entry;
      return ok(registry);
    });
    expect(result.ok).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(readdirSync(dirname(box.paths.registryFile))).toEqual(["registry.json"]);
    expect(JSON.parse(readFileSync(box.paths.registryFile, "utf8")).projects).toEqual({
      "01ARYZ6S410000000000000000": entry,
    });
  });

  test("a registry.json plainport may not read is registry.unreadable with a permission fix, never invalid", async () => {
    if (process.getuid?.() === 0) return; // root reads anything
    const file = box.file(".local/state/plainport/registry.json", JSON.stringify({ v: 1, projects: {} }));
    chmodSync(file, 0o000);
    try {
      const result = await readRegistry(io, box.paths);
      expect(result).toMatchObject({ ok: false, exitCode: 6, finding: { code: "registry.unreadable" } });
      if (!result.ok) expect(result.finding.fix).toContain("chmod");
      const updated = await updateRegistry(io, box.paths, (registry) => ok(registry));
      expect(updated).toMatchObject({ ok: false, finding: { code: "registry.unreadable" } });
    } finally {
      chmodSync(file, 0o644);
    }
    writeFileSync(file, readFileSync(file, "utf8"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, projects: {} });
  });
});
