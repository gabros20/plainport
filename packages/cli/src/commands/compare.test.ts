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
});
