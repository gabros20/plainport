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

test("exampleHome cleanup removes the folder when the home's setup fails", async () => {
  const before = new Set(await Array.fromAsync(new Bun.Glob("plainport-example-*").scan({ cwd: tmp() })));
  await expect(exampleHome({ failSetup: true })).rejects.toThrow();
  const after = await Array.fromAsync(new Bun.Glob("plainport-example-*").scan({ cwd: tmp() }));
  expect(after.filter((name) => !before.has(name))).toEqual([]);
});

function tmp(): string {
  return require("node:os").tmpdir();
}
