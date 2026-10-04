import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupSession, prepareSessionCleanup, projectSlug } from "./session.ts";

test("session cleanup derives the real cwd slug and removes only a newly created project", () => {
  const home = mkdtempSync(join(tmpdir(), "plainport-session-test-"));
  try {
    const area = mkdtempSync(join(home, "plainport-agent-smoke-"));
    const alias = join(home, "alias");
    symlinkSync(area, alias);
    const slug = realpathSync(area).replace(/[^a-zA-Z0-9]/g, "-");
    expect(projectSlug(alias)).toBe(slug);
    const plan = prepareSessionCleanup(home, alias);
    expect(plan.path).toBe(join(realpathSync(home), ".claude/projects", slug));
    mkdirSync(plan.path, { recursive: true });
    writeFileSync(join(plan.path, "tool-output"), "fixture");
    const neighbor = join(home, ".claude/projects/owner");
    mkdirSync(neighbor);
    expect(cleanupSession(plan)).toEqual([plan.path]);
    expect(existsSync(plan.path)).toBe(false);
    expect(existsSync(neighbor)).toBe(true);
    mkdirSync(plan.path);
    expect(cleanupSession(prepareSessionCleanup(home, area))).toEqual([]);
    expect(existsSync(plan.path)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("session cleanup refuses paths without the unique temp prefix or outside projects, including symlinks", () => {
  const home = mkdtempSync(join(tmpdir(), "plainport-session-test-"));
  try {
    const area = mkdtempSync(join(home, "plainport-agent-smoke-"));
    const plan = prepareSessionCleanup(home, area);
    const outside = join(home, "owner");
    mkdirSync(outside);
    expect(() => cleanupSession({ ...plan, path: outside })).toThrow();
    expect(() => prepareSessionCleanup(home, outside)).toThrow();
    mkdirSync(join(home, ".claude/projects"), { recursive: true });
    symlinkSync(outside, plan.path);
    expect(() => cleanupSession(plan)).toThrow();
    expect(existsSync(outside)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
