import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail, finding } from "@plainport/contract";
import { nodeLocalIo } from "../node-io.ts";
import type { HostPorts } from "../ports/host.ts";
import { gitignoredFiles } from "./gitignored.ts";

describe("plan: the gitignored files, when git cannot be asked (quality r1 minor 5)", () => {
  test("a git call that fails marks the list incomplete instead of dropping its files silently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plainport-gitignored-"));
    try {
      mkdirSync(join(dir, ".git"));
      const host = {
        ...nodeLocalIo,
        run: async () => fail(finding("process.spawn-failed", { message: "git could not be started" })),
      } as unknown as HostPorts;
      expect(await gitignoredFiles(host, dir, { env: {} }, [""], [".env", "src/a.ts"])).toEqual({
        paths: [],
        incomplete: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
