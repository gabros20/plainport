// The example home's own hygiene: cleanup() leaves nothing behind in $TMPDIR (M2 Task 3, the temp-folder leak).

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY } from "./commands/index.ts";
import { capture, exampleHome } from "./testing.ts";

test("exampleHome cleanup removes the whole folder, also after a command that touched the store", async () => {
  for (const argv of [["recover"], ["status"], ["offload", "work:clients/acme/web", "--yes"]]) {
    const home = await exampleHome();
    await capture([...argv, "--json"], REGISTRY, { ports: home.ports });
    await home.cleanup();
    expect({ argv, left: existsSync(home.home) }).toEqual({ argv, left: false });
  }
});

test("exampleHome cleanup outlasts a writer that is delayed beyond a single look", async () => {
  const home = await exampleHome();
  const gate = mkdtempSync(join(tmpdir(), "plainport-gate-writer-"));
  try {
    const marker = join(gate, "go");
    // A detached child, like an offload's delete: once the marker appears it waits 80 ms, then writes into the home.
    const child = Bun.spawn(
      [
        "sh",
        "-c",
        `while [ ! -e "${marker}" ]; do sleep 0.01; done; sleep 0.08; mkdir -p "${home.home}/late" && echo x > "${home.home}/late/f"`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    writeFileSync(marker, "");
    await home.cleanup();
    await child.exited;
    expect(existsSync(home.home)).toBe(false);
  } finally {
    rmSync(gate, { recursive: true, force: true });
  }
});

test("exampleHome removes its folder when its setup throws", async () => {
  let made = "";
  await expect(
    exampleHome({
      afterCreate: (home) => {
        made = home;
        throw new Error("boom");
      },
    }),
  ).rejects.toThrow("boom");
  expect(made).not.toBe("");
  expect(existsSync(made)).toBe(false);
});
