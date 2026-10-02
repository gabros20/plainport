import { describe, expect, test } from "bun:test";
import { mergeLayers } from "./merge.ts";

describe("config: merge rules", () => {
  test("tables merge key by key, at every depth", () => {
    const merged = mergeLayers([
      { onload: { hydrate: true, leases: "warn" }, roots: { work: { on: { mbp: "~/work" } } } },
      { onload: { leases: "strict" }, roots: { work: { on: { mini: "~/Developer/Work" } } } },
    ]);
    expect(merged).toEqual({
      onload: { hydrate: true, leases: "strict" },
      roots: { work: { on: { mbp: "~/work", mini: "~/Developer/Work" } } },
    });
  });

  test("arrays replace, never concatenate", () => {
    const merged = mergeLayers([
      { strip: { extra: ["**/coverage", "**/.cache"], never: [".vercel/project.json"] } },
      { strip: { extra: ["public/generated/**"] } },
    ]);
    expect(merged).toEqual({ strip: { extra: ["public/generated/**"], never: [".vercel/project.json"] } });
  });

  test("an empty array still replaces", () => {
    expect(mergeLayers([{ strip: { extra: ["a"] } }, { strip: { extra: [] } }])).toEqual({
      strip: { extra: [] },
    });
  });

  test("a later scalar replaces a table and a later table replaces a scalar", () => {
    expect(mergeLayers([{ a: { b: 1 } }, { a: 2 }])).toEqual({ a: 2 });
    expect(mergeLayers([{ a: 2 }, { a: { b: 1 } }])).toEqual({ a: { b: 1 } });
  });

  test("an undefined value leaves the lower layer's value in place", () => {
    expect(mergeLayers([{ defaultStore: "mini" }, { defaultStore: undefined }])).toEqual({
      defaultStore: "mini",
    });
  });

  test("layers are not mutated, and the result shares no tables or arrays with them", () => {
    const low = { strip: { extra: ["a"] }, roots: { work: { label: "Work" } } };
    const high = { roots: { work: { store: "mini" } } };
    const merged = mergeLayers([low, high]) as typeof low & typeof high;
    expect(low).toEqual({ strip: { extra: ["a"] }, roots: { work: { label: "Work" } } });
    expect(high).toEqual({ roots: { work: { store: "mini" } } });
    merged.strip.extra.push("b");
    expect(low.strip.extra).toEqual(["a"]);
  });

  test("__proto__ keys from a file are data, not a prototype change", () => {
    const evil = JSON.parse('{"__proto__": {"polluted": true}}');
    const merged = mergeLayers([{}, evil]) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(merged, "__proto__")).toBe(true);
  });
});
