import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FindingSchema, ok } from "@plainport/contract";
import { nodeLocalIo } from "../node-io.ts";
import { type PlainportPaths, resolvePaths } from "../paths.ts";
import { ConfigLoader, DEFAULTS } from "./index.ts";
import { updateManaged } from "./managed.ts";

const io = nodeLocalIo;

let sandbox: string;
let paths: PlainportPaths;
let project: string;

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const pathsFor = (env: Record<string, string>, configFlag?: string): PlainportPaths => {
  const result = resolvePaths({ HOME: sandbox, ...env }, { cwd: sandbox, configFlag });
  if (!result.ok) throw new Error(result.finding.message);
  return result.value;
};

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "plainport-config-"));
  paths = pathsFor({});
  project = join(sandbox, "work", "web");
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const loaded = async (loader: ConfigLoader, options: Parameters<ConfigLoader["load"]>[0] = { env: {} }) => {
  const result = await loader.load(options);
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

describe("config: precedence", () => {
  test("with no files at all, the built-in defaults apply", async () => {
    const { config, findings } = await loaded(new ConfigLoader(io, paths));
    expect(config).toEqual(DEFAULTS);
    expect(findings).toEqual([]);
    expect(config.onload).toEqual({ hydrate: true, leases: "warn" });
    expect(config.offload.verify).toBe("manifest");
  });

  // Each row removes the highest layer of the row above: the value seen is always the highest layer present.
  test("defaultStore: flags > env > config.toml > managed.toml > defaults", async () => {
    write(paths.managedFile, 'defaultStore = "from-managed"\n');
    write(paths.configFile, 'defaultStore = "from-config"\n');
    const env = { PLAINPORT_STORE: "from-env" };
    const flags = { defaultStore: "from-flag" };
    const rows: [Parameters<ConfigLoader["load"]>[0], string | undefined][] = [
      [{ env, flags, projectDir: project }, "from-flag"],
      [{ env, projectDir: project }, "from-env"],
      [{ env: {}, projectDir: project }, "from-config"],
    ];
    for (const [options, expected] of rows) {
      expect((await loaded(new ConfigLoader(io, paths), options)).config.defaultStore).toBe(expected);
    }
    rmSync(paths.configFile);
    expect((await loaded(new ConfigLoader(io, paths))).config.defaultStore).toBe("from-managed");
    rmSync(paths.managedFile);
    expect((await loaded(new ConfigLoader(io, paths))).config.defaultStore).toBeUndefined();
  });

  test("deps.mode: flags > project .plainport.toml > config.toml > managed.toml > defaults", async () => {
    write(paths.managedFile, '[deps]\nmode = "keep"\n');
    write(paths.configFile, '[deps]\nmode = "strip"\n');
    write(join(project, ".plainport.toml"), '[deps]\nmode = "keep"\n');
    const load = async (options: Parameters<ConfigLoader["load"]>[0]) =>
      (await loaded(new ConfigLoader(io, paths), options)).config.deps.mode;
    expect(await load({ env: {}, projectDir: project, flags: { deps: { mode: "strip" } } })).toBe("strip");
    expect(await load({ env: {}, projectDir: project })).toBe("keep");
    expect(await load({ env: {} })).toBe("strip");
    rmSync(paths.configFile);
    expect(await load({ env: {} })).toBe("keep");
    rmSync(paths.managedFile);
    expect(await load({ env: {} })).toBe(DEFAULTS.deps.mode);
  });

  test("a root defined in both files: config.toml wins key by key, managed.toml fills the rest", async () => {
    write(
      paths.managedFile,
      '[roots.work]\nlabel = "Work (managed)"\nstore = "mini-work"\non = { mbp = "~/work" }\n',
    );
    write(paths.configFile, '[roots.work]\nlabel = "Work"\non = { mini = "~/Developer/Work" }\n');
    const { config } = await loaded(new ConfigLoader(io, paths));
    expect(config.roots.work).toEqual({
      label: "Work",
      store: "mini-work",
      on: { mbp: "~/work", mini: "~/Developer/Work" },
    });
  });

  test("arrays replace across layers: the project's strip.extra replaces the global one", async () => {
    write(
      paths.configFile,
      '[strip]\nextra = ["**/coverage", "**/.cache"]\nnever = [".vercel/project.json"]\n',
    );
    write(join(project, ".plainport.toml"), '[strip]\nextra = ["public/generated/**"]\n');
    const { config } = await loaded(new ConfigLoader(io, paths), { env: {}, projectDir: project });
    expect(config.strip.extra).toEqual(["public/generated/**"]);
    expect(config.strip.never).toEqual([".vercel/project.json"]);
  });

  test("a store split across the two files merges first, then is checked as a whole", async () => {
    write(paths.managedFile, '[stores.ssd]\nkind = "local"\npath = "/Volumes/A/plainport"\n');
    write(paths.configFile, '[stores.ssd]\npath = "/Volumes/B/plainport"\n');
    const { config } = await loaded(new ConfigLoader(io, paths));
    expect(config.stores.ssd).toEqual({ kind: "local", path: "/Volumes/B/plainport" });
  });

  test("the DESIGN.md examples load as written", async () => {
    write(
      paths.configFile,
      [
        "version = 1",
        'defaultStore = "mini"',
        "[roots.work]",
        'label   = "Work"',
        'store   = "mini-work"',
        'devices = ["mbp", "mini", "vps"]',
        'secrets = "envelope"',
        'on      = { mbp = "~/work", mini = "~/Developer/Work", vps = "/srv/work" }',
        "[roots.personal]",
        'on      = { mbp = "~/personal" }',
        'scan    = { depth = 3, ignore = ["archive/**"] }',
        "[stores.nas]",
        'kind   = "sftp"',
        'host   = "nas.local"',
        'path   = "/volume1/plainport"',
        'secret = "keychain:plainport/nas"',
        "[stores.b2]",
        'kind     = "s3"',
        'endpoint = "https://s3.eu-central-003.backblazeb2.com"',
        'bucket   = "tamas-plainport"',
        'secret   = "keychain:plainport/b2"',
        'access   = "read-only"',
        "[stores.mini]",
        'kind        = "peer"',
        'device      = "mini"',
        'path        = "~/plainport/repo"',
        'access      = "append-only"',
        'replicateTo = ["b2"]',
        "[offload]",
        'verify        = "manifest"',
        'keepLocalFor  = "0"',
        "requirePushed = false",
        "stub          = true",
        "[onload]",
        "hydrate = true",
        'leases  = "warn"',
        "[deps]",
        'mode = "strip"',
        "[retention]",
        "keepLast = 5",
        "[strip]",
        'extra = ["**/coverage", "**/.cache"]',
        'never = [".vercel/project.json"]',
        "[devices.mini]",
        'role = "owner"',
        'ssh  = "tamas@mini"',
        "[devices.vps]",
        'role = "worker"',
        'ssh  = "tamas@vps.example.eu"',
        "[secrets]",
        'mode     = "envelope"',
        'patterns = [".env", ".env.*", "!.env.example", "*.pem", "*.key"]',
        "grant    = { owner = true, worker = false }",
        'recovery = "op://Private/plainport-recovery/age-identity"',
        "[deletion]",
        'delay = "7d"',
        'pruneKey = "op://Private/plainport-prune/b2-key"',
        "",
      ].join("\n"),
    );
    write(
      join(project, ".plainport.toml"),
      [
        "[strip]",
        'extra = ["public/generated/**"]',
        'keep  = ["dist/"]',
        "[deps]",
        'mode = "keep"',
        "[hydrate]",
        'command = "pnpm install --frozen-lockfile && pnpm prisma generate"',
        "[hooks]",
        'pre-offload = ["docker compose down"]',
        'post-onload = ["docker compose up -d db"]',
        "",
      ].join("\n"),
    );
    const { config } = await loaded(new ConfigLoader(io, paths), { env: {}, projectDir: project });
    expect(config.stores.mini).toMatchObject({ kind: "peer", access: "append-only", replicateTo: ["b2"] });
    expect(config.hooks?.["pre-offload"]).toEqual(["docker compose down"]);
    expect(config.deps.mode).toBe("keep");
    expect(config.strip.keep).toEqual(["dist/"]);
  });

  test("a project file may only hold project settings", async () => {
    write(join(project, ".plainport.toml"), 'defaultStore = "sneaky"\n');
    const result = await new ConfigLoader(io, paths).load({ env: {}, projectDir: project });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.finding.code).toBe("config.invalid");
    expect(result.finding.paths).toEqual([join(project, ".plainport.toml")]);
  });

  test("secrets are references: a bare value is refused", async () => {
    write(
      paths.configFile,
      '[stores.b2]\nkind = "s3"\nendpoint = "https://e"\nbucket = "b"\nsecret = "hunter2"\n',
    );
    const result = await new ConfigLoader(io, paths).load({ env: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.finding.code).toBe("config.invalid");
  });

  test("--config or PLAINPORT_CONFIG naming a missing file is not found (exit 4); a missing default is fine", async () => {
    const result = await new ConfigLoader(
      io,
      pathsFor({ PLAINPORT_CONFIG: join(sandbox, "nope.toml") }),
    ).load({
      env: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.finding.code).toBe("config.not-found");
    expect(result.exitCode).toBe(4);
    expect(result.finding.paths).toEqual([join(sandbox, "nope.toml")]);
  });

  test("--config points the user layer at another file", async () => {
    const other = join(sandbox, "dotfiles", "plainport.toml");
    write(other, 'defaultStore = "dotfiles"\n');
    write(paths.configFile, 'defaultStore = "default-location"\n');
    expect((await loaded(new ConfigLoader(io, pathsFor({}, other)))).config.defaultStore).toBe("dotfiles");
  });

  test("with --config, managed.toml is read and written beside that file (D20)", async () => {
    const other = join(sandbox, "dotfiles", "plainport.toml");
    write(other, 'defaultStore = "dotfiles"\n');
    write(paths.managedFile, '[roots.default-location]\nlabel = "not this one"\n');
    const moved = pathsFor({}, other);
    const result = await updateManaged(io, moved, (managed) =>
      ok({ ...managed, roots: { work: { label: "Work" } } }),
    );
    if (!result.ok) throw new Error(result.finding.message);
    expect(readFileSync(join(sandbox, "dotfiles", "managed.toml"), "utf8")).toContain("[roots.work]");
    expect((await loaded(new ConfigLoader(io, moved))).config.roots).toEqual({ work: { label: "Work" } });
  });
});

describe("config: last good configuration", () => {
  test("a broken config.toml keeps the last good configuration and reports it", async () => {
    write(paths.configFile, 'defaultStore = "good"\n');
    const loader = new ConfigLoader(io, paths);
    expect((await loaded(loader)).config.defaultStore).toBe("good");

    write(paths.configFile, 'defaultStore = "half\n');
    const kept = await loaded(loader);
    expect(kept.config.defaultStore).toBe("good");
    expect(kept.findings).toHaveLength(1);
    const [finding] = kept.findings;
    expect(FindingSchema.parse(finding)).toEqual(finding as never);
    expect(finding?.code).toBe("config.kept-last-good");
    expect(finding?.severity).toBe("warn");
    expect(finding?.paths).toEqual([paths.configFile]);
    expect(finding?.message).toContain("line 1");
    expect(finding?.fix).toContain(paths.configFile);

    write(paths.configFile, 'defaultStore = "fixed"\n');
    const fixed = await loaded(loader);
    expect(fixed.config.defaultStore).toBe("fixed");
    expect(fixed.findings).toEqual([]);
  });

  test("a config.toml that parses but fails the schema also keeps the last good one", async () => {
    write(paths.configFile, '[onload]\nleases = "strict"\n');
    const loader = new ConfigLoader(io, paths);
    expect((await loaded(loader)).config.onload.leases).toBe("strict");
    write(paths.configFile, '[onload]\nleases = "sometimes"\n');
    const kept = await loaded(loader);
    expect(kept.config.onload.leases).toBe("strict");
    expect(kept.findings.map((f) => f.code)).toEqual(["config.kept-last-good"]);
    expect(kept.findings[0]?.message).toContain("onload.leases");
  });

  test("with no last good configuration, a broken file is a blocking finding (exit 6)", async () => {
    write(paths.configFile, "[onload\n");
    const result = await new ConfigLoader(io, paths).load({ env: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.finding.code).toBe("config.invalid");
    expect(result.exitCode).toBe(6);
    expect(result.finding.paths).toEqual([paths.configFile]);
    expect(result.finding.message).toContain("line 1");
  });

  test("an unknown key is an error, not ignored", async () => {
    write(paths.configFile, "[onload]\nhydrat = false\n");
    const result = await new ConfigLoader(io, paths).load({ env: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.finding.message).toContain("hydrat");
  });

  test("a broken managed.toml keeps its last good copy too", async () => {
    write(paths.managedFile, 'defaultStore = "managed"\n');
    const loader = new ConfigLoader(io, paths);
    expect((await loaded(loader)).config.defaultStore).toBe("managed");
    write(paths.managedFile, "defaultStore = \n");
    const kept = await loaded(loader);
    expect(kept.config.defaultStore).toBe("managed");
    expect(kept.findings[0]?.paths).toEqual([paths.managedFile]);
  });
});

describe("config: config.toml is never rewritten", () => {
  test("loading and managed writes leave config.toml byte for byte, inode and mtime unchanged", async () => {
    const text =
      '# my comments stay\ndefaultStore = "mini"   # aligned\n\n[roots.work]\non = { mbp = "~/work" }\n';
    write(paths.configFile, text);
    const before = statSync(paths.configFile);
    const loader = new ConfigLoader(io, paths);
    await loaded(loader);
    for (const name of ["a", "b", "c"]) {
      const result = await updateManaged(io, paths, (managed) =>
        ok({ ...managed, roots: { ...managed.roots, [name]: { label: name } } }),
      );
      if (!result.ok) throw new Error(result.finding.message);
    }
    expect((await loaded(loader)).config.roots.work).toEqual({ on: { mbp: "~/work" } });
    const after = statSync(paths.configFile);
    expect(readFileSync(paths.configFile, "utf8")).toBe(text);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("a managed write refuses when --config points at managed.toml", async () => {
    write(paths.configFile, 'defaultStore = "mine"\n');
    const aliased = pathsFor({}, paths.managedFile);
    write(aliased.managedFile, 'defaultStore = "mine"\n');
    const before = readFileSync(aliased.managedFile, "utf8");
    const result = await updateManaged(io, aliased, (managed) => ok({ ...managed, defaultStore: "theirs" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.finding.code).toBe("config.read-only");
    expect(readFileSync(aliased.managedFile, "utf8")).toBe(before);
  });
});
