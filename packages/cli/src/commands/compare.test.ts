// plainport compare's registry entry (M2 Task 26): its risk class, and `help compare` explaining the theirs refs.

import { describe, expect, test } from "bun:test";
import { capture } from "../testing.ts";
import { REGISTRY } from "./index.ts";

describe("compare", () => {
  test("is safe_write, and help compare lists the four leaves and the documented comparison", async () => {
    expect(REGISTRY.find((c) => c.name === "compare")?.risk).toBe("safe_write");
    const shown = await capture(["help", "compare"], REGISTRY);
    expect(shown.code).toBe(0);
    for (const leaf of ["HEAD", "heads/*", "index", "worktree"])
      expect(shown.out).toContain(`  refs/plainport/theirs/<snapshot>/${leaf}`);
    expect(shown.out).toContain("git diff HEAD refs/plainport/theirs/<snapshot>/worktree");
    expect(shown.out).toContain("--clean");
    const json = await capture(["help", "compare", "--json"], REGISTRY);
    const data = JSON.parse(json.out.trimEnd().split("\n").at(-1) ?? "").data;
    expect(data.commands[0].details).toHaveLength(3);
  });

  test("its human output names the device by its short id and lists what was left out (review M9, M6, M7)", () => {
    const command = REGISTRY.find((c) => c.name === "compare");
    if (command === undefined) throw new Error("compare is not registered");
    const device = "01JA0DEVICE0000000000000AB";
    const shown = (command.human as (data: unknown) => string)({
      op: "01JA0000000000000000000009",
      project: "work:web",
      dir: "/x/web",
      sets: [
        {
          snapshot: "01JA0000000000000000000001",
          device,
          at: "2026-10-02T10:00:00.000Z",
          refs: [],
          detached: false,
          branches: [],
          index: "a".repeat(40),
          worktree: "b".repeat(40),
          unmerged: [],
          submodules: [],
          nested: [],
          intentToAdd: ["planned.txt"],
          withheld: [".env.local"],
          ignored: [],
          ignoredTotal: 0,
          changed: true,
        },
      ],
      incomplete: [],
    });
    expect(shown).toContain("from device 01JA0DEVIC, ");
    expect(shown).not.toContain(device);
    expect(shown).toContain("intent-to-add, in worktree only: planned.txt");
    expect(shown).toContain("files that look like secrets, not committed: .env.local");
  });
});
