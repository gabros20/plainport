import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
    env: {},
    execPath: join(binDir, "plainport"),
    devToolsDir: devDir,
    target: "darwin-arm64",
    ...overrides,
  });
  // Records the paths toolPath asks about without touching the file system.
  const spy = (): { seen: string[]; isExecutable: (path: string) => boolean } => {
    const seen: string[] = [];
    return {
      seen,
      isExecutable: (path) => {
        seen.push(path);
        return false;
      },
    };
  };

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
    expect(toolPath("restic", context({ env: { PLAINPORT_TOOLS_DIR: envDir } }))).toEqual({
      ok: true,
      path: expected,
      source: "env",
    });
  });

  test("a set $PLAINPORT_TOOLS_DIR without the tool is tool.missing, never a fall-through", () => {
    place(envDir, "rclone");
    place(binDir, "restic");
    place(join(devDir, "darwin-arm64"), "restic");
    const result = toolPath("restic", context({ env: { PLAINPORT_TOOLS_DIR: envDir } }));
    expect(result).toMatchObject({ ok: false, code: "tool.missing", searched: [join(envDir, "restic")] });
    if (result.ok) return;
    expect(result.fix).toContain(envDir);
    expect(result.fix).toContain("unset PLAINPORT_TOOLS_DIR");
  });

  test("the binary's own folder comes next", () => {
    const expected = place(binDir, "rclone");
    place(join(devDir, "darwin-arm64"), "rclone");
    expect(toolPath("rclone", context())).toEqual({ ok: true, path: expected, source: "beside-binary" });
  });

  test(".tools/<os>-<arch>/ comes last", () => {
    const expected = place(join(devDir, "darwin-arm64"), "restic");
    place(join(devDir, "linux-x64"), "restic");
    expect(toolPath("restic", context())).toEqual({ ok: true, path: expected, source: "dev-tools" });
  });

  test("a file that is not executable doesn't count", () => {
    place(binDir, "restic", 0o644);
    const expected = place(join(devDir, "darwin-arm64"), "restic");
    expect(toolPath("restic", context())).toEqual({ ok: true, path: expected, source: "dev-tools" });
  });

  test("nothing found is a tool.missing value that lists every folder searched, in order", () => {
    const result = toolPath("restic", context());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("tool.missing");
    expect(result.exitCode).toBe(6);
    expect(result.searched).toEqual([join(binDir, "restic"), join(devDir, "darwin-arm64", "restic")]);
    expect(result.message).toContain("restic");
    expect(result.fix).toContain("bun scripts/fetch-tools.ts");
    expect(result.fix).not.toContain("PLAINPORT_TOOLS_DIR");
  });

  test("null means none: an empty $PLAINPORT_TOOLS_DIR, a null binary, .tools/ and target are skipped", () => {
    const probe = spy();
    const none = { env: { PLAINPORT_TOOLS_DIR: "" }, execPath: null, devToolsDir: null, target: null };
    expect(toolPath("rclone", { ...none, isExecutable: probe.isExecutable })).toMatchObject({
      ok: false,
      code: "tool.missing",
      searched: [],
    });
    expect(toolPath("rclone", { ...none, devToolsDir: devDir })).toMatchObject({ ok: false, searched: [] });
    expect(probe.seen).toEqual([]);
  });

  test("undefined means the default, exactly like leaving the key out", () => {
    const omitted = spy();
    toolPath("restic", { env: {}, isExecutable: omitted.isExecutable });
    const explicit = spy();
    toolPath("restic", {
      env: {},
      execPath: undefined,
      devToolsDir: undefined,
      target: undefined,
      isExecutable: explicit.isExecutable,
    });
    expect(explicit.seen).toEqual(omitted.seen);
  });

  test("running from source, the defaults look only in the checkout's .tools/ for the host", () => {
    const probe = spy();
    expect(toolPath("restic", { env: {}, isExecutable: probe.isExecutable }).ok).toBe(false);
    expect(probe.seen).toEqual([join(repo, ".tools", `${hostTarget()}`, "restic")]);
  });

  test("a release build with execPath undefined still looks beside the running binary", () => {
    const probe = spy();
    toolPath("restic", { env: {}, build: "release", execPath: undefined, isExecutable: probe.isExecutable });
    expect(probe.seen).toEqual([join(dirname(process.execPath), "restic")]);
  });

  test("a dev build walks up to the checkout's .tools/; a release build never does", () => {
    const checkout = join(dir, "repo");
    place(checkout, "tools.lock.json", 0o644);
    const devTool = place(join(checkout, ".tools", "darwin-arm64"), "restic");
    const execPath = join(checkout, "dist", "plainport");
    const base = { env: {}, execPath, target: "darwin-arm64" } as const;

    expect(toolPath("restic", { ...base, build: "dev" })).toEqual({
      ok: true,
      path: devTool,
      source: "dev-tools",
    });

    const release = toolPath("restic", { ...base, build: "release" });
    expect(release).toMatchObject({
      ok: false,
      code: "tool.missing",
      searched: [join(checkout, "dist", "restic")],
    });
    if (release.ok) return;
    expect(release.fix).toContain("reinstall plainport");
    expect(release.fix).not.toContain("fetch-tools");
    expect(release.fix).not.toContain("PLAINPORT_TOOLS_DIR");
  });
});

describe("tools: checkoutToolsDir", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("walks up to the folder holding tools.lock.json", () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-checkout-")));
    mkdirSync(join(dir, "repo", "dist", "nested"), { recursive: true });
    mkdirSync(join(dir, "elsewhere"));
    writeFileSync(join(dir, "repo", "tools.lock.json"), "{}");
    expect(checkoutToolsDir(join(dir, "repo", "dist", "nested"))).toBe(join(dir, "repo", ".tools"));
    expect(checkoutToolsDir(join(dir, "repo"))).toBe(join(dir, "repo", ".tools"));
    expect(checkoutToolsDir(join(dir, "elsewhere"))).toBeUndefined();
  });
});

// Compiles a probe that prints toolPath("restic", { env: {} }) against a copy of this module whose baked-in
// VERSION is `version`, so the build-kind detection runs exactly as it does in a shipped binary.
describe("tools: compiled builds", () => {
  let dir: string;
  const target = hostTarget();
  const builds: Record<"dev" | "release", string> = { dev: "", release: "" };

  const compile = (version: string, outfile: string): void => {
    const tree = join(dir, `src-${version}`);
    mkdirSync(join(tree, "packages", "core", "src"), { recursive: true });
    writeFileSync(join(tree, "VERSION"), `${version}\n`);
    for (const file of ["tools.ts", "version.ts"]) {
      copyFileSync(join(import.meta.dir, file), join(tree, "packages", "core", "src", file));
    }
    const entry = join(tree, "probe.ts");
    writeFileSync(
      entry,
      'import { toolPath } from "./packages/core/src/tools.ts";\n' +
        'console.log(JSON.stringify(toolPath("restic", { env: {} })));\n',
    );
    const build = Bun.spawnSync([process.execPath, "build", "--compile", entry, "--outfile", outfile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr.toString()}`);
  };
  const install = (build: string, path: string): string => {
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(build, path);
    chmodSync(path, 0o755);
    return path;
  };
  const tool = (path: string): string => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
    return path;
  };
  const probe = (binary: string): unknown => {
    const run = Bun.spawnSync([binary], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (run.exitCode !== 0) throw new Error(`probe exited ${run.exitCode}: ${run.stderr.toString()}`);
    return JSON.parse(run.stdout.toString());
  };

  beforeAll(() => {
    if (target === undefined) throw new Error(`no release target for ${process.platform}-${process.arch}`);
    dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-compiled-")));
    builds.dev = join(dir, "build", "dev");
    builds.release = join(dir, "build", "release");
    compile("9.9.9-dev", builds.dev);
    compile("9.9.9", builds.release);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a dev build in dist/ uses the checkout's .tools/<target>/, after a tool beside the binary", () => {
    const checkout = join(dir, "dev-checkout");
    tool(join(checkout, "tools.lock.json"));
    const devTool = tool(join(checkout, ".tools", `${target}`, "restic"));
    const binary = install(builds.dev, join(checkout, "dist", "plainport"));

    expect(probe(binary)).toEqual({ ok: true, path: devTool, source: "dev-tools" });
    const beside = tool(join(checkout, "dist", "restic"));
    expect(probe(binary)).toEqual({ ok: true, path: beside, source: "beside-binary" });
  });

  test("a release build never uses a parent folder's .tools/ and tells you to reinstall", () => {
    const checkout = join(dir, "release-checkout");
    tool(join(checkout, "tools.lock.json"));
    tool(join(checkout, ".tools", `${target}`, "restic"));
    const binary = install(builds.release, join(checkout, "dist", "plainport"));

    expect(probe(binary)).toMatchObject({
      ok: false,
      code: "tool.missing",
      exitCode: 6,
      searched: [join(checkout, "dist", "restic")],
      fix: expect.stringContaining("reinstall plainport"),
    });
  });

  test("launched through symlinks (ADR-0020 layout), a release build finds the tools beside the real binary", () => {
    const versionDir = join(dir, "share", "versions", "9.9.9");
    install(builds.release, join(versionDir, "plainport"));
    const restic = tool(join(versionDir, "restic"));
    symlinkSync(join("versions", "9.9.9"), join(dir, "share", "current"));
    mkdirSync(join(dir, "bin"));
    symlinkSync(join(dir, "share", "current", "plainport"), join(dir, "bin", "plainport"));

    expect(probe(join(dir, "bin", "plainport"))).toEqual({ ok: true, path: restic, source: "beside-binary" });
  });
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
