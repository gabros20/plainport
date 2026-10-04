import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommand, buildPlan, TARGETS } from "./build.ts";

const root = "/repo";

test("covers the four release targets", () => {
  expect([...TARGETS]).toEqual(["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64"]);
});

test("builds the host binary into dist/plainport by default", () => {
  expect(buildPlan(root, {})).toEqual({ ok: true, builds: [{ outfile: "/repo/dist/plainport" }] });
  expect(buildPlan(root, { outfile: "/tmp/x/plainport", target: "bun-linux-x64" })).toEqual({
    ok: true,
    builds: [{ outfile: "/tmp/x/plainport", target: "bun-linux-x64" }],
  });
});

test("--target all cross-compiles every target into dist/plainport-<os>-<arch>", () => {
  expect(buildPlan(root, { target: "all" })).toEqual({
    ok: true,
    builds: [
      { outfile: "/repo/dist/plainport-darwin-arm64", target: "bun-darwin-arm64" },
      { outfile: "/repo/dist/plainport-darwin-x64", target: "bun-darwin-x64" },
      { outfile: "/repo/dist/plainport-linux-x64", target: "bun-linux-x64" },
      { outfile: "/repo/dist/plainport-linux-arm64", target: "bun-linux-arm64" },
    ],
  });
});

test("refuses an unknown target and --outfile with --target all", () => {
  const unknown = buildPlan(root, { target: "bun-windows-x64" });
  expect(unknown.ok).toBe(false);
  if (!unknown.ok) expect(unknown.message).toContain("bun-linux-arm64");
  const both = buildPlan(root, { target: "all", outfile: "/tmp/p" });
  expect(both.ok).toBe(false);
});

test("every build defines the crash matrix's hook off (D67)", () => {
  expect(buildCommand("/bun", root, { outfile: "/tmp/x/plainport" })).toEqual([
    "/bun",
    "build",
    "--compile",
    "/repo/packages/cli/src/main.ts",
    "--outfile",
    "/tmp/x/plainport",
    "--define",
    "globalThis.PLAINPORT_TEST_HOOKS=false",
  ]);
  expect(buildCommand("/bun", root, { outfile: "/o", target: "bun-linux-x64" }).at(-1)).toBe(
    "--target=bun-linux-x64",
  );
});

test("an installed build also defines PLAINPORT_INSTALLED, so it never looks for a checkout's tools (N1)", () => {
  expect(buildCommand("/bun", root, { outfile: "/o", installed: true }).slice(-2)).toEqual([
    "--define",
    "globalThis.PLAINPORT_INSTALLED=true",
  ]);
  expect(buildCommand("/bun", root, { outfile: "/o" }).join(" ")).not.toContain("PLAINPORT_INSTALLED");
  expect(buildPlan(root, { installed: true })).toEqual({
    ok: true,
    builds: [{ outfile: "/repo/dist/plainport", installed: true }],
  });
});

// The release binary, built as `bun run build` builds it, holds no trace of the hook: its variables are not even
// strings in it (the define folds the composition root's test, and the bundler drops the module).
test("a binary built by scripts/build.ts contains none of the hook's variable names (D67)", () => {
  const out = mkdtempSync(join(tmpdir(), "plainport-build-"));
  try {
    const outfile = join(out, "plainport");
    const built = Bun.spawnSync([process.execPath, join(import.meta.dir, "build.ts"), "--outfile", outfile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(built.exitCode).toBe(0);
    const bytes = readFileSync(outfile).toString("latin1");
    const names = [
      "PLAINPORT_TEST_FAULT_AT",
      "PLAINPORT_TEST_FAULT_OCCURRENCE",
      "PLAINPORT_TEST_PAUSE_AT",
      "PLAINPORT_TEST_PAUSE_FILE",
    ];
    expect(names.filter((n) => bytes.includes(n))).toEqual([]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
