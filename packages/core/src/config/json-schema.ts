// JSON Schemas for the files plainport reads, published in schemas/ by `bun run contract`: editors can check
// config.toml, managed.toml and .plainport.toml against them (each file may set any subset of keys, since tables
// merge), and other tools can read device.json, registry.json and .plainport stubs.

import { z } from "zod";
import { DeviceSchema } from "../device.ts";
import { ProjectRegistrySchema } from "../registry.ts";
import { StubSchema } from "../stub.ts";
import { ConfigLayerSchema, ProjectConfigSchema } from "./schema.ts";

export const configJsonSchemas = (): Record<
  "config" | "project-config" | "device" | "registry" | "stub",
  Record<string, unknown>
> => {
  const schema = (s: z.ZodType) =>
    z.toJSONSchema(s, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
  return {
    config: schema(ConfigLayerSchema.meta({ title: "Config", description: "config.toml and managed.toml" })),
    "project-config": schema(
      ProjectConfigSchema.meta({ title: "ProjectConfig", description: "A project's .plainport.toml" }),
    ),
    device: schema(DeviceSchema),
    registry: schema(ProjectRegistrySchema),
    stub: schema(StubSchema),
  };
};
