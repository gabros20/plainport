import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { PATH_REFUSED } from "../guard.ts";
import { testHost } from "./host.ts";

describe("testing: core's own guarded host", () => {
  test("refuses the real home and runs children through the runner", async () => {
    const host = testHost();
    await expect(host.fs.readText(join(userInfo().homedir, ".zshrc"))).rejects.toMatchObject({
      code: PATH_REFUSED,
    });
    const dir = mkdtempSync(join(tmpdir(), "plainport-core-host-"));
    try {
      const ran = await host.run({
        command: "/bin/echo",
        args: ["hi"],
        cwd: dir,
        env: {},
        capture: { maxBytes: 1024 },
      });
      expect(ran.ok && new TextDecoder().decode(ran.value.captured)).toBe("hi\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
