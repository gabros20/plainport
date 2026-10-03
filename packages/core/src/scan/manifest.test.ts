import { describe, expect, test } from "bun:test";
import { formatNs, ManifestBuilder, ManifestEntrySchema } from "./manifest.ts";

describe("scan: the manifest", () => {
  test("formats nanosecond times as RFC 3339 in UTC with every fraction digit", () => {
    expect(formatNs(1_790_994_562_223_449_044n)).toBe("2026-10-03T02:29:22.223449044Z");
    expect(formatNs(0n)).toBe("1970-01-01T00:00:00.000000000Z");
    expect(formatNs(-1n)).toBe("1969-12-31T23:59:59.999999999Z");
  });

  test("hands entries back in scan order and by path, with size for files and targets for symlinks", () => {
    const builder = new ManifestBuilder();
    builder.add({ path: "src", type: "dir", size: 0, mode: 0o755, mtimeNs: 1n });
    builder.add({ path: "src/a.ts", type: "file", size: 12, mode: 0o644, mtimeNs: 2_000_000_003n });
    builder.add({ path: "link", type: "symlink", size: 6, mode: 0o755, mtimeNs: 3n, linkTarget: "src/a" });
    const manifest = builder.finish();
    expect(manifest.size).toBe(3);
    expect([...manifest].map((e) => e.path)).toEqual(["src", "src/a.ts", "link"]);
    expect(manifest.get("src/a.ts")).toEqual({
      path: "src/a.ts",
      type: "file",
      size: 12,
      mode: 0o644,
      mtime: "1970-01-01T00:00:02.000000003Z",
    });
    expect(manifest.get("src")).toEqual({
      path: "src",
      type: "dir",
      mode: 0o755,
      mtime: "1970-01-01T00:00:00.000000001Z",
    });
    expect(manifest.get("link")?.linkTarget).toBe("src/a");
    expect(manifest.get("missing")).toBeUndefined();
    for (const entry of manifest) expect(ManifestEntrySchema.safeParse(entry).success).toBe(true);
  });

  test("200,000 entries stay packed: well under 100 bytes each beyond the path, and every one is found", () => {
    const builder = new ManifestBuilder();
    const n = 200_000;
    const pathOf = (i: number) => `packages/app-${i % 97}/src/module-${i}/file-${i}.ts`;
    let pathChars = 0;
    for (let i = 0; i < n; i++) {
      const path = pathOf(i);
      pathChars += path.length;
      builder.add({ path, type: "file", size: i, mode: 0o644, mtimeNs: BigInt(i) * 1_000_000_007n });
    }
    const manifest = builder.finish();
    expect(manifest.size).toBe(n);
    const perEntry = (manifest.approxBytes - 2 * pathChars) / n;
    expect(perEntry).toBeLessThan(100);
    for (const i of [0, 1, 4_242, 99_999, n - 1]) expect(manifest.get(pathOf(i))?.size).toBe(i);
  });
});
