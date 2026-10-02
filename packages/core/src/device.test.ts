import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { childEnv } from "./config/testing/child-env.ts";
import { ensureDevice, readDevice } from "./device.ts";
import { type PlainportPaths, resolvePaths } from "./paths.ts";
import { isUlid } from "./ulid.ts";

let sandbox: string;
let paths: PlainportPaths;
const clock = { now: () => new Date("2026-10-03T12:00:00.000Z") };

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "plainport-device-"));
  const result = resolvePaths({ HOME: sandbox });
  if (!result.ok) throw new Error(result.finding.message);
  paths = result.value;
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("config: device identity", () => {
  test("no device.json yet reads as undefined", () => {
    expect(readDevice(paths)).toEqual({ ok: true, value: undefined });
  });

  test("ensureDevice creates device.json with a ULID, the role and the creation time", () => {
    const result = ensureDevice(paths, { role: "owner", clock });
    if (!result.ok) throw new Error(result.finding.message);
    expect(result.value.created).toBe(true);
    const { device } = result.value;
    expect(isUlid(device.id)).toBe(true);
    expect(device).toEqual({ v: 1, id: device.id, role: "owner", createdAt: "2026-10-03T12:00:00.000Z" });
    expect(JSON.parse(readFileSync(paths.deviceFile, "utf8"))).toEqual(device);
    expect(readDevice(paths)).toEqual({ ok: true, value: device });
    expect(readdirSync(paths.stateDir)).toEqual(["device.json"]);
  });

  test("an existing identity is kept: same id, same role, never rewritten", () => {
    const first = ensureDevice(paths, { role: "worker", clock });
    if (!first.ok) throw new Error(first.finding.message);
    const text = readFileSync(paths.deviceFile, "utf8");
    const again = ensureDevice(paths, { role: "owner", clock });
    if (!again.ok) throw new Error(again.finding.message);
    expect(again.value).toEqual({ device: first.value.device, created: false });
    expect(again.value.device.role).toBe("worker");
    expect(readFileSync(paths.deviceFile, "utf8")).toBe(text);
  });

  test("two processes creating the identity at once end up with one id", async () => {
    const script = join(sandbox, "ensure.ts");
    writeFileSync(
      script,
      [
        `import { ensureDevice } from ${JSON.stringify(join(import.meta.dir, "device.ts"))};`,
        `import { resolvePaths } from ${JSON.stringify(join(import.meta.dir, "paths.ts"))};`,
        "const paths = resolvePaths(process.env);",
        "if (!paths.ok) process.exit(2);",
        'const result = ensureDevice(paths.value, { role: "owner" });',
        "if (!result.ok) process.exit(result.exitCode);",
        "console.log(result.value.device.id);",
      ].join("\n"),
    );
    const children = Array.from({ length: 4 }, () =>
      Bun.spawn([process.execPath, script], { env: childEnv(sandbox), stdout: "pipe" }),
    );
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0, 0, 0]);
    const ids = await Promise.all(
      children.map(async (child) => (await new Response(child.stdout).text()).trim()),
    );
    expect(new Set(ids).size).toBe(1);
    expect(JSON.parse(readFileSync(paths.deviceFile, "utf8")).id).toBe(ids[0]);
    expect(readdirSync(paths.stateDir)).toEqual(["device.json"]);
  }, 30_000);

  test("a damaged device.json is reported, never replaced", () => {
    mkdirSync(dirname(paths.deviceFile), { recursive: true });
    for (const text of ["{not json", JSON.stringify({ v: 1, id: "nope", role: "owner", createdAt: "x" })]) {
      writeFileSync(paths.deviceFile, text);
      for (const result of [readDevice(paths), ensureDevice(paths, { role: "owner", clock })]) {
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
