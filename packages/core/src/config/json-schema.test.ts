import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { configJsonSchemas } from "./json-schema.ts";

const ajv = new Ajv2020({ strict: false, allErrors: true });

describe("config: published JSON Schemas", () => {
  const schemas = configJsonSchemas();

  test("config.json accepts a partial layer and refuses an unknown key, as the loader does", () => {
    const check = ajv.compile(schemas.config);
    expect(
      check({ defaultStore: "mini", stores: { ssd: { path: "/Volumes/B" } }, onload: { leases: "strict" } }),
    ).toBe(true);
    expect(check({ onload: { hydrat: false } })).toBe(false);
    expect(check({ stores: { b2: { kind: "s3", secret: "hunter2" } } })).toBe(false);
  });

  test("project-config.json allows only project settings", () => {
    const check = ajv.compile(schemas["project-config"]);
    expect(check({ deps: { mode: "keep" }, hooks: { "pre-offload": ["docker compose down"] } })).toBe(true);
    expect(check({ defaultStore: "mini" })).toBe(false);
  });

  test("manifest-entry.json describes one scan manifest entry, as the scan writes it", () => {
    const check = ajv.compile(schemas["manifest-entry"]);
    const entry = {
      path: "src/a.ts",
      type: "file",
      size: 3,
      mode: 420,
      mtime: "2026-10-03T01:36:47.319437918Z",
    };
    expect(check(entry)).toBe(true);
    expect(check({ path: "l", type: "symlink", mode: 493, mtime: entry.mtime, linkTarget: "a" })).toBe(true);
    expect(check({ ...entry, type: "fifo" })).toBe(false);
    expect(check({ ...entry, path: "" })).toBe(false);
  });

  test("device.json needs a ULID, a name and a role", () => {
    const check = ajv.compile(schemas.device);
    const device = {
      v: 1,
      id: "01ARYZ6S410000000000000000",
      name: "mbp",
      role: "owner",
      createdAt: "2026-10-03T12:00:00.000Z",
    };
    expect(check(device)).toBe(true);
    expect(check({ ...device, id: "nope" })).toBe(false);
    expect(check({ ...device, role: "admin" })).toBe(false);
    expect(check({ ...device, name: "My Mac" })).toBe(false);
  });

  test("registry.json maps project ULIDs to a root and a relative path", () => {
    const check = ajv.compile(schemas.registry);
    const entry = { root: "work", path: "clients/acme/web", registeredAt: "2026-10-03T12:00:00.000Z" };
    expect(check({ v: 1, projects: { "01ARYZ6S410000000000000000": entry } })).toBe(true);
    expect(check({ v: 1, projects: { nope: entry } })).toBe(false);
    expect(check({ v: 1, projects: { "01ARYZ6S410000000000000000": { ...entry, path: "a/../x" } } })).toBe(
      false,
    );
    expect(check({ v: 1, projects: { "01ARYZ6S410000000000000000": { ...entry, path: "/abs" } } })).toBe(
      false,
    );
  });

  test("stub.json describes a .plainport stub", () => {
    const check = ajv.compile(schemas.stub);
    expect(
      check({
        plainport: 1,
        project: "01J8A2C4E6G8J0K2M4P6R8T0VW",
        root: "work",
        rootId: "01J6RT7W2K9M4N6P8Q0S2V4X6Z",
        path: "clients/acme/web",
        store: "mini",
        snapshot: "01J9Z6K2B8D4F6H8K0M2P4R6T8",
        offloadedAt: "2026-09-29T14:02:11Z",
        bytes: 1934000000,
        restore: "plainport onload work:clients/acme/web",
      }),
    ).toBe(true);
    expect(check({ plainport: 1 })).toBe(false);
  });
});
