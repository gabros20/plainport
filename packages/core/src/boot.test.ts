// Whether something recorded earlier is from this host's current boot (Q5 i): by the boot session when both sides
// have one, by M1's clock rules otherwise. The trash claim and the lock's "since this boot" test (D63) share it.

import { describe, expect, test } from "bun:test";
import { fromThisBoot, readBootSession, SAME_BOOT_MS } from "./boot.ts";
import { testHost } from "./testing/host.ts";

const booted = 1_800_000_000_000;
const proc = { ...testHost().proc, bootedAtMs: () => booted };

describe("this host's boot session (Q5 i)", () => {
  test("reads as the same id every time, and the host port caches it", async () => {
    const host = testHost();
    const first = await readBootSession(host, process.platform);
    expect(first).toMatch(/^[0-9A-Fa-f-]{16,64}$/);
    expect(await readBootSession(host, process.platform)).toBe(first as string);
    expect(await host.bootSession()).toBe(first as string);
  });

  test("a platform without one, or a source that does not answer, has none", async () => {
    const host = testHost();
    expect(await readBootSession(host, "win32")).toBeUndefined();
    const silent = {
      ...host,
      run: async () => ({ ok: false as const, finding: { code: "x", message: "" } }),
    };
    expect(await readBootSession(silent as never, "darwin")).toBeUndefined();
    const unreadable = {
      ...host,
      fs: {
        ...host.fs,
        readText: async () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      },
    };
    expect(await readBootSession(unreadable, "linux")).toBeUndefined();
  });
});

describe("fromThisBoot", () => {
  test("a stepped clock with the same boot session is this boot", () => {
    for (const step of [-86_400_000, -SAME_BOOT_MS - 1, SAME_BOOT_MS + 1, 86_400_000])
      expect(fromThisBoot(proc, { bootedAt: booted + step, session: "S" }, "S")).toBe(true);
    expect(fromThisBoot(proc, { startedAt: booted - 3_600_000, session: "S" }, "S")).toBe(true);
  });

  test("another boot session is another boot, even when the clock agrees", () => {
    expect(fromThisBoot(proc, { bootedAt: booted, session: "S" }, "T")).toBe(false);
    expect(fromThisBoot(proc, { startedAt: booted + 1, session: "S" }, "T")).toBe(false);
  });

  test("without a session on either side, M1's rules: boot times within 120 s, or started since the boot", () => {
    for (const [recorded, now] of [
      ["S", undefined],
      [undefined, "S"],
      [undefined, undefined],
    ] as const) {
      const mark = recorded === undefined ? {} : { session: recorded };
      expect(fromThisBoot(proc, { ...mark, bootedAt: booted + SAME_BOOT_MS }, now)).toBe(true);
      expect(fromThisBoot(proc, { ...mark, bootedAt: booted - SAME_BOOT_MS - 1 }, now)).toBe(false);
      expect(fromThisBoot(proc, { ...mark, startedAt: booted }, now)).toBe(true);
      expect(fromThisBoot(proc, { ...mark, startedAt: booted - 1 }, now)).toBe(false);
      expect(fromThisBoot(proc, { ...mark, startedAt: Number.NaN }, now)).toBe(false);
    }
  });
});
