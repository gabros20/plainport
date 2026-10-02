import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { type PlainportPaths, resolvePaths } from "../paths.ts";
import { ConfigLoader } from "./load.ts";
import { updateManaged } from "./managed.ts";
import { childEnv } from "./testing/child-env.ts";

const WRITER = join(import.meta.dir, "testing", "managed-writer.ts");

let sandbox: string;
let paths: PlainportPaths;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "plainport-managed-"));
  const result = resolvePaths({ HOME: sandbox });
  if (!result.ok) throw new Error(result.finding.message);
  paths = result.value;
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const writer = (args: string[], env: Record<string, string> = {}) =>
  Bun.spawn([process.execPath, WRITER, ...args], {
    env: childEnv(sandbox, env),
    stdout: "pipe",
    stderr: "pipe",
  });

/** The pid of a process that has exited, so nothing holds it. */
const deadPid = async (): Promise<number> => {
  const child = Bun.spawn([process.execPath, "-e", "0"]);
  await child.exited;
  return child.pid;
};

const rootsIn = (path: string): string[] =>
  Object.keys((parse(readFileSync(path, "utf8")).roots ?? {}) as object).sort();

describe("config: managed.toml writes", () => {
  test("creates managed.toml, with a header, that loads back", async () => {
    const result = await updateManaged(paths, (managed) => ({
      ...managed,
      defaultStore: "mini",
      roots: { work: { label: "Work", on: { mbp: "~/work" } } },
    }));
    if (!result.ok) throw new Error(result.finding.message);
    const text = readFileSync(paths.managedFile, "utf8");
    expect(text.startsWith("# Written by plainport.")).toBe(true);
    const loaded = new ConfigLoader(paths).load({ env: {} });
    if (!loaded.ok) throw new Error(loaded.finding.message);
    expect(loaded.value.config.defaultStore).toBe("mini");
    expect(loaded.value.config.roots.work).toEqual({ label: "Work", on: { mbp: "~/work" } });
    expect(existsSync(paths.managedLock)).toBe(false);
  });

  test("an update that would make managed.toml invalid is refused and the file is left alone", async () => {
    write(paths.managedFile, 'defaultStore = "mini"\n');
    const before = readFileSync(paths.managedFile, "utf8");
    const result = await updateManaged(paths, (managed) => ({
      ...managed,
      onload: { leases: "sometimes" as "warn" },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.finding.code).toBe("config.invalid");
    expect(readFileSync(paths.managedFile, "utf8")).toBe(before);
    expect(existsSync(paths.managedLock)).toBe(false);
  });

  test("a managed.toml that does not parse is never overwritten", async () => {
    write(paths.managedFile, "[roots\n");
    const result = await updateManaged(paths, (managed) => ({ ...managed, defaultStore: "x" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.finding.code).toBe("config.invalid");
    expect(result.finding.paths).toEqual([paths.managedFile]);
    expect(readFileSync(paths.managedFile, "utf8")).toBe("[roots\n");
  });

  test("a lock held by a live process times out with config.locked (exit 11) naming the holder", async () => {
    write(
      paths.managedLock,
      JSON.stringify({ pid: process.pid, host: hostname(), startedAt: "2026-10-03T00:00:00Z" }),
    );
    const result = await updateManaged(paths, (managed) => ({ ...managed, defaultStore: "x" }), {
      timeoutMs: 150,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.finding.code).toBe("config.locked");
    expect(result.exitCode).toBe(11);
    expect(result.finding.message).toContain(String(process.pid));
    expect(result.finding.paths).toEqual([paths.managedLock]);
    expect(existsSync(paths.managedFile)).toBe(false);
    expect(existsSync(paths.managedLock)).toBe(true);
  });

  test("a lock held on another host is never broken", async () => {
    write(
      paths.managedLock,
      JSON.stringify({ pid: 1, host: "some-other-host", startedAt: "2026-10-03T00:00:00Z" }),
    );
    const result = await updateManaged(paths, (managed) => managed, { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.finding.code).toBe("config.locked");
  });

  test("a lock left by a dead process on this host is broken", async () => {
    write(
      paths.managedLock,
      JSON.stringify({ pid: await deadPid(), host: hostname(), startedAt: "2026-10-03T00:00:00Z" }),
    );
    const result = await updateManaged(paths, (managed) => ({ ...managed, defaultStore: "after" }), {
      timeoutMs: 1000,
    });
    if (!result.ok) throw new Error(result.finding.message);
    expect(parse(readFileSync(paths.managedFile, "utf8")).defaultStore).toBe("after");
    expect(existsSync(paths.managedLock)).toBe(false);
  });

  test("an exception in the update releases the lock", async () => {
    await expect(
      updateManaged(paths, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(paths.managedLock)).toBe(false);
  });

  test("concurrent writers in two processes serialize through the lock: no lost update, no overlap", async () => {
    const log = join(sandbox, "critical.log");
    const count = 15;
    const env = { MANAGED_WRITER_LOG: log, MANAGED_WRITER_START: String(Date.now() + 750) };
    const children = [writer(["a", String(count)], env), writer(["b", String(count)], env)];
    const codes = await Promise.all(children.map((child) => child.exited));
    const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()));
    expect({ codes, errors }).toEqual({ codes: [0, 0], errors: ["", ""] });

    const expected = ["a", "b"]
      .flatMap((name) => Array.from({ length: count }, (_, i) => `${name}-${i}`))
      .sort();
    expect(rootsIn(paths.managedFile)).toEqual(expected);

    const lines = readFileSync(log, "utf8").trim().split("\n");
    // Both writers were running at once: each started before either finished.
    const firstDone = lines.findIndex((line) => line.startsWith("done "));
    expect(
      lines
        .slice(0, firstDone)
        .filter((line) => line.startsWith("start "))
        .sort(),
    ).toEqual(["start a", "start b"]);
    // Inside the lock, every entry is followed by its own exit: never two writers at once.
    const critical = lines.filter((line) => line.startsWith("+") || line.startsWith("-"));
    expect(critical).toHaveLength(4 * count);
    for (let i = 0; i < critical.length; i += 2) {
      const enter = critical[i] as string;
      expect(enter.startsWith("+")).toBe(true);
      expect(critical[i + 1]).toBe(`-${enter.slice(1)}`);
    }
    expect(existsSync(paths.managedLock)).toBe(false);
  }, 60_000);

  test("a crash between the temp write and the rename leaves the old file intact; the next write recovers", async () => {
    write(paths.managedFile, '# old\ndefaultStore = "old"\n');
    const child = writer(["crashed", "1", "crash-before-rename"]);
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");

    expect(readFileSync(paths.managedFile, "utf8")).toBe('# old\ndefaultStore = "old"\n');
    const temps = readdirSync(paths.configDir).filter((name) => name.endsWith(".tmp"));
    expect(temps).toHaveLength(1);
    expect(readFileSync(join(paths.configDir, temps[0] as string), "utf8")).toContain("crashed-0");
    expect(existsSync(paths.managedLock)).toBe(true);

    const loaded = new ConfigLoader(paths).load({ env: {} });
    if (!loaded.ok) throw new Error(loaded.finding.message);
    expect(loaded.value.config.defaultStore).toBe("old");

    const next = await updateManaged(paths, (managed) => ({ ...managed, defaultStore: "new" }), {
      timeoutMs: 2000,
    });
    if (!next.ok) throw new Error(next.finding.message);
    expect(parse(readFileSync(paths.managedFile, "utf8")).defaultStore).toBe("new");
    expect(rootsIn(paths.managedFile)).toEqual([]);
    expect(readdirSync(paths.configDir).sort()).toEqual(["managed.toml"]);
  }, 30_000);
});
