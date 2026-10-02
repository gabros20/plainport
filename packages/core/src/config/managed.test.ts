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
import { fail, finding, ok } from "@plainport/contract";
import { parse } from "smol-toml";
import { nodeLocalIo } from "../node-io.ts";
import { type PlainportPaths, resolvePaths } from "../paths.ts";
import { releaseWhenReady } from "../testing/barrier.ts";
import { childEnv } from "../testing/child-env.ts";
import { ConfigLoader } from "./load.ts";
import { updateManaged } from "./managed.ts";

const WRITER = join(import.meta.dir, "..", "testing", "managed-writer.ts");
const io = nodeLocalIo;

let sandbox: string;
let paths: PlainportPaths;
/** Every child a test starts; afterEach kills any still running, so a failed test leaves none behind. */
const children: Bun.Subprocess[] = [];

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "plainport-managed-"));
  const result = resolvePaths({ HOME: sandbox });
  if (!result.ok) throw new Error(result.finding.message);
  paths = result.value;
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const writer = (args: string[], env: Record<string, string> = {}) => {
  const child = Bun.spawn([process.execPath, WRITER, ...args], {
    env: childEnv(sandbox, env),
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return child;
};

const rootsIn = (path: string): string[] =>
  Object.keys((parse(readFileSync(path, "utf8")).roots ?? {}) as object).sort();

const managedDir = (): string => dirname(paths.managedFile);

describe("config: managed.toml writes", () => {
  test("creates managed.toml, with a header, that loads back", async () => {
    const result = await updateManaged(io, paths, (managed) =>
      ok({ ...managed, defaultStore: "mini", roots: { work: { label: "Work", on: { mbp: "~/work" } } } }),
    );
    if (!result.ok) throw new Error(result.finding.message);
    const text = readFileSync(paths.managedFile, "utf8");
    expect(text.startsWith("# Written by plainport.")).toBe(true);
    const loaded = await new ConfigLoader(io, paths).load({ env: {} });
    if (!loaded.ok) throw new Error(loaded.finding.message);
    expect(loaded.value.config.defaultStore).toBe("mini");
    expect(loaded.value.config.roots.work).toEqual({ label: "Work", on: { mbp: "~/work" } });
    expect(existsSync(paths.managedLock)).toBe(false);
  });

  test("an update can refuse: its finding comes back, nothing is written and the lock is released", async () => {
    write(paths.managedFile, '[roots.work]\nlabel = "Work"\n');
    const before = readFileSync(paths.managedFile, "utf8");
    let seen: unknown;
    const refusal = finding("usage.invalid", {
      message: "root work already exists",
      fix: "plainport root list",
    });
    const result = await updateManaged(io, paths, (managed) => {
      seen = managed.roots;
      return fail(refusal);
    });
    expect(seen).toEqual({ work: { label: "Work" } });
    expect(result).toEqual({ ok: false, exitCode: 2, finding: refusal });
    expect(readFileSync(paths.managedFile, "utf8")).toBe(before);
    expect(existsSync(paths.managedLock)).toBe(false);
  });

  test("an update that would make managed.toml invalid is refused and the file is left alone", async () => {
    write(paths.managedFile, 'defaultStore = "mini"\n');
    const before = readFileSync(paths.managedFile, "utf8");
    const result = await updateManaged(io, paths, (managed) =>
      ok({ ...managed, onload: { leases: "sometimes" as "warn" } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.finding.code).toBe("config.invalid");
    expect(readFileSync(paths.managedFile, "utf8")).toBe(before);
    expect(existsSync(paths.managedLock)).toBe(false);
  });

  test("a managed.toml that does not parse is never overwritten", async () => {
    write(paths.managedFile, "[roots\n");
    const result = await updateManaged(io, paths, (managed) => ok({ ...managed, defaultStore: "x" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.finding.code).toBe("config.invalid");
    expect(result.finding.paths).toEqual([paths.managedFile]);
    expect(readFileSync(paths.managedFile, "utf8")).toBe("[roots\n");
  });

  test("a lock held by another live process times out with config.locked (exit 11) naming the holder", async () => {
    const sleeper = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60_000)"]);
    children.push(sleeper);
    write(
      paths.managedLock,
      JSON.stringify({ pid: sleeper.pid, host: hostname(), startedAt: "2026-10-03T00:00:00Z" }),
    );
    const result = await updateManaged(io, paths, (managed) => ok({ ...managed, defaultStore: "x" }), {
      timeoutMs: 150,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.finding.code).toBe("config.locked");
    expect(result.exitCode).toBe(11);
    expect(result.finding.message).toContain(String(sleeper.pid));
    expect(result.finding.paths).toEqual([paths.managedLock]);
    expect(existsSync(paths.managedFile)).toBe(false);
    expect(existsSync(paths.managedLock)).toBe(true);
  });

  test("an exception in the update releases the lock", async () => {
    await expect(
      updateManaged(io, paths, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(paths.managedLock)).toBe(false);
  });

  test("concurrent updates within one process serialize too: no root is lost", async () => {
    const names = Array.from({ length: 20 }, (_, i) => `r${i}`);
    const results = await Promise.all(
      names.map((name) =>
        updateManaged(io, paths, (managed) =>
          ok({ ...managed, roots: { ...managed.roots, [name]: { label: name } } }),
        ),
      ),
    );
    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(rootsIn(paths.managedFile)).toEqual([...names].sort());
    expect(existsSync(paths.managedLock)).toBe(false);
  });

  test("a nested update in the same process times out with a message that says so, not 'delete the lock'", async () => {
    let inner: Awaited<ReturnType<typeof updateManaged>> | undefined;
    const outer = await updateManaged(io, paths, async (managed) => {
      inner = await updateManaged(io, paths, (m) => ok(m), { timeoutMs: 100 });
      return ok(managed);
    });
    expect(outer.ok).toBe(true);
    expect(inner?.ok).toBe(false);
    if (inner === undefined || inner.ok) return;
    expect(inner.finding.code).toBe("config.locked");
    expect(inner.finding.message).toContain("this process");
    expect(inner.finding.fix).not.toContain("delete");
  });

  test("concurrent writers in two processes serialize through the lock: no lost update", async () => {
    const log = join(sandbox, "critical.log");
    const barrier = join(sandbox, "barrier");
    mkdirSync(barrier);
    const count = 15;
    const env = { MANAGED_WRITER_LOG: log, BARRIER_DIR: barrier };
    const writers = [writer(["a", String(count)], env), writer(["b", String(count)], env)];
    await releaseWhenReady(barrier, ["a", "b"]);
    const codes = await Promise.all(writers.map((child) => child.exited));
    const errors = await Promise.all(writers.map((child) => new Response(child.stderr).text()));
    expect({ codes, errors }).toEqual({ codes: [0, 0], errors: ["", ""] });

    // No lost update: this is what proves the read-modify-write cycles were serialized.
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
    // The update callbacks, which run under the lock, never overlapped.
    const critical = lines.filter((line) => line.startsWith("+") || line.startsWith("-"));
    expect(critical).toHaveLength(4 * count);
    for (let i = 0; i < critical.length; i += 2) {
      const enter = critical[i] as string;
      expect(enter.startsWith("+")).toBe(true);
      expect(critical[i + 1]).toBe(`-${enter.slice(1)}`);
    }
    expect(existsSync(paths.managedLock)).toBe(false);
  }, 180_000);

  test("a crash between the temp write and the rename leaves the old file intact; the next write recovers", async () => {
    write(paths.managedFile, '# old\ndefaultStore = "old"\n');
    const child = writer(["crashed", "1", "crash-before-rename"]);
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");

    expect(readFileSync(paths.managedFile, "utf8")).toBe('# old\ndefaultStore = "old"\n');
    const temps = readdirSync(managedDir()).filter((name) => name.endsWith(".tmp"));
    expect(temps).toHaveLength(1);
    expect(readFileSync(join(managedDir(), temps[0] as string), "utf8")).toContain("crashed-0");
    expect(existsSync(paths.managedLock)).toBe(true);

    const loaded = await new ConfigLoader(io, paths).load({ env: {} });
    if (!loaded.ok) throw new Error(loaded.finding.message);
    expect(loaded.value.config.defaultStore).toBe("old");

    const next = await updateManaged(io, paths, (managed) => ok({ ...managed, defaultStore: "new" }), {
      timeoutMs: 5000,
    });
    if (!next.ok) throw new Error(next.finding.message);
    expect(parse(readFileSync(paths.managedFile, "utf8")).defaultStore).toBe("new");
    expect(rootsIn(paths.managedFile)).toEqual([]);
    expect(readdirSync(managedDir()).sort()).toEqual(["managed.toml"]);
  }, 60_000);
});
