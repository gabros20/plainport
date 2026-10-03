import { describe, expect, test } from "bun:test";
import { ProjectRegistrySchema } from "../registry.ts";
import { ulid } from "../ulid.ts";
import { type CatalogEvent, foldCatalog, resolveRootId } from "./index.ts";

const idAt = (ms: number) => ulid(ms, (b) => b);
const [DEVICE, FIRST, SECOND, RECORDED] = [idAt(3), idAt(10), idAt(11), idAt(12)];

const created = (id: string, root: string, key: string): CatalogEvent => ({
  v: 1,
  id,
  type: "root-created",
  device: DEVICE,
  at: "2026-10-03T12:00:00.000Z",
  op: id,
  root,
  key,
});

describe("catalog: a root key's ULID", () => {
  test("registry.json records this device's root ULIDs by key, beside its projects", () => {
    const registry = { v: 1, projects: {}, roots: { work: RECORDED } };
    expect(ProjectRegistrySchema.safeParse(registry).success).toBe(true);
    expect(ProjectRegistrySchema.safeParse({ v: 1, projects: {} }).success).toBe(true);
    expect(ProjectRegistrySchema.safeParse({ ...registry, roots: { work: "nope" } }).success).toBe(false);
    expect(ProjectRegistrySchema.safeParse({ ...registry, roots: { Work: RECORDED } }).success).toBe(false);
  });

  test("the registry's record wins; else the catalog's first root-created for the key; else none", () => {
    const state = foldCatalog([created(idAt(101), SECOND, "work"), created(idAt(100), FIRST, "work")]);
    const empty = { v: 1 as const, projects: {} };
    expect(resolveRootId({ ...empty, roots: { work: RECORDED } }, state, "work")).toEqual({
      id: RECORDED,
      source: "registry",
    });
    expect(resolveRootId(empty, state, "work")).toEqual({ id: FIRST, source: "catalog" });
    expect(resolveRootId(empty, state, "personal")).toBeUndefined();
  });
});
