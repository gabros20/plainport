// settledOffload: a test that captures the sandbox after an offload starts only once the detached delete is done,
// including its last step, the removal of the emptied trash holder (trash-delete.ts).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, type Sandbox } from "./sandbox.ts";
import { settledOffload } from "./settle.ts";

const OP = "01K8ZQ0000000000000000000A";
let box: Sandbox;
beforeEach(() => {
  box = makeSandbox("plainport-settle-");
});
afterEach(() => box.cleanup());

// The delete removes the trash, its claim and its journal, then the holder. Waiting for the first three only let
// onload's dry-run preview see `.plainport-trash` vanish under it on Linux (CI run 40956615672).
test("waits for the emptied trash holder to go, the delete's last step", async () => {
  const holder = box.dir("work/.plainport-trash");
  setTimeout(() => rmdirSync(holder), 100);
  await settledOffload(box.paths, { op: OP, trash: join(holder, OP) });
  expect(existsSync(holder)).toBe(false);
});

test("a holder that still holds another trash stays, and is not waited for", async () => {
  const holder = box.dir("work/.plainport-trash");
  box.dir(`work/.plainport-trash/${OP.replace(/A$/, "B")}`);
  const started = performance.now();
  await settledOffload(box.paths, { op: OP, trash: join(holder, OP) });
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(existsSync(holder)).toBe(true);
});
