// The example home's own hygiene: cleanup() leaves nothing behind in $TMPDIR (M2 Task 3, the temp-folder leak).

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { REGISTRY } from "./commands/index.ts";
import { capture, exampleHome } from "./testing.ts";

test("exampleHome cleanup removes the whole folder, also after a command that touched the store", async () => {
  for (const argv of [["recover"], ["status"], ["offload", "work:clients/acme/web", "--yes"]]) {
    const home = await exampleHome();
    await capture([...argv, "--json"], REGISTRY, { ports: home.ports });
    home.cleanup();
    expect({ argv, left: existsSync(home.home) }).toEqual({ argv, left: false });
  }
});

test("exampleHome cleanup outlasts a writer that is delayed beyond a single look", async () => {
  const home = await exampleHome();
  // A detached child, like an offload's delete, that writes into the home 80 ms from now.
  Bun.spawn(["sh", "-c", `sleep 0.08; mkdir -p "${home.home}/late" && echo x > "${home.home}/late/f"`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  home.cleanup();
  await Bun.sleep(400);
  expect(existsSync(home.home)).toBe(false);
});

test("exampleHome removes its folder when its setup throws", async () => {
  const before = new Set(await Array.fromAsync(new Bun.Glob("plainport-example-*").scan({ cwd: tmp() })));
  await expect(
    exampleHome({
      afterCreate: () => {
        throw new Error("boom");
      },
    }),
  ).rejects.toThrow("boom");
  const after = await Array.fromAsync(new Bun.Glob("plainport-example-*").scan({ cwd: tmp() }));
  expect(after.filter((name) => !before.has(name))).toEqual([]);
});

function tmp(): string {
  return require("node:os").tmpdir();
}
