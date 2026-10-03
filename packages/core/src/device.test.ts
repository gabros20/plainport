import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deviceNameFrom, ensureDevice, readDevice } from "./device.ts";
import type { LocalIo } from "./io.ts";
import { nodeLocalIo } from "./node-io.ts";
import { type PlainportPaths, resolvePaths } from "./paths.ts";
import { releaseWhenReady } from "./testing/barrier.ts";
import { childEnv } from "./testing/child-env.ts";
import { isUlid } from "./ulid.ts";

const ENSURER = join(import.meta.dir, "testing", "device-ensurer.ts");
const io = nodeLocalIo;

let sandbox: string;
let paths: PlainportPaths;
const clock = { now: () => new Date("2026-10-03T12:00:00.000Z") };

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "plainport-device-"));
  const result = resolvePaths({ HOME: sandbox });
  if (!result.ok) throw new Error(result.finding.message);
  paths = result.value;
});

/** Every child a test starts; afterEach kills any still running, so a failed test leaves none behind. */
const spawned: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const child of spawned.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

describe("config: device identity", () => {
  test("no device.json yet reads as undefined", async () => {
    expect(await readDevice(io, paths)).toEqual({ ok: true, value: undefined });
  });

  test("ensureDevice creates device.json with a ULID, the role and the creation time", async () => {
    const result = await ensureDevice(io, paths, { role: "owner", name: "mbp", clock });
    if (!result.ok) throw new Error(result.finding.message);
    expect(result.value.created).toBe(true);
    const { device } = result.value;
    expect(isUlid(device.id)).toBe(true);
    expect(device).toEqual({
      v: 1,
      id: device.id,
      name: "mbp",
      role: "owner",
      createdAt: "2026-10-03T12:00:00.000Z",
    });
    expect(JSON.parse(readFileSync(paths.deviceFile, "utf8"))).toEqual(device);
    expect(await readDevice(io, paths)).toEqual({ ok: true, value: device });
    expect(readdirSync(paths.stateDir)).toEqual(["device.json"]);
  });

  test("an existing identity is kept: same id, same role, never rewritten", async () => {
    const first = await ensureDevice(io, paths, { role: "worker", name: "mbp", clock });
    if (!first.ok) throw new Error(first.finding.message);
    const text = readFileSync(paths.deviceFile, "utf8");
    const again = await ensureDevice(io, paths, { role: "owner", name: "mbp", clock });
    if (!again.ok) throw new Error(again.finding.message);
    expect(again.value).toEqual({ device: first.value.device, created: false });
    expect(again.value.device.role).toBe("worker");
    expect(readFileSync(paths.deviceFile, "utf8")).toBe(text);
  });

  test("processes creating the identity at the same moment end up with one id", async () => {
    const barrier = join(sandbox, "barrier");
    mkdirSync(barrier);
    const names = ["a", "b", "c", "d"];
    const children = names.map((name) =>
      Bun.spawn([process.execPath, ENSURER, name], {
        env: childEnv(sandbox, { BARRIER_DIR: barrier }),
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    spawned.push(...children);
    await releaseWhenReady(barrier, names);
    const codes = await Promise.all(children.map((child) => child.exited));
    const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()));
    expect({ codes, errors }).toEqual({ codes: [0, 0, 0, 0], errors: ["", "", "", ""] });
    const lines = await Promise.all(
      children.map(async (child) => (await new Response(child.stdout).text()).trim().split(" ")),
    );
    expect(new Set(lines.map(([id]) => id)).size).toBe(1);
    expect(lines.filter(([, created]) => created === "true")).toHaveLength(1);
    expect(JSON.parse(readFileSync(paths.deviceFile, "utf8")).id).toBe(lines[0]?.[0]);
    expect(readdirSync(paths.stateDir)).toEqual(["device.json"]);
  }, 180_000);

  test("losing the create race returns the winner's identity", async () => {
    // Deterministic version of the race: another process creates device.json between our read and our create.
    const winner = {
      v: 1,
      id: "01ARYZ6S410000000000000000",
      name: "mini",
      role: "worker",
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    const racing: LocalIo = {
      ...io,
      fs: {
        ...io.fs,
        link: async (from, to) => {
          writeFileSync(to, JSON.stringify(winner));
          await io.fs.link(from, to);
        },
      },
    };
    const result = await ensureDevice(racing, paths, { role: "owner", name: "mbp", clock });
    expect(result).toEqual({ ok: true, value: { device: winner as never, created: false } });
    expect(readdirSync(paths.stateDir)).toEqual(["device.json"]);
  });

  test("the device name is a lower-case word; a bad one is refused before anything is written", async () => {
    const result = await ensureDevice(io, paths, { role: "owner", name: "My Mac", clock });
    expect(result).toMatchObject({ ok: false, exitCode: 2, finding: { code: "usage.invalid" } });
    expect(await readDevice(io, paths)).toEqual({ ok: true, value: undefined });
  });

  test("deviceNameFrom turns a host name into a device name", () => {
    expect(deviceNameFrom("Tamass-MacBook-Pro.local")).toBe("tamass-macbook-pro");
    expect(deviceNameFrom("vps_01.example.eu")).toBe("vps-01");
    expect(deviceNameFrom("...")).toBe("this-device");
  });

  test("a damaged device.json is reported, never replaced", async () => {
    mkdirSync(dirname(paths.deviceFile), { recursive: true });
    for (const text of [
      "{not json",
      JSON.stringify({ v: 1, id: "nope", name: "mbp", role: "owner", createdAt: "x" }),
    ]) {
      writeFileSync(paths.deviceFile, text);
      for (const result of [
        await readDevice(io, paths),
        await ensureDevice(io, paths, { role: "owner", name: "mbp", clock }),
      ]) {
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.finding.code).toBe("device.invalid");
        expect(result.exitCode).toBe(6);
        expect(result.finding.paths).toEqual([paths.deviceFile]);
        expect(result.finding.fix).toBeDefined();
      }
      expect(readFileSync(paths.deviceFile, "utf8")).toBe(text);
    }
  });
});
