// blob-fs on a real exFAT volume (D41): external SSDs often come formatted exFAT, which has no hard links, so
// create-only falls back to an exclusive open. macOS only: a small disk image made with hdiutil, mounted for the
// suite, then detached and deleted.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { link, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachImage, type DiskImage } from "../../../test/disk-image.ts";
import { describeT1 } from "../../../test/tiers.ts";
import { blobStoreContract } from "../../core/src/testing/blob-store-contract.ts";
import { testHost } from "../../core/src/testing/host.ts";
import { fsBlobStore } from "./index.ts";

if (process.platform === "darwin") {
  describeT1("blob-fs on an exFAT disk image", () => {
    let work: string;
    let image: DiskImage | undefined;
    let mount: string;
    let next = 0;
    // hdiutil is slow on a loaded machine and shares diskarbitrationd with every other image: the shared helper
    // serializes and retries it, and these hooks get time for that instead of the 5 s default.
    beforeAll(async () => {
      work = mkdtempSync(join(tmpdir(), "plainport-exfat-"));
      image = await attachImage(work, { size: "8m", fs: "ExFAT", volname: "PPEXFAT" });
      mount = image.mount;
    }, 180_000);
    afterAll(async () => {
      try {
        await image?.remove();
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }, 180_000);

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
