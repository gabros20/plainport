import { expect, test } from "bun:test";
import { buildPlan, TARGETS } from "./build.ts";

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
