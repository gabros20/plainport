// blob-fs on a real exFAT volume (D41): external SSDs often come formatted exFAT, which has no hard links, so
// create-only falls back to an exclusive open. macOS only: a small disk image made with hdiutil, mounted for the
// suite, then detached and deleted.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { link, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeT1 } from "../../../test/tiers.ts";
import { blobStoreContract } from "../../core/src/testing/blob-store-contract.ts";
import { testHost } from "../../core/src/testing/host.ts";
import { fsBlobStore } from "./index.ts";

const hdiutil = (...args: string[]): void => {
  const run = Bun.spawnSync(["hdiutil", ...args], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`hdiutil ${args.join(" ")}: ${run.stderr.toString()}`);
};

if (process.platform === "darwin") {
  describeT1("blob-fs on an exFAT disk image", () => {
    let work: string;
    let mount: string;
    let next = 0;
    beforeAll(() => {
      work = mkdtempSync(join(tmpdir(), "plainport-exfat-"));
      mount = join(work, "mnt");
      hdiutil("create", "-size", "8m", "-fs", "ExFAT", "-volname", "PPEXFAT", join(work, "exfat.dmg"));
      hdiutil("attach", "-nobrowse", "-mountpoint", mount, join(work, "exfat.dmg"));
    });
    afterAll(() => {
      try {
        hdiutil("detach", mount, "-force");
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });

    test("the volume really has no hard links, so the fallback is what runs", async () => {
      await writeFile(join(mount, "probe"), "x");
      await expect(link(join(mount, "probe"), join(mount, "probe2"))).rejects.toMatchObject({
        code: expect.stringMatching(/^(EPERM|ENOTSUP|EOPNOTSUPP)$/),
      });
    });

    blobStoreContract("exFAT", () => {
      const dir = join(mount, `store-${next++}`);
      mkdirSync(dir);
      return {
        store: fsBlobStore(testHost(), dir),
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
      };
    });
  });
}
