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

  test("device.json needs a ULID and a role", () => {
    const check = ajv.compile(schemas.device);
    const device = {
      v: 1,
      id: "01ARYZ6S410000000000000000",
      role: "owner",
      createdAt: "2026-10-03T12:00:00.000Z",
    };
    expect(check(device)).toBe(true);
    expect(check({ ...device, id: "nope" })).toBe(false);
    expect(check({ ...device, role: "admin" })).toBe(false);
  });
});
