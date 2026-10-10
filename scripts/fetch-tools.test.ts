import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Fetcher,
  fetchTools,
  type Lock,
  parseLock,
  pinnedProblems,
  resticForMatrix,
} from "./fetch-tools.ts";

const fixtures = join(import.meta.dir, "../test/fixtures/tools");
const resticArchive = new Uint8Array(readFileSync(join(fixtures, "restic-fixture.bz2")));
const rcloneArchive = new Uint8Array(readFileSync(join(fixtures, "rclone-fixture.zip")));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const RESTIC_URL = "https://example.invalid/restic_0.0.0_darwin_arm64.bz2";
const RCLONE_URL = "https://example.invalid/rclone-v0.0.0-osx-arm64.zip";
const MATRIX_URL = "https://example.invalid/restic_0.0.1_darwin_arm64.bz2";

const target = (url: string, bytes: Uint8Array, member?: string) => ({
  url,
  sha256: sha256(bytes),
  ...(member === undefined ? {} : { member }),
});
const fixtureLock = (): Lock => {
  const restic = target(RESTIC_URL, resticArchive);
  const rclone = target(RCLONE_URL, rcloneArchive, "rclone-v0.0.0-fixture/rclone");
  const all = <T>(value: T) => ({
    "darwin-arm64": value,
    "darwin-x64": value,
    "linux-x64": value,
    "linux-arm64": value,
  });
  return {
    tools: {
      restic: {
        version: "0.0.0",
        checksums: "https://example.invalid/SHA256SUMS",
        format: "bz2",
        targets: all(restic),
      },
      rclone: {
        version: "0.0.0",
        checksums: "https://example.invalid/SHA256SUMS",
        format: "zip",
        targets: all(rclone),
      },
    },
    matrix: {
      restic: [
        {
          version: "0.0.1",
          checksums: "https://example.invalid/SHA256SUMS",
          format: "bz2",
          targets: all(target(MATRIX_URL, resticArchive)),
        },
      ],
    },
  };
};

// A fetcher that serves the fixture archives and never touches the network.
const fixtureFetcher = (overrides: Record<string, Uint8Array> = {}): Fetcher & { calls: string[] } => {
  const calls: string[] = [];
  const serve = async (url: string): Promise<Uint8Array> => {
    calls.push(url);
    const bytes =
      overrides[url] ??
      { [RESTIC_URL]: resticArchive, [RCLONE_URL]: rcloneArchive, [MATRIX_URL]: resticArchive }[url];
    if (bytes === undefined) throw new Error(`no fixture for ${url}`);
    return bytes;
  };
  return Object.assign(serve, { calls });
};

describe("tools: fetch-tools", () => {
  let dir: string;
  let destRoot: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plainport-fetch-tools-"));
    destRoot = join(dir, ".tools");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a checksum mismatch refuses and leaves no file behind", async () => {
    const tampered = new Uint8Array(resticArchive);
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;
    const fetcher = fixtureFetcher({ [RESTIC_URL]: tampered });

    const result = await fetchTools({ lock: fixtureLock(), targets: ["darwin-arm64"], destRoot, fetcher });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("tool.checksum_mismatch");
    expect(result.message).toContain(RESTIC_URL);
    expect(result.message).toContain(sha256(tampered));
    expect(result.message).toContain(fixtureLock().tools.restic.targets["darwin-arm64"].sha256);
    expect(existsSync(destRoot)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("pinnedProblems passes fetched tools and names a stale lock, a changed binary or a missing pin", async () => {
    await fetchTools({ lock: fixtureLock(), targets: ["darwin-arm64"], destRoot, fetcher: fixtureFetcher() });
    const folder = join(destRoot, "darwin-arm64");
    expect(pinnedProblems(folder, fixtureLock(), "darwin-arm64")).toEqual([]);
    const bumped = fixtureLock();
    bumped.tools.rclone.version = "9.9.9";
    expect(pinnedProblems(folder, bumped, "darwin-arm64")).toEqual([
      `rclone in ${folder} is not the 9.9.9 tools.lock.json pins`,
    ]);
    chmodSync(join(folder, "restic"), 0o755);
    writeFileSync(join(folder, "restic"), "#!/bin/sh\n");
    rmSync(join(folder, ".rclone.pin"));
    expect(pinnedProblems(folder, fixtureLock(), "darwin-arm64")).toEqual([
      `restic in ${folder} is not the 0.0.0 tools.lock.json pins`,
      `rclone in ${folder} is not the 0.0.0 tools.lock.json pins`,
    ]);
  });

  test("a mismatch on an existing install leaves the installed binary alone", async () => {
    const first = await fetchTools({
      lock: fixtureLock(),
      targets: ["darwin-arm64"],
      destRoot,
      fetcher: fixtureFetcher(),
    });
    expect(first.ok).toBe(true);
    const binary = join(destRoot, "darwin-arm64", "restic");
    const before = readFileSync(binary);

    const lock = fixtureLock();
    lock.tools.restic.targets["darwin-arm64"].sha256 = "0".repeat(64);
    const result = await fetchTools({ lock, targets: ["darwin-arm64"], destRoot, fetcher: fixtureFetcher() });

    expect(result).toMatchObject({ ok: false, code: "tool.checksum_mismatch" });
    expect(readFileSync(binary)).toEqual(before);
    expect(readdirSync(join(destRoot, "darwin-arm64")).sort()).toEqual([
      ".rclone.pin",
      ".restic.pin",
      "rclone",
      "restic",
    ]);
  });

  test("verified archives are unpacked into .tools/<os>-<arch>/ as executables", async () => {
    const result = await fetchTools({
      lock: fixtureLock(),
      targets: ["linux-x64"],
      destRoot,
      fetcher: fixtureFetcher(),
    });

    expect(result).toMatchObject({
      ok: true,
      tools: [
        { name: "restic", status: "installed", path: join(destRoot, "linux-x64", "restic") },
        { name: "rclone", status: "installed", path: join(destRoot, "linux-x64", "rclone") },
      ],
    });
    for (const [name, expected] of [
      ["restic", "restic 0.0.0-fixture\n"],
      ["rclone", "rclone v0.0.0-fixture\n"],
    ] as const) {
      const path = join(destRoot, "linux-x64", name);
      expect(statSync(path).mode & 0o111).toBe(0o111);
      expect(Bun.spawnSync([path]).stdout.toString()).toBe(expected);
    }
    expect(readdirSync(join(destRoot, "linux-x64")).filter((entry) => entry.startsWith(".fetch-"))).toEqual(
      [],
    );
  });

  test("a second run skips tools that are already verified, and re-fetches a binary that changed", async () => {
    await fetchTools({ lock: fixtureLock(), targets: ["darwin-arm64"], destRoot, fetcher: fixtureFetcher() });

    const again = fixtureFetcher();
    const second = await fetchTools({
      lock: fixtureLock(),
      targets: ["darwin-arm64"],
      destRoot,
      fetcher: again,
    });
    expect(second).toMatchObject({ ok: true, tools: [{ status: "current" }, { status: "current" }] });
    expect(again.calls).toEqual([]);

    writeFileSync(join(destRoot, "darwin-arm64", "rclone"), "#!/bin/sh\necho tampered\n");
    const third = fixtureFetcher();
    const result = await fetchTools({
      lock: fixtureLock(),
      targets: ["darwin-arm64"],
      destRoot,
      fetcher: third,
    });
    expect(result).toMatchObject({ ok: true, tools: [{ status: "current" }, { status: "installed" }] });
    expect(third.calls).toEqual([RCLONE_URL]);
    expect(Bun.spawnSync([join(destRoot, "darwin-arm64", "rclone")]).stdout.toString()).toBe(
      "rclone v0.0.0-fixture\n",
    );
  });

  test("a download failure is a tool.download_failed value", async () => {
    const fetcher: Fetcher = async () => {
      throw new Error("HTTP 404");
    };
    const result = await fetchTools({ lock: fixtureLock(), targets: ["darwin-arm64"], destRoot, fetcher });
    expect(result).toMatchObject({ ok: false, code: "tool.download_failed" });
    if (!result.ok) expect(result.message).toContain("HTTP 404");
    expect(existsSync(destRoot)).toBe(false);
  });

  test("an archive without the expected member is a tool.extract_failed value and installs nothing", async () => {
    const lock = fixtureLock();
    lock.tools.rclone.targets["darwin-arm64"].member = "rclone-v0.0.0-fixture/missing";
    const result = await fetchTools({ lock, targets: ["darwin-arm64"], destRoot, fetcher: fixtureFetcher() });
    expect(result).toMatchObject({ ok: false, code: "tool.extract_failed" });
    // restic unpacked fine, but nothing is installed unless every tool is.
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a mismatch on the second tool leaves no file behind, not even the first tool", async () => {
    const tampered = new Uint8Array(rcloneArchive);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const fetcher = fixtureFetcher({ [RCLONE_URL]: tampered });

    const result = await fetchTools({ lock: fixtureLock(), targets: ["darwin-arm64"], destRoot, fetcher });

    expect(result).toMatchObject({ ok: false, code: "tool.checksum_mismatch" });
    if (!result.ok) expect(result.message).toContain(RCLONE_URL);
    expect(fetcher.calls).toEqual([RESTIC_URL, RCLONE_URL]);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a mismatch on a later target leaves the earlier targets uninstalled", async () => {
    const lock = fixtureLock();
    const otherUrl = "https://example.invalid/rclone-v0.0.0-linux-amd64.zip";
    lock.tools.rclone.targets["linux-x64"] = { ...lock.tools.rclone.targets["linux-x64"], url: otherUrl };
    const fetcher = fixtureFetcher({ [otherUrl]: new Uint8Array([1, 2, 3]) });

    const result = await fetchTools({ lock, targets: ["darwin-arm64", "linux-x64"], destRoot, fetcher });

    expect(result).toMatchObject({ ok: false, code: "tool.checksum_mismatch" });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a mismatch beside an existing install adds no new file to it", async () => {
    await fetchTools({ lock: fixtureLock(), targets: ["darwin-arm64"], destRoot, fetcher: fixtureFetcher() });
    const lock = fixtureLock();
    lock.tools.restic.targets["linux-x64"] = {
      ...lock.tools.restic.targets["linux-x64"],
      sha256: "0".repeat(64),
    };

    const result = await fetchTools({ lock, targets: ["linux-x64"], destRoot, fetcher: fixtureFetcher() });

    expect(result).toMatchObject({ ok: false, code: "tool.checksum_mismatch" });
    expect(readdirSync(destRoot)).toEqual(["darwin-arm64"]);
  });

  test("a cached binary that lost its executable bit is installed again", async () => {
    await fetchTools({ lock: fixtureLock(), targets: ["darwin-arm64"], destRoot, fetcher: fixtureFetcher() });
    const restic = join(destRoot, "darwin-arm64", "restic");
    chmodSync(restic, 0o644);

    const fetcher = fixtureFetcher();
    const result = await fetchTools({ lock: fixtureLock(), targets: ["darwin-arm64"], destRoot, fetcher });

    expect(result).toMatchObject({ ok: true, tools: [{ status: "installed" }, { status: "current" }] });
    expect(fetcher.calls).toEqual([RESTIC_URL]);
    expect(statSync(restic).mode & 0o111).toBe(0o111);
  });

  test("several targets install in one run, each into its own folder", async () => {
    const result = await fetchTools({
      lock: fixtureLock(),
      targets: ["darwin-arm64", "linux-arm64"],
      destRoot,
      fetcher: fixtureFetcher(),
    });
    expect(result).toMatchObject({
      ok: true,
      tools: [
        { name: "restic", target: "darwin-arm64", status: "installed" },
        { name: "rclone", target: "darwin-arm64", status: "installed" },
        { name: "restic", target: "linux-arm64", status: "installed" },
        { name: "rclone", target: "linux-arm64", status: "installed" },
      ],
    });
    expect(readdirSync(destRoot).sort()).toEqual(["darwin-arm64", "linux-arm64"]);
  });
});

describe("tools: the restic matrix (fetch-tools --restic)", () => {
  let dir: string;
  let destRoot: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plainport-fetch-matrix-"));
    destRoot = join(dir, "matrix", "restic-0.0.1");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("resticForMatrix finds a matrix version or the pinned one, and nothing else", () => {
    const lock = fixtureLock();
    expect(resticForMatrix(lock, "0.0.1")?.version).toBe("0.0.1");
    expect(resticForMatrix(lock, "0.0.1")?.targets["linux-x64"].url).toBe(MATRIX_URL);
    expect(resticForMatrix(lock, "0.0.0")).toBe(lock.tools.restic);
    expect(resticForMatrix(lock, "9.9.9")).toBeUndefined();
  });

  test("a matrix version is fetched alone, restic only, into its own folder", async () => {
    const lock = fixtureLock();
    const fetcher = fixtureFetcher();
    const result = await fetchTools({
      lock,
      targets: ["linux-x64"],
      destRoot,
      fetcher,
      only: { restic: resticForMatrix(lock, "0.0.1") },
    });
    expect(result).toMatchObject({
      ok: true,
      tools: [
        {
          name: "restic",
          version: "0.0.1",
          status: "installed",
          path: join(destRoot, "linux-x64", "restic"),
        },
      ],
    });
    expect(fetcher.calls).toEqual([MATRIX_URL]);
    expect(readdirSync(join(destRoot, "linux-x64")).sort()).toEqual([".restic.pin", "restic"]);
  });

  test("a checksum mismatch for a matrix version refuses and leaves no file behind", async () => {
    const lock = fixtureLock();
    const tampered = new Uint8Array(resticArchive);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const result = await fetchTools({
      lock,
      targets: ["linux-x64"],
      destRoot,
      fetcher: fixtureFetcher({ [MATRIX_URL]: tampered }),
      only: { restic: resticForMatrix(lock, "0.0.1") },
    });
    expect(result).toMatchObject({ ok: false, code: "tool.checksum_mismatch" });
    expect(result.ok ? "" : result.message).toContain(MATRIX_URL);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("the command line refuses a version the lock does not list, and fetches nothing", () => {
    const ran = Bun.spawnSync(
      ["bun", join(import.meta.dir, "fetch-tools.ts"), "--restic", "0.16.4", "--dest", dir],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(ran.exitCode).toBe(2);
    expect(ran.stderr.toString()).toContain("restic 0.16.4 is not in tools.lock.json");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("parseLock checks matrix entries as strictly as the pins, and a lock without a matrix has an empty one", () => {
    const lock = structuredClone(fixtureLock()) as unknown as {
      matrix?: { restic: { targets: Record<string, { sha256: string }> }[] };
    };
    const bad = structuredClone(lock);
    (bad.matrix?.restic[0]?.targets["linux-x64"] as { sha256: string }).sha256 = "abc";
    expect(parseLock(bad)).toMatchObject({ ok: false });
    expect(parseLock(bad).ok ? "" : (parseLock(bad) as { message: string }).message).toContain(
      "matrix.restic[0]",
    );
    const none = structuredClone(lock);
    delete none.matrix;
    expect(parseLock(none)).toMatchObject({ ok: true, lock: { matrix: { restic: [] } } });
  });
});

describe("tools: tools.lock.json", () => {
  const raw = JSON.parse(readFileSync(join(import.meta.dir, "../tools.lock.json"), "utf8")) as unknown;

  test("parses, and pins restic and rclone for all four targets over https with SHA-256 sums", () => {
    const parsed = parseLock(raw);
    if (!parsed.ok) throw new Error(parsed.message);
    for (const tool of Object.values(parsed.lock.tools)) {
      expect(tool.checksums).toStartWith("https://");
      expect(Object.keys(tool.targets).sort()).toEqual([
        "darwin-arm64",
        "darwin-x64",
        "linux-arm64",
        "linux-x64",
      ]);
      for (const entry of Object.values(tool.targets)) {
        expect(entry.url).toStartWith("https://");
        expect(entry.url).toContain(tool.version);
        expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    expect(parsed.lock.tools.rclone.format).toBe("zip");
    expect(parsed.lock.tools.restic.format).toBe("bz2");
  });

  test("restic is 0.17.1 or later (ADR-0006)", () => {
    const parsed = parseLock(raw);
    if (!parsed.ok) throw new Error(parsed.message);
    const [major = 0, minor = 0, patch = 0] = parsed.lock.tools.restic.version.split(".").map(Number);
    expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(17_001);
  });

  test("parseLock refuses a missing target, a bad sum or a plain-http url", () => {
    const lock = structuredClone(raw) as {
      tools: { restic: { targets: Record<string, { sha256: string; url: string }> } };
    };
    const base = lock.tools.restic.targets;

    const missing = structuredClone(lock);
    delete missing.tools.restic.targets["linux-arm64"];
    expect(parseLock(missing)).toMatchObject({ ok: false });

    const badSum = structuredClone(lock);
    badSum.tools.restic.targets["darwin-arm64"] = { ...base["darwin-arm64"], sha256: "abc" } as never;
    expect(parseLock(badSum)).toMatchObject({ ok: false });

    const http = structuredClone(lock);
    http.tools.restic.targets["darwin-arm64"] = {
      ...base["darwin-arm64"],
      url: "http://example.com/restic.bz2",
    } as never;
    expect(parseLock(http)).toMatchObject({ ok: false });
  });

  test("the matrix holds restic 0.17.1 and the latest 0.18, both older than the pin, for all four targets", () => {
    const parsed = parseLock(raw);
    if (!parsed.ok) throw new Error(parsed.message);
    const versions = parsed.lock.matrix.restic.map((entry) => entry.version);
    expect(versions).toEqual(["0.17.1", "0.18.1"]);
    for (const entry of parsed.lock.matrix.restic) {
      expect(entry.checksums).toBe(
        `https://github.com/restic/restic/releases/download/v${entry.version}/SHA256SUMS`,
      );
      for (const [name, value] of Object.entries(entry.targets)) {
        expect(value.url).toBe(
          `https://github.com/restic/restic/releases/download/v${entry.version}/restic_${entry.version}_${name
            .replace("x64", "amd64")
            .replace("-", "_")}.bz2`,
        );
      }
    }
  });

  test("every restic in the matrix has recorded fixtures, the same set as the pinned version's", () => {
    const parsed = parseLock(raw);
    if (!parsed.ok) throw new Error(parsed.message);
    const root = join(import.meta.dir, "../fixtures/restic");
    const names = (version: string) => readdirSync(join(root, version)).sort();
    const pinned = names(parsed.lock.tools.restic.version);
    expect(pinned.length).toBeGreaterThan(10);
    for (const entry of parsed.lock.matrix.restic)
      expect({ v: entry.version, names: names(entry.version) }).toEqual({ v: entry.version, names: pinned });
  });
});
