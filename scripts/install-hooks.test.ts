import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHooks } from "./install-hooks.ts";

let repo = "";

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "plainport-hooks-"));
  const init = Bun.spawnSync(["git", "init", "-q", repo]);
  if (init.exitCode !== 0) throw new Error(init.stderr.toString());
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const hookPath = () => join(repo, ".git", "hooks", "pre-commit");

test("installs an executable pre-commit shim that runs scripts/pre-commit", () => {
  expect(installHooks(repo)).toEqual({ ok: true, message: `installed ${hookPath()}` });
  const shim = readFileSync(hookPath(), "utf8");
  expect(shim).toContain("scripts/pre-commit");
  expect(statSync(hookPath()).mode & 0o111).not.toBe(0);
});

test("is idempotent", () => {
  installHooks(repo);
  expect(installHooks(repo)).toEqual({ ok: true, message: `already installed: ${hookPath()}` });
});

test("refuses to replace a pre-commit hook it did not write", () => {
  writeFileSync(hookPath(), "#!/bin/sh\necho mine\n");
  const result = installHooks(repo);
  expect(result.ok).toBe(false);
  expect(result.message).toContain("not written by plainport");
  expect(readFileSync(hookPath(), "utf8")).toBe("#!/bin/sh\necho mine\n");
});
