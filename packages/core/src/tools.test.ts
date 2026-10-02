import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeT1 } from "../../../test/tiers.ts";
import { checkoutToolsDir, hostTarget, type ToolPathContext, toolPath } from "./tools.ts";

const repo = resolve(import.meta.dir, "../../..");

describe("tools: hostTarget", () => {
  test("maps the four release platforms and nothing else", () => {
    expect(hostTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(hostTarget("darwin", "x64")).toBe("darwin-x64");
    expect(hostTarget("linux", "x64")).toBe("linux-x64");
    expect(hostTarget("linux", "arm64")).toBe("linux-arm64");
    expect(hostTarget("win32", "x64")).toBeUndefined();
    expect(hostTarget("linux", "ia32")).toBeUndefined();
  });
});

describe("tools: toolPath resolver order", () => {
  let dir: string;
  let envDir: string;
  let binDir: string;
  let devDir: string;

  const place = (folder: string, name: string, mode = 0o755): string => {
    mkdirSync(folder, { recursive: true });
    const path = join(folder, name);
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, mode);
    return path;
  };
  const context = (overrides: ToolPathContext = {}): ToolPathContext => ({
    env: { PLAINPORT_TOOLS_DIR: envDir },
    execPath: join(binDir, "plainport"),
    devToolsDir: devDir,
    target: "darwin-arm64",
    ...overrides,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plainport-tools-"));
    envDir = join(dir, "env");
    binDir = join(dir, "bin");
    devDir = join(dir, ".tools");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("$PLAINPORT_TOOLS_DIR wins over the binary's folder and .tools/", () => {
    const expected = place(envDir, "restic");
    place(binDir, "restic");
    place(join(devDir, "darwin-arm64"), "restic");
    expect(toolPath("restic", context())).toEqual({ ok: true, path: expected, source: "env" });
  });

  test("the binary's own folder comes next", () => {
    mkdirSync(envDir);
    const expected = place(binDir, "rclone");
    place(join(devDir, "darwin-arm64"), "rclone");
    expect(toolPath("rclone", context())).toEqual({ ok: true, path: expected, source: "beside-binary" });
  });

  test(".tools/<os>-<arch>/ comes last", () => {
    const expected = place(join(devDir, "darwin-arm64"), "restic");
    place(join(devDir, "linux-x64"), "restic");
    expect(toolPath("restic", context())).toEqual({ ok: true, path: expected, source: "dev-tools" });
    expect(toolPath("restic", context({ env: {} }))).toEqual({
      ok: true,
      path: expected,
      source: "dev-tools",
    });
  });

  test("a file that is not executable doesn't count", () => {
    place(envDir, "restic", 0o644);
    const expected = place(binDir, "restic");
    expect(toolPath("restic", context())).toEqual({ ok: true, path: expected, source: "beside-binary" });
  });

  test("nothing found is a tool.missing value that lists every folder searched, in order", () => {
    const result = toolPath("restic", context());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("tool.missing");
    expect(result.exitCode).toBe(6);
    expect(result.searched).toEqual([
      join(envDir, "restic"),
      join(binDir, "restic"),
      join(devDir, "darwin-arm64", "restic"),
    ]);
    expect(result.message).toContain("restic");
    expect(result.fix).toContain("bun scripts/fetch-tools.ts");
  });

  test("an empty $PLAINPORT_TOOLS_DIR, no binary folder and an unknown host target are skipped", () => {
    const result = toolPath("rclone", {
      env: { PLAINPORT_TOOLS_DIR: "" },
      execPath: undefined,
      devToolsDir: devDir,
      target: undefined,
    });
    expect(result).toMatchObject({ ok: false, code: "tool.missing", searched: [] });
  });

  test("running from source, the defaults look only in the checkout's .tools/ for the host", () => {
    const seen: string[] = [];
    const result = toolPath("restic", {
      env: {},
      isExecutable: (path) => {
        seen.push(path);
        return false;
      },
    });
    expect(result.ok).toBe(false);
    expect(seen).toEqual([join(repo, ".tools", `${hostTarget()}`, "restic")]);
  });
});

describe("tools: a compiled binary finds the checkout's .tools/", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("checkoutToolsDir walks up to the folder holding tools.lock.json", () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-checkout-")));
    mkdirSync(join(dir, "repo", "dist", "nested"), { recursive: true });
    mkdirSync(join(dir, "elsewhere"));
    writeFileSync(join(dir, "repo", "tools.lock.json"), "{}");
    expect(checkoutToolsDir(join(dir, "repo", "dist", "nested"))).toBe(join(dir, "repo", ".tools"));
    expect(checkoutToolsDir(join(dir, "repo"))).toBe(join(dir, "repo", ".tools"));
    expect(checkoutToolsDir(join(dir, "elsewhere"))).toBeUndefined();
  });

  test("a build in dist/ uses .tools/<target>/, after a tool beside the binary", () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-compiled-")));
    const target = hostTarget();
    if (target === undefined) throw new Error(`no release target for ${process.platform}-${process.arch}`);
    const checkout = join(dir, "repo");
    mkdirSync(join(checkout, "dist"), { recursive: true });
    mkdirSync(join(checkout, ".tools", target), { recursive: true });
    writeFileSync(join(checkout, "tools.lock.json"), "{}");
    const devTool = join(checkout, ".tools", target, "restic");
    writeFileSync(devTool, "#!/bin/sh\n");
    chmodSync(devTool, 0o755);

    const entry = join(dir, "probe.ts");
    writeFileSync(
      entry,
      `import { toolPath } from ${JSON.stringify(join(import.meta.dir, "tools.ts"))};\n` +
        `console.log(JSON.stringify(toolPath("restic", { env: {} })));\n`,
    );
    const binary = join(checkout, "dist", "plainport");
    const build = Bun.spawnSync([process.execPath, "build", "--compile", entry, "--outfile", binary], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr.toString()}`);
    const probe = () => JSON.parse(Bun.spawnSync([binary], { cwd: dir }).stdout.toString()) as unknown;

    expect(probe()).toEqual({ ok: true, path: devTool, source: "dev-tools" });

    const beside = join(checkout, "dist", "restic");
    writeFileSync(beside, "#!/bin/sh\n");
    chmodSync(beside, 0o755);
    expect(probe()).toEqual({ ok: true, path: beside, source: "beside-binary" });
  }, 120_000);
});

// Runs the binaries `bun scripts/fetch-tools.ts` put in .tools/ and checks they are the versions tools.lock.json pins.
describeT1("tools: pinned binaries run from .tools/", () => {
  const lock = JSON.parse(readFileSync(join(repo, "tools.lock.json"), "utf8")) as {
    tools: Record<"restic" | "rclone", { version: string }>;
  };
  const run = (name: "restic" | "rclone"): string => {
    const found = toolPath(name, { env: {} });
    if (!found.ok) throw new Error(`${found.message} ${found.fix}`);
    expect(found.source).toBe("dev-tools");
    expect(found.path).toBe(join(repo, ".tools", `${hostTarget()}`, name));
    const child = Bun.spawnSync([found.path, "version"], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    return child.stdout.toString();
  };

  test("restic version reports the pinned version", () => {
    expect(run("restic")).toStartWith(`restic ${lock.tools.restic.version} `);
  });

  test("rclone version reports the pinned version", () => {
    expect(run("rclone")).toStartWith(`rclone v${lock.tools.rclone.version}\n`);
  });
});
