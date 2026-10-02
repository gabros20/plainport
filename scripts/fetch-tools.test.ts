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
import { type Fetcher, fetchTools, type Lock, parseLock } from "./fetch-tools.ts";

const fixtures = join(import.meta.dir, "../test/fixtures/tools");
const resticArchive = new Uint8Array(readFileSync(join(fixtures, "restic-fixture.bz2")));
const rcloneArchive = new Uint8Array(readFileSync(join(fixtures, "rclone-fixture.zip")));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const RESTIC_URL = "https://example.invalid/restic_0.0.0_darwin_arm64.bz2";
const RCLONE_URL = "https://example.invalid/rclone-v0.0.0-osx-arm64.zip";

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
  };
};

// A fetcher that serves the fixture archives and never touches the network.
const fixtureFetcher = (overrides: Record<string, Uint8Array> = {}): Fetcher & { calls: string[] } => {
  const calls: string[] = [];
  const serve = async (url: string): Promise<Uint8Array> => {
    calls.push(url);
    const bytes = overrides[url] ?? { [RESTIC_URL]: resticArchive, [RCLONE_URL]: rcloneArchive }[url];
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
});
