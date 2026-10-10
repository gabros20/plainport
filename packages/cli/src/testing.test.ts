// The example home's own hygiene: cleanup() leaves nothing behind in $TMPDIR (M2 Task 3, the temp-folder leak).

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
    const wrote = join(gate, "wrote");
    // A detached child, like an offload's delete. It is gated on the cleanup's first removal, not on the clock: it
    // waits until the home is gone, then writes into it again and leaves a marker. (Bounded: 20 s of polling.)
    const child = Bun.spawn(
      [
        "sh",
        "-c",
        `n=0; while [ -e "${home.home}" ] && [ $n -lt 2000 ]; do n=$((n+1)); sleep 0.01; done; ` +
          `mkdir -p "${home.home}/late" && echo x > "${home.home}/late/f" && : > "${wrote}"`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    // A settle window far wider than the writer's poll, so a slow runner cannot end the wait before the write.
    await home.cleanup(3000);
    await child.exited;
    expect(existsSync(wrote)).toBe(true);
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
