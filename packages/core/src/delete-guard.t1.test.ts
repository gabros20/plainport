// D87 (a) with a real mount: a small disk image mounted below a trash folder (astra r2 finding 2's mount-below case)
// is refused by the guard before anything is deleted, so neither the mounted volume's files nor the trash go.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachImage, type DiskImage } from "../../../test/disk-image.ts";
import { describeT1 } from "../../../test/tiers.ts";
import { deleteGuard } from "./delete-guard.ts";
import { ensureDevice } from "./device.ts";
import { testHost } from "./testing/host.ts";
import { makeSandbox, type Sandbox } from "./testing/sandbox.ts";

if (process.platform === "darwin") {
  describeT1("delete guard with a disk image mounted below the trash (D87)", () => {
    let box: Sandbox;
    let image: DiskImage | undefined;
    let trash: string;
    beforeAll(async () => {
      box = makeSandbox("plainport-guard-mount-");
      box.file(".config/plainport/config.toml", 'version = 1\n[roots.work]\non = { mbp = "~/work" }\n');
      const made = await ensureDevice(testHost(), box.paths, { role: "owner", name: "mbp" });
      if (!made.ok) throw new Error(made.finding.message);
      trash = box.dir("work/.plainport-trash/01ARYZ6S430000000000000000");
      box.file("work/.plainport-trash/01ARYZ6S430000000000000000/web/src/main.ts", "x");
      // Mounted at <trash>/web/.next/mnt: a volume below the tree, as a bind-mounted store would be.
      image = await attachImage(join(trash, "web/.next"), { size: "4m", fs: "HFS+", volname: "PPGUARD" });
      writeFileSync(join(image.mount, "repository-bytes"), "only copy");
    }, 180_000);
    afterAll(async () => {
      try {
        await image?.remove();
      } finally {
        box.cleanup();
      }
    }, 180_000);

    test("a folder on another device below the tree refuses, and the volume's files stay", async () => {
      const result = await deleteGuard({ io: testHost(), paths: box.paths, env: { HOME: box.home } }, trash);
      expect(result.ok ? "allowed" : result.finding.message).toContain("is a mount point");
      expect(existsSync(join(image?.mount ?? "", "repository-bytes"))).toBe(true);
      expect(existsSync(join(trash, "web/src/main.ts"))).toBe(true);
    });
  });
}
