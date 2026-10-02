// Configuration: paths come from ../paths.ts; this folder loads, merges and writes config files. Only what other
// packages and tasks need is exported; the helpers stay internal.

export { configJsonSchemas } from "./json-schema.ts";
export { ConfigLoader, envLayer, type LoadedConfig, type LoadOptions, PROJECT_FILE } from "./load.ts";
export { MANAGED_HEADER, type ManagedOptions, type ManagedUpdate, updateManaged } from "./managed.ts";
export {
  type ConfigLayer,
  ConfigLayerSchema,
  DEFAULTS,
  DurationSchema,
  type ProjectConfig,
  ProjectConfigSchema,
  type ResolvedConfig,
  ResolvedConfigSchema,
  type Role,
  RoleSchema,
  SecretRefSchema,
  type Store,
  StoreSchema,
} from "./schema.ts";
